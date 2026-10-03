/**
 * Aharos desktop — Electron main process.
 *
 * Owns windows, the local data directory, child processes, backups and hardware.
 * Contains NO business logic: orders, payments, inventory, RBAC etc. all stay in
 * the unchanged Next.js server, which the app window talks to over loopback HTTP.
 * See docs/desktop-architecture.md.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SESSION_COOKIE } from "@/constants/auth";
import { dataPaths, ensureDirs, loadOrCreateConfig, readSecret, saveConfig, type DataPaths, type DesktopConfig, type SecretCodec } from "./config";
import { createLogger, type Logger } from "./log";
import { appOrigin, childEnv, isAllowedRendererRequest, isAppUrl, validatePrinterName, validateSetupInput } from "./policy";
import { AharosServer, anyFreePort, DbTool, DbToolError, portFree } from "./processes";
import { listPrinters, MockPrinterDriver, SystemPrinterDriver, testPage, type PrinterDriver } from "./hardware";
import { sqliteUrl } from "../runtime/backup";

const T0 = Date.now();
const AUTO_BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;

// ---------------- process-level setup (before ready) ----------------

// Tests and multi-install setups may point the app at another data directory.
const dataRoot = process.env.AHAROS_DATA_DIR ? path.resolve(process.env.AHAROS_DATA_DIR) : path.join(app.getPath("appData"), "Aharos");
app.setPath("userData", dataRoot);
app.setAppUserModelId("com.aharos.desktop");
app.enableSandbox(); // every renderer is sandboxed, whatever its webPreferences say
// The server listens on 127.0.0.1 only. Without this, Chromium tries [::1] first for
// "localhost", where another local process could listen and receive the app's traffic.
app.commandLine.appendSwitch("host-resolver-rules", "MAP localhost 127.0.0.1");

const serverDir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "..", "server");
const staticDir = path.join(__dirname, "static");
const iconPath = path.join(staticDir, "icon.png");

let paths: DataPaths;
let log: Logger;
let config: DesktopConfig;
let server: AharosServer | null = null;
let mainWindow: BrowserWindow | null = null;
let splash: BrowserWindow | null = null;
let origin = "";
let quitting = false;
const timings: Record<string, number> = {};
const mark = (k: string) => (timings[k] = Date.now() - T0);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = mainWindow ?? splash;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(boot).catch((e) => fatal("Aharos could not start", e));
}

// ---------------- security: every webContents ----------------

function staticUrl(file: string) {
  return pathToFileURL(path.join(staticDir, file)).href;
}

function installSecurity() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // The app window may only talk to the local Aharos server; local pages only to their own files.
  const staticPrefix = pathToFileURL(staticDir).href + "/";
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url;
    const allowed = url.startsWith("file:") ? url.startsWith(staticPrefix) : origin !== "" && isAllowedRendererRequest(url, origin);
    if (!allowed) log?.warn(`Blocked renderer request to ${url.slice(0, 200)}`);
    cb({ cancel: !allowed });
  });

  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (e) => e.preventDefault());
    const guard = (e: { preventDefault(): void }, url: string) => {
      if (contents === mainWindow?.webContents && isAppUrl(url, origin)) return;
      e.preventDefault();
      log?.warn(`Blocked navigation to ${url.slice(0, 200)}`);
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
  });
}

const secureWebPreferences = (preload?: string) => ({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
  devTools: !app.isPackaged,
  ...(preload ? { preload } : {}),
});

/** IPC handlers only answer the windows they were made for. */
function fromApp(e: IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? "";
  if (!isAppUrl(url, origin) || e.sender !== mainWindow?.webContents) throw new Error("Unauthorized IPC sender");
}

// ---------------- windows ----------------

function createSplash() {
  splash = new BrowserWindow({
    width: 420, height: 300, frame: false, resizable: false, show: false, center: true,
    backgroundColor: "#0f2a31", title: "Aharos", icon: iconPath,
    webPreferences: secureWebPreferences(),
  });
  splash.once("ready-to-show", () => splash?.show());
  void splash.loadURL(staticUrl("splash.html"));
}

function setSplashStatus(text: string) {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents.executeJavaScript(`document.getElementById("status").textContent = ${JSON.stringify(text)};`).catch(() => undefined);
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

/** First run: collect restaurant + owner details and call the Phase 5A bootstrap through the DB tool. */
function runSetupWizard(tool: DbTool): Promise<void> {
  return new Promise((resolve, reject) => {
    const setupUrl = staticUrl("setup.html");
    const win = new BrowserWindow({
      width: 760, height: 720, minWidth: 640, minHeight: 600, show: false, center: true,
      title: "Set up Aharos", icon: iconPath, backgroundColor: "#f4f7f8", autoHideMenuBar: true,
      webPreferences: secureWebPreferences(path.join(__dirname, "preload-setup.js")),
    });
    win.setMenu(null);
    let done = false;
    const fromSetup = (e: IpcMainInvokeEvent) => {
      if (e.sender !== win.webContents || e.senderFrame?.url !== setupUrl) throw new Error("Unauthorized IPC sender");
    };
    const cleanup = () => {
      ipcMain.removeHandler("setup:defaults");
      ipcMain.removeHandler("setup:submit");
      ipcMain.removeHandler("setup:finish");
    };
    ipcMain.handle("setup:defaults", (e) => {
      fromSetup(e);
      return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata", currency: "INR", version: app.getVersion() };
    });
    let creating = false;
    ipcMain.handle("setup:submit", async (e, raw: unknown) => {
      fromSetup(e);
      if (creating || done) return { ok: false, message: "Setup is already in progress" };
      const v = validateSetupInput(raw);
      if (!v.ok) return { ok: false, message: "Please check the highlighted fields", fieldErrors: v.fieldErrors };
      creating = true;
      try {
        const r = await tool.call<{ ownerEmail: string }>("bootstrap", { input: v.value });
        done = true;
        log.info(`First-run setup completed for ${r.ownerEmail}`);
        return { ok: true, ownerEmail: r.ownerEmail };
      } catch (err) {
        const d = err instanceof DbToolError ? err.detail : { name: "Error", message: (err as Error).message };
        log.warn(`Setup rejected: ${d.name}`);
        return { ok: false, message: d.message, fieldErrors: d.fieldErrors };
      } finally {
        creating = false;
      }
    });
    ipcMain.handle("setup:finish", (e) => {
      fromSetup(e);
      if (!done) return false;
      cleanup();
      createSplash(); // before destroying this window, so the app never has zero windows (would quit)
      win.destroy();
      resolve();
      return true;
    });
    win.on("closed", () => {
      cleanup();
      if (!done) reject(new SetupCancelled());
      else resolve();
    });
    win.once("ready-to-show", () => {
      closeSplash();
      win.show();
    });
    void win.loadURL(setupUrl);
  });
}
class SetupCancelled extends Error {}

function createMainWindow() {
  const b = config.window;
  mainWindow = new BrowserWindow({
    width: b?.width ?? 1366, height: b?.height ?? 820, x: b?.x, y: b?.y,
    minWidth: 1024, minHeight: 700, show: false,
    title: "Aharos", icon: iconPath, backgroundColor: "#f4f7f8", autoHideMenuBar: true,
    webPreferences: secureWebPreferences(path.join(__dirname, "preload-app.js")),
  });
  const win = mainWindow;
  win.once("ready-to-show", () => {
    if (config.window?.maximized ?? true) win.maximize();
    win.show();
    closeSplash();
    mark("windowShown");
  });
  win.webContents.once("did-finish-load", () => {
    mark("firstPageLoaded");
    log.info(`Startup timings (ms since launch): ${JSON.stringify(timings)}`);
    try {
      fs.appendFileSync(path.join(paths.logs, "startup.jsonl"), JSON.stringify({ at: new Date().toISOString(), version: app.getVersion(), ...timings }) + "\n");
    } catch {
      /* ignore */
    }
  });
  win.on("close", () => {
    const max = win.isMaximized();
    const r = win.getNormalBounds();
    config.window = { x: r.x, y: r.y, width: r.width, height: r.height, maximized: max };
    saveConfig(paths.config, config);
  });
  win.on("closed", () => (mainWindow = null));
  void win.loadURL(`${origin}/`);
}

// ---------------- boot ----------------

async function boot() {
  paths = dataPaths(app.getPath("userData"));
  ensureDirs(paths);
  log = createLogger(paths.logs, !app.isPackaged);
  log.info(`Aharos ${app.getVersion()} starting (packaged=${app.isPackaged}, electron=${process.versions.electron})`);
  installSecurity();
  buildMenu();
  createSplash();
  mark("splash");

  const codec: SecretCodec = {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
    decrypt: (v) => safeStorage.decryptString(Buffer.from(v, "base64")),
  };
  config = loadOrCreateConfig(paths.config, codec).config;
  const authSecret = readSecret(config, codec);
  if (!(await portFree(config.port))) {
    const old = config.port;
    config.port = await anyFreePort();
    saveConfig(paths.config, config);
    log.warn(`Port ${old} is in use; Aharos now uses ${config.port}`);
  }
  origin = appOrigin(config.port);

  const engine = path.join(serverDir, "node_modules", ".prisma", "client", "query_engine-windows.dll.node");
  const serverEnv = childEnv(process.env, {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: sqliteUrl(paths.dbFile),
    ...(fs.existsSync(engine) ? { PRISMA_QUERY_ENGINE_LIBRARY: engine } : {}),
    AUTH_SECRET: authSecret, EXPORT_DIR: paths.exports, RATE_LIMIT_STORE: "memory", AHAROS_DESKTOP: "1" });

  setSplashStatus("Checking restaurant database…");
  const tool = new DbTool(serverDir, toolEnv(), log);
  let keepTool = false;
  try {
    const mig = await tool.call<{ applied: string[]; backup: { file: string } | null }>("migrate", { backupDir: paths.backups });
    if (mig.applied.length) log.info(`Applied migrations: ${mig.applied.join(", ")}${mig.backup ? ` (backup ${mig.backup.file})` : ""}`);
    mark("migrated");
    const status = await tool.call<{ initialized: boolean; journalMode: string }>("status");
    log.info(`Database ready (journal=${status.journalMode}, initialized=${status.initialized})`);
    if (!status.initialized) {
      await runSetupWizard(tool);
      mark("setupDone");
    }

    setSplashStatus("Starting Aharos…");
    server = new AharosServer(serverDir, serverEnv, config.port, log, onServerCrash);
    const ms = await server.start();
    mark("serverReady");
    log.info(`Aharos server ready on loopback in ${ms} ms`);
    createMainWindow();

    // Automatic verified backup (background; VACUUM INTO is safe while the server runs).
    const last = config.lastAutoBackupAt ? Date.parse(config.lastAutoBackupAt) : 0;
    if (status.initialized && Date.now() - last > AUTO_BACKUP_INTERVAL_MS) {
      keepTool = true;
      void tool
        .call<{ manifest: { file: string }; rotated: string[] }>("backup", { reason: "auto", backupDir: paths.backups })
        .then((r) => {
          config.lastAutoBackupAt = new Date().toISOString();
          saveConfig(paths.config, config);
          log.info(`Automatic backup ${r.manifest.file} verified${r.rotated.length ? `; rotated ${r.rotated.length}` : ""}`);
        })
        .catch((e) => log.error(`Automatic backup failed: ${(e as Error).message}`))
        .finally(() => void tool.close());
    }
  } catch (e) {
    if (e instanceof SetupCancelled) {
      log.info("Setup closed before completion; exiting");
      await tool.close();
      app.exit(0);
      return;
    }
    throw e;
  } finally {
    if (!keepTool) void tool.close();
  }
}

function onServerCrash(restarted: boolean) {
  if (restarted) {
    log.warn("Aharos server restarted after a crash");
    mainWindow?.webContents.reload();
    return;
  }
  dialog.showErrorBox("Aharos stopped working", `The Aharos engine stopped repeatedly and could not be restarted.\n\nYour data is safe in:\n${paths.dataDir}\n\nLogs: ${paths.logs}`);
  app.exit(1);
}

function fatal(title: string, e: unknown) {
  const message = e instanceof DbToolError ? e.detail.message : e instanceof Error ? e.message : String(e);
  log?.error(`${title}: ${message}`);
  closeSplash();
  dialog.showErrorBox(title, `${message}\n\nNo data was deleted. Backups: ${paths?.backups ?? "-"}\nLogs: ${paths?.logs ?? "-"}`);
  app.exit(1);
}

// ---------------- backup / restore (main process only) ----------------

function toolEnv(): Record<string, string> {
  const engine = path.join(serverDir, "node_modules", ".prisma", "client", "query_engine-windows.dll.node");
  return childEnv(process.env, {
    NODE_ENV: "production",
    DATABASE_URL: sqliteUrl(paths.dbFile),
    ...(fs.existsSync(engine) ? { PRISMA_QUERY_ENGINE_LIBRARY: engine } : {}),
    AHAROS_DB_FILE: paths.dbFile,
    AHAROS_MIGRATIONS_DIR: path.join(serverDir, "migrations"),
    AHAROS_APP_VERSION: app.getVersion(),
  });
}

async function withTool<T>(fn: (tool: DbTool) => Promise<T>): Promise<T> {
  const tool = new DbTool(serverDir, toolEnv(), log);
  try {
    return await fn(tool);
  } finally {
    await tool.close();
  }
}

async function backupNow() {
  try {
    const r = await withTool((t) => t.call<{ manifest: { file: string; sizeBytes: number } }>("backup", { reason: "manual", backupDir: paths.backups }));
    log.info(`Manual backup ${r.manifest.file} verified`);
    await dialog.showMessageBox({ type: "info", title: "Backup complete", message: "Backup created and verified.", detail: `${r.manifest.file}\n${(r.manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB\n\nFolder: ${paths.backups}` });
  } catch (e) {
    log.error(`Manual backup failed: ${(e as Error).message}`);
    dialog.showErrorBox("Backup failed", (e as Error).message);
  }
}

/** Restoring replaces today's data, so it requires an OWNER signed in on this terminal. */
async function signedInOwner(): Promise<string | null> {
  if (!origin) return null;
  const [cookie] = await session.defaultSession.cookies.get({ url: origin, name: SESSION_COOKIE });
  if (!cookie?.value) return null;
  const res = await fetch(`${server?.origin}/api/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` } }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json()) as { data?: { user?: { email?: string }; access?: { roles?: string[]; isOrgWide?: boolean; isSuperAdmin?: boolean } } };
  const a = body.data?.access;
  return a && (a.isSuperAdmin || (a.isOrgWide && a.roles?.includes("OWNER"))) ? body.data?.user?.email ?? "owner" : null;
}

async function restoreFromBackup() {
  const owner = await signedInOwner();
  if (!owner) {
    await dialog.showMessageBox({ type: "warning", title: "Owner sign-in required", message: "Only the restaurant Owner can restore a backup.", detail: "Sign in to Aharos as the Owner on this computer, then choose Restore again." });
    return;
  }
  const opts = { title: "Choose an Aharos backup", defaultPath: paths.backups, filters: [{ name: "Aharos backup", extensions: ["db"] }], properties: ["openFile"] as const };
  const pick = mainWindow ? await dialog.showOpenDialog(mainWindow, { ...opts, properties: [...opts.properties] }) : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] });
  const file = pick.filePaths[0];
  if (pick.canceled || !file) return;
  try {
    const v = await withTool((t) => t.call<{ ok: boolean; error?: string; migrations?: string[]; organizations?: number; manifest?: { createdAt: string; reason: string; appVersion: string } }>("verify", { file }));
    if (!v.ok) throw new Error(`This backup cannot be restored: ${v.error}`);
    const answer = await dialog.showMessageBox({
      type: "warning", buttons: ["Cancel", "Restore"], defaultId: 0, cancelId: 0, title: "Restore backup",
      message: "Replace the current restaurant data with this backup?",
      detail: `${path.basename(file)}${v.manifest ? `\nCreated ${new Date(v.manifest.createdAt).toLocaleString()} (${v.manifest.reason}, v${v.manifest.appVersion})` : ""}\n\nThe current data is backed up first (pre-restore), so this can be undone.`,
    });
    if (answer.response !== 1) return;

    // Stop writes first, so the pre-restore backup holds every committed transaction.
    await server?.stop();
    let preFile = "";
    try {
      const pre = await withTool((t) => t.call<{ manifest: { file: string } }>("backup", { reason: "pre-restore", backupDir: paths.backups }));
      preFile = pre.manifest.file;
      log.info(`Restore by ${owner}: pre-restore backup ${preFile}; restoring ${path.basename(file)}`);
      // Verify the exact bytes that will be swapped in (the chosen file could change after the first check).
      const tmp = `${paths.dbFile}.restore-tmp`;
      fs.copyFileSync(file, tmp);
      const copy = await withTool((t) => t.call<{ ok: boolean; error?: string }>("verify", { file: tmp }));
      if (!copy.ok) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`The copied backup failed verification: ${copy.error}`);
      }
      for (const s of ["-wal", "-shm", "-journal"]) fs.rmSync(paths.dbFile + s, { force: true });
      fs.renameSync(tmp, paths.dbFile);
      await withTool(async (t) => {
        await t.call("migrate", { backupDir: paths.backups });
        await t.call("status");
      });
    } finally {
      await server?.start();
      mainWindow?.loadURL(`${origin}/`);
    }
    log.info("Restore completed");
    await dialog.showMessageBox({ type: "info", title: "Restore complete", message: "The backup was restored.", detail: `Previous data saved as ${preFile}` });
  } catch (e) {
    log.error(`Restore failed: ${(e as Error).message}`);
    dialog.showErrorBox("Restore failed", (e as Error).message);
  }
}

// ---------------- hardware IPC ----------------

function printerDriver(name: string | null): PrinterDriver {
  return name ? new SystemPrinterDriver(name) : new MockPrinterDriver(paths.printSpool);
}

ipcMain.handle("aharos:info", (e) => {
  fromApp(e);
  return { desktop: true, version: app.getVersion(), platform: process.platform };
});
ipcMain.handle("aharos:printers", async (e) => {
  fromApp(e);
  return listPrinters(e.sender);
});
ipcMain.handle("aharos:testPrint", async (e, raw: unknown) => {
  fromApp(e);
  const name = validatePrinterName(raw);
  if (name && !(await listPrinters(e.sender)).some((p) => p.name === name)) throw new Error("Unknown printer");
  const result = await printerDriver(name).print(testPage(app.getVersion()));
  log.info(`Test print: ${JSON.stringify(result)}`);
  return result;
});

// ---------------- menu & lifecycle ----------------

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Aharos",
      submenu: [
        { label: "About Aharos", click: () => void dialog.showMessageBox({ type: "info", title: "About Aharos", message: `Aharos ${app.getVersion()}`, detail: "Restaurant Operating System" }) },
        { type: "separator" },
        { label: "Back Up Now", click: () => void backupNow() },
        { label: "Restore from Backup…", click: () => void restoreFromBackup() },
        { label: "Open Backups Folder", click: () => void shell.openPath(paths.backups) },
        { label: "Open Logs Folder", click: () => void shell.openPath(paths.logs) },
        { type: "separator" },
        { role: "quit", label: "Quit Aharos" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : ([{ role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  log?.info("Shutting down");
  void server.stop().finally(() => app.quit());
});
