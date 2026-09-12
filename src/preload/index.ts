import { contextBridge, ipcRenderer } from "electron";
import type { PickupAPI } from "../shared/contracts";

function subscribe(channel: string, listener: (...args: unknown[]) => void) {
  const handler = (_event: unknown, ...args: unknown[]) => listener(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/** 只暴露固定业务方法；不透传任意 channel，也不暴露原始 ipcRenderer。 */
const api: PickupAPI = {
  getWorkspaceSnapshot: () => ipcRenderer.invoke("pickup:getWorkspaceSnapshot"),
  listTasks: (input) => ipcRenderer.invoke("pickup:listTasks", input),
  getTaskDetail: (input) => ipcRenderer.invoke("pickup:getTaskDetail", input),
  getDailyReview: (input) =>
    ipcRenderer.invoke("pickup:getDailyReview", input ?? {}),
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
  showMain: () => ipcRenderer.invoke("pickup:showMain"),
  showCapture: () => ipcRenderer.invoke("pickup:showCapture"),
  hideCapture: () => ipcRenderer.invoke("pickup:hideCapture"),
  hideWidget: () => ipcRenderer.invoke("pickup:hideWidget"),
  quit: () => ipcRenderer.invoke("pickup:quit"),
  getDesktopState: () => ipcRenderer.invoke("pickup:getDesktopState"),
  onStateChanged(listener) {
    return subscribe("pickup:changed", (revision) =>
      listener(revision as number),
    );
  },
  onDayInvalidated(listener) {
    return subscribe("pickup:day-invalidated", () => listener());
  },
  onCaptureShown(listener) {
    return subscribe("pickup:capture-shown", () => listener());
  },
  onPrepareClose(handler) {
    const onRequest = () => {
      void handler()
        .catch(() => false)
        .then((ok) => ipcRenderer.send("pickup:prepare-close-result", ok));
    };
    ipcRenderer.on("pickup:prepare-close", onRequest);
    return () => ipcRenderer.removeListener("pickup:prepare-close", onRequest);
  },
};

contextBridge.exposeInMainWorld("pickup", api);
