import { contextBridge, ipcRenderer } from "electron";
import type { PickupAPI } from "../shared/contracts";

/** 只暴露固定业务方法；不透传任意 channel，也不暴露原始 ipcRenderer。 */
const api: PickupAPI = {
  getWorkspaceSnapshot: () => ipcRenderer.invoke("pickup:getWorkspaceSnapshot"),
  listTasks: (input) => ipcRenderer.invoke("pickup:listTasks", input),
  getTaskDetail: (input) => ipcRenderer.invoke("pickup:getTaskDetail", input),
  getDailyReview: () => ipcRenderer.invoke("pickup:getDailyReview"),
  getCommandResult: (input) =>
    ipcRenderer.invoke("pickup:getCommandResult", input),
  createTask: (input) => ipcRenderer.invoke("pickup:createTask", input),
  updateTask: (input) => ipcRenderer.invoke("pickup:updateTask", input),
  startTask: (input) => ipcRenderer.invoke("pickup:startTask", input),
  switchTask: (input) => ipcRenderer.invoke("pickup:switchTask", input),
  pauseTask: (input) => ipcRenderer.invoke("pickup:pauseTask", input),
  markWaiting: (input) => ipcRenderer.invoke("pickup:markWaiting", input),
  resolveWaiting: (input) => ipcRenderer.invoke("pickup:resolveWaiting", input),
  completeTask: (input) => ipcRenderer.invoke("pickup:completeTask", input),
  cancelTask: (input) => ipcRenderer.invoke("pickup:cancelTask", input),
  reopenTask: (input) => ipcRenderer.invoke("pickup:reopenTask", input),
  saveBreakpoint: (input) => ipcRenderer.invoke("pickup:saveBreakpoint", input),
  setNextUp: (input) => ipcRenderer.invoke("pickup:setNextUp", input),
  finishDailyReview: (input) =>
    ipcRenderer.invoke("pickup:finishDailyReview", input),
  getDraft: () => ipcRenderer.invoke("pickup:getDraft"),
  saveDraft: (input) => ipcRenderer.invoke("pickup:saveDraft", input),
  clearDraft: (input) => ipcRenderer.invoke("pickup:clearDraft", input),
  getPreferences: () => ipcRenderer.invoke("pickup:getPreferences"),
  updatePreference: (input) =>
    ipcRenderer.invoke("pickup:updatePreference", input),
  onStateChanged(listener) {
    const handler = (_event: unknown, revision: number) => listener(revision);
    ipcRenderer.on("pickup:changed", handler);
    return () => ipcRenderer.removeListener("pickup:changed", handler);
  },
};

contextBridge.exposeInMainWorld("pickup", api);
