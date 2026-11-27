import { storeRegistry, type StoreSender } from "../shared/api-registry";
import {
  updatePreferenceSchema,
  type PickupAPI,
  type Result,
} from "../shared/contracts";
import { localDayKey, msUntilNextLocalDay } from "../shared/local-date";
import { createMobileUpdates } from "./updates";

const unsupported = async (): Promise<Result<never>> => ({
  ok: false,
  code: "VALIDATION_ERROR",
  message:
    "当前浏览器不支持桌面窗口、桌面入口、开机启动或全局快捷键设置。请使用桌面版进行此操作。",
  retryable: false,
});
const invalid = (): Result<never> => ({
  ok: false,
  code: "VALIDATION_ERROR",
  message: "提交内容不符合要求，请检查后重试。",
  retryable: false,
});

function notify<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      console.error("mobile-notification-failed");
    }
  }
}

export function createMobileAPI(
  client: StoreSender,
  page: Document = document,
): { api: PickupAPI; dispose: () => void } {
  const changes = new Set<(revision: number) => void>();
  const days = new Set<() => void>();
  const unsubscribe = client.onStateChanged?.((revision) =>
    notify(changes, revision),
  );
  let day = localDayKey(Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;

  function checkDay(): void {
    const current = localDayKey(Date.now());
    if (current !== day) {
      day = current;
      notify(days, undefined);
    }
    clearTimeout(timer);
    if (days.size)
      timer = setTimeout(checkDay, msUntilNextLocalDay(Date.now()));
  }
  function visible(): void {
    if (page.visibilityState === "visible") checkDay();
  }

  async function invoke<T>(name: string, raw?: unknown): Promise<Result<T>> {
    const entry = storeRegistry.find(
      (entry) => entry.channel === `pickup:${name}`,
    )!;
    const parsed = entry.schema.safeParse(raw);
    if (!parsed.success) return invalid();
    const result = (await entry.run(client, parsed.data)) as Result<T>;
    if (entry.broadcast && result.ok) notify(changes, result.revision);
    return result;
  }

  const api: PickupAPI = {
    ...createMobileUpdates(),
    account: (input) => invoke("account", input),
    enableSync: unsupported,
    pairWithPayload: (payload) => invoke("pairWithPayload", payload),
    disableSync: () => invoke("disableSync"),
    getSyncStatus: () => invoke("getSyncStatus"),
    syncNow: () => invoke("syncNow"),
    getPairingPayload: unsupported,
    copyPairingPayload: unsupported,
    copyLoginPayload: unsupported,
    host: "mobile",
    getWorkspaceSnapshot: () => invoke("getWorkspaceSnapshot"),
    listTasks: (input) => invoke("listTasks", input),
    getTaskDetail: (input) => invoke("getTaskDetail", input),
    getDailyReview: (input) => invoke("getDailyReview", input),
    getCommandResult: (input) => invoke("getCommandResult", input),
    createTask: (input) => invoke("createTask", input),
    updateTask: (input) => invoke("updateTask", input),
    startTask: (input) => invoke("startTask", input),
    switchTask: (input) => invoke("switchTask", input),
    pauseTask: (input) => invoke("pauseTask", input),
    markWaiting: (input) => invoke("markWaiting", input),
    resolveWaiting: (input) => invoke("resolveWaiting", input),
    completeTask: (input) => invoke("completeTask", input),
    cancelTask: (input) => invoke("cancelTask", input),
    reopenTask: (input) => invoke("reopenTask", input),
    saveBreakpoint: (input) => invoke("saveBreakpoint", input),
    setNextUp: (input) => invoke("setNextUp", input),
    finishDailyReview: (input) => invoke("finishDailyReview", input),
    getDraft: () => invoke("getDraft"),
    saveDraft: (input) => invoke("saveDraft", input),
    clearDraft: (input) => invoke("clearDraft", input),
    getPreferences: () => invoke("getPreferences"),
    updatePreference: async (input) => {
      if (!updatePreferenceSchema.safeParse(input).success) return invalid();
      return unsupported();
    },
    showMain: unsupported,
    controlMainWindow: unsupported,
    showCapture: unsupported,
    hideCapture: unsupported,
    hideWidget: unsupported,
    moveWidget: unsupported,
    setWidgetExpanded: unsupported,
    quit: unsupported,
    getDesktopState: unsupported,
    onStateChanged(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    onDayInvalidated(listener) {
      if (!days.size) {
        day = localDayKey(Date.now());
        page.addEventListener("visibilitychange", visible);
      }
      days.add(listener);
      checkDay();
      return () => {
        days.delete(listener);
        if (!days.size) {
          clearTimeout(timer);
          page.removeEventListener("visibilitychange", visible);
        }
      };
    },
    onCaptureShown: () => () => {},
    onPrepareClose: () => () => {},
  };
  return {
    api: Object.freeze(api),
    dispose: () => {
      unsubscribe?.();
      clearTimeout(timer);
      page.removeEventListener("visibilitychange", visible);
      days.clear();
      changes.clear();
    },
  };
}
