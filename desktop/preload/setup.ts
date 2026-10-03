/** First-run wizard bridge: defaults, submit (validated again in main + by bootstrapOwner), finish. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aharosSetup", {
  defaults: () => ipcRenderer.invoke("setup:defaults"),
  submit: (input: unknown) => ipcRenderer.invoke("setup:submit", input),
  finish: () => ipcRenderer.invoke("setup:finish"),
});
