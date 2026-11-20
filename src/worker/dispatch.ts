import type { Result } from "../shared/contracts";
import type {
  WorkerReplyValue,
  WorkerRequest,
} from "../shared/worker-protocol";
import type { createCommands } from "./commands";
import type { createQueries } from "./queries";

export type DispatchStore = ReturnType<typeof createCommands> &
  ReturnType<typeof createQueries>;

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
  store: DispatchStore,
  value: WorkerReplyValue,
): Result<WorkerReplyValue> {
  return { ok: true, value, revision: store.revision() };
}

/** 每个请求都必须得到且只得到一个应答；未知命令明确拒绝。 */
export function dispatch(
  store: DispatchStore,
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
