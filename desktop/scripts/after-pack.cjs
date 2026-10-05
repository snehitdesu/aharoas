/**
 * electron-builder afterPack hook: copy the server payload (build/desktop/server,
 * already secret-scanned by build.mjs) verbatim into resources/server
 * (Windows: <app>/resources/server; macOS: RESTORA.app/Contents/Resources/server).
 *
 * Done here instead of `extraResources` because electron-builder 26 silently
 * drops every node_modules directory from extraResources, and the standalone
 * Next.js server needs its traced node_modules (incl. .prisma/client + engine).
 * Runs before the installer targets (NSIS / portable / DMG) are built and before
 * macOS code signing, so every target contains it and the copied native
 * modules are signed with the app.
 *
 * The payload's native modules (Prisma query engine, sharp) are those of the
 * machine that ran build.mjs — there is no cross-compilation. A package whose
 * target platform/arch does not match them would install and then fail on first
 * start, so the hook refuses to produce it.
 */
const fs = require("node:fs");
const path = require("node:path");

// electron-builder's Arch enum (builder-util): ia32 = 0, x64 = 1, armv7l = 2, arm64 = 3, universal = 4.
const ARCH = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

/** Must match prismaEngineFile() in desktop/main/config.ts. */
function prismaEngineFile(platform, arch) {
  if (platform === "win32") return "query_engine-windows.dll.node";
  if (platform === "darwin") return arch === "arm64" ? "libquery_engine-darwin-arm64.dylib.node" : "libquery_engine-darwin.dylib.node";
  return null;
}

/** CPU of a Mach-O file: "arm64", "x64", "universal" or null (not Mach-O). */
function machOArch(file) {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(8);
  try {
    fs.readSync(fd, b, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (b.readUInt32BE(0) === 0xcafebabe) return "universal";
  if (b.readUInt32LE(0) !== 0xfeedfacf) return null; // 64-bit little-endian Mach-O
  const cpu = b.readUInt32LE(4);
  return cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : `cpu ${cpu.toString(16)}`;
}

function nativeModules(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) nativeModules(p, acc);
    else if (e.name.endsWith(".node") || e.name.endsWith(".dylib")) acc.push(p);
  }
  return acc;
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH[context.arch] ?? String(context.arch);
  const projectDir = context.packager.projectDir;
  const src = path.join(projectDir, "build", "desktop", "server");
  const resources = platform === "darwin" ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources") : path.join(context.appOutDir, "resources");
  const dest = path.join(resources, "server");
  if (!fs.existsSync(path.join(src, "server.js"))) throw new Error(`Server payload missing at ${src}; run desktop/scripts/build.mjs first`);

  const engine = prismaEngineFile(platform, arch);
  if (platform === "darwin" && arch === "universal") throw new Error("Universal macOS builds are not supported: build one DMG per arch on a Mac of that arch (see docs/desktop-release.md)");
  if (engine && !fs.existsSync(path.join(src, "node_modules", ".prisma", "client", engine))) {
    throw new Error(`The server payload has no Prisma engine for ${platform}-${arch} (${engine}). It was built on ${process.platform}-${process.arch}: build the ${platform} package on a ${platform}-${arch} machine.`);
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  for (const required of ["server.js", "dbtool.js", "migrations", ".next-desktop/BUILD_ID", "node_modules/next", "node_modules/@prisma/client", ...(engine ? [`node_modules/.prisma/client/${engine}`] : [])]) {
    if (!fs.existsSync(path.join(dest, required))) throw new Error(`Packaged server is missing ${required}`);
  }
  if (platform === "darwin") {
    const wrong = nativeModules(dest)
      .map((f) => [f, machOArch(f)])
      .filter(([, a]) => a !== arch && a !== "universal");
    if (wrong.length) throw new Error(`Native modules do not match ${platform}-${arch}:\n- ${wrong.map(([f, a]) => `${path.relative(dest, f)} (${a ?? "not Mach-O"})`).join("\n- ")}`);
  }
  console.log(`  • aharos server payload copied  dest=${path.relative(projectDir, dest)}  target=${platform}-${arch}`);
};
