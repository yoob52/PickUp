import { contextBridge, ipcRenderer } from "electron";
import type { PickupAPI } from "../shared/contracts";
const api: PickupAPI = {
  snapshot: () => ipcRenderer.invoke("pickup:snapshot"),
  createTask: (input) => ipcRenderer.invoke("pickup:create", input),
  onStateChanged(listener) {
    const handler = (_event: unknown, revision: number) => listener(revision);
    ipcRenderer.on("pickup:changed", handler);
    return () => ipcRenderer.removeListener("pickup:changed", handler);
  },
};
contextBridge.exposeInMainWorld("pickup", api);
