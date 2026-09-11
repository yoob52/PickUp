import { parentPort, workerData } from "node:worker_threads";
import type { Result } from "../shared/contracts";
import type {
  WorkerBootMessage,
  WorkerReplyValue,
  WorkerRequest,
  WorkerStartOptions,
} from "../shared/worker-protocol";
import { openStore, type Store } from "./database";
import { describeBootFailure, toAppError } from "./errors";

if (!parentPort) throw new Error("worker requires a parent port");

const port = parentPort!;

const options = workerData as WorkerStartOptions;
function commit(reply: {
  value: unknown;
  revision: number;
}): Result<WorkerReplyValue> {
  return {
    ok: true,
    value: reply.value as WorkerReplyValue,
    revision: reply.revision,
  };
}

function conclude(
  store: Store,
  value: WorkerReplyValue,
): Result<WorkerReplyValue> {
  return { ok: true, value, revision: store.revision() };
}

/** 每个请求都必须得到且只得到一个应答；未知命令明确拒绝。 */
function dispatch(
  store: Store,
  request: WorkerRequest,
): Result<WorkerReplyValue> {
  switch (request.kind) {
    case "getWorkspaceSnapshot": {
      const value = store.workspaceSnapshot();
      return { ok: true, value, revision: value.revision };
    }
    case "listTasks":
      return conclude(store, store.listTasks(request.input));
    case "getTaskDetail":
      return conclude(store, store.taskDetail(request.input));
    case "getDailyReview":
      return conclude(store, store.dailyReview(request.input));
    case "getCommandResult":
      return conclude(store, store.commandOutcome(request.input.commandId));
    case "createTask":
      return commit(store.createTask(request.input));
    case "updateTask":
      return commit(store.updateTask(request.input));
    case "startTask":
      return commit(store.startTask(request.input));
    case "switchTask":
      return commit(store.switchTask(request.input));
    case "pauseTask":
      return commit(store.pauseTask(request.input));
    case "markWaiting":
      return commit(store.markWaiting(request.input));
    case "resolveWaiting":
      return commit(store.resolveWaiting(request.input));
    case "completeTask":
      return commit(store.completeTask(request.input));
    case "cancelTask":
      return commit(store.cancelTask(request.input));
    case "reopenTask":
      return commit(store.reopenTask(request.input));
    case "saveBreakpoint":
      return commit(store.saveBreakpoint(request.input));
    case "setNextUp":
      return commit(store.setNextUp(request.input));
    case "finishDailyReview":
      return commit(store.finishDailyReview(request.input));
    case "getDraft":
      return conclude(store, store.getDraft());
    case "saveDraft":
      return conclude(store, store.saveDraft(request.input));
    case "clearDraft":
      return conclude(store, store.clearDraft(request.input));
    case "getPreferences":
      return conclude(store, store.getPreferences());
    case "updatePreference":
      return conclude(store, store.updatePreference(request.input));
    default:
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "不支持的内部命令。",
        retryable: false,
      };
  }
}

function start(): void {
  let store: Store;
  try {
    store = openStore(
      options.path,
      options.faults ? { faults: options.faults } : {},
    );
  } catch (error) {
    port.postMessage({
      fatal: true,
      code: "DB_UNAVAILABLE",
      message: describeBootFailure(error),
    } satisfies WorkerBootMessage);
    port.close();
    return;
  }

  port.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      typeof (message as { requestId?: unknown }).requestId !== "number"
    )
      return;
    // 集成测试专用：模拟就绪后进程在应答前退出（没有 error 事件、不回复请求）。
    if (options.faults?.includes("request.exitBeforeReply")) {
      store.close();
      port.close();
      return;
    }
    const { requestId, request } = message as {
      requestId: number;
      request: WorkerRequest;
    };
    let result: Result<WorkerReplyValue>;
    try {
      if (request.kind === "close") {
        const revision = store.revision();
        store.close();
        port.postMessage({
          requestId,
          result: { ok: true, value: null, revision },
        });
        port.close();
        return;
      }
      result = dispatch(store, request);
    } catch (error) {
      result = toAppError(error);
    }
    port.postMessage({ requestId, result });
  });

  // 集成测试专用：模拟数据库已打开、但 worker 在 ready 之前退出且没有 fatal/error 事件。
  if (options.faults?.includes("boot.exitBeforeReady")) {
    store.close();
    port.close();
    return;
  }

  port.postMessage({
    ready: true,
    sqliteVersion: store.sqliteVersion,
    schemaVersion: store.schemaVersion,
    backupPath: store.backupPath,
  } satisfies WorkerBootMessage);
}

start();
