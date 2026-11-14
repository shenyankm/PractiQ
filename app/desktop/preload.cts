import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge.js";

const bridge: DesktopBridge = Object.freeze({
  request: (input: unknown, locale?: string) => ipcRenderer.invoke("practiq:request", input, locale),
  onCloseRequested: (listener: () => void) => {
    const notify = () => listener();
    ipcRenderer.on("practiq:close-requested", notify);
    return () => { ipcRenderer.removeListener("practiq:close-requested", notify); };
  },
  close: () => ipcRenderer.invoke("practiq:close"),
});
contextBridge.exposeInMainWorld("practiq", bridge);
