/**
 * App-window bridge. The renderer is sandboxed with no Node access; this exposes
 * three read-only / harmless operations, plus a listener through which the main
 * process asks the page to show its password confirmation dialog (backup
 * restore). Every call is re-validated in the main process (sender origin +
 * arguments); a re-auth reply is only a hint — the main process asks the server.
 */
import { contextBridge, ipcRenderer } from "electron";

type ReauthOutcome = "granted" | "cancelled" | "session_ended";

// The page that can show the password dialog (ReauthProvider) registers here.
// With none registered (e.g. the sign-in page), the request is answered
// "cancelled" at once instead of leaving the main process waiting.
let reauthHandler: ((scope: string) => Promise<ReauthOutcome>) | null = null;
ipcRenderer.on("aharos:reauthRequest", async (_e, msg: { id?: unknown; scope?: unknown }) => {
  if (typeof msg?.id !== "string" || typeof msg?.scope !== "string") return;
  let outcome: ReauthOutcome = "cancelled";
  try {
    const o = reauthHandler ? await reauthHandler(msg.scope) : "cancelled";
    if (o === "granted" || o === "session_ended") outcome = o;
  } catch {
    outcome = "cancelled";
  }
  ipcRenderer.send("aharos:reauthResult", { id: msg.id, outcome });
});

contextBridge.exposeInMainWorld("aharosDesktop", {
  info: () => ipcRenderer.invoke("aharos:info"),
  printers: () => ipcRenderer.invoke("aharos:printers"),
  testPrint: (printerName?: string) => ipcRenderer.invoke("aharos:testPrint", typeof printerName === "string" ? printerName : undefined),
  onReauthRequest: (handler: (scope: string) => Promise<ReauthOutcome>) => {
    if (typeof handler !== "function") return () => undefined;
    reauthHandler = handler;
    return () => {
      if (reauthHandler === handler) reauthHandler = null;
    };
  },
});
