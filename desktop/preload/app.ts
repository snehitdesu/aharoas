/**
 * App-window bridge. The renderer is sandboxed with no Node access; this exposes
 * exactly three read-only / harmless operations. Every call is re-validated in
 * the main process (sender origin + arguments).
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aharosDesktop", {
  info: () => ipcRenderer.invoke("aharos:info"),
  printers: () => ipcRenderer.invoke("aharos:printers"),
  testPrint: (printerName?: string) => ipcRenderer.invoke("aharos:testPrint", typeof printerName === "string" ? printerName : undefined),
});
