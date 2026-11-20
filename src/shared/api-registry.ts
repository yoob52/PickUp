import { z, type ZodType } from "zod";
import {
  cancelTaskSchema,
  clearDraftSchema,
  commandResultSchema,
  completeTaskSchema,
  createTaskSchema,
  finishDailyReviewSchema,
  getDailyReviewQuerySchema,
  listTasksSchema,
  markWaitingSchema,
  pauseTaskSchema,
  reopenTaskSchema,
  resolveWaitingSchema,
  saveBreakpointSchema,
  saveDraftSchema,
  setNextUpSchema,
  startTaskSchema,
  switchTaskSchema,
  taskDetailSchema,
  updateTaskSchema,
  type CommandOutcome,
  type DailyReview,
  type Draft,
  type Page,
  type PreferenceState,
  type Result,
  type TaskDetail,
  type TaskSummary,
  type WorkspaceSnapshot,
} from "./contracts";
import { localDayRangeUtc } from "./local-date";
import { enableSyncSchema, pairingInputSchema } from "./sync-contracts";
import type { WorkerRequest } from "./worker-protocol";
import { accountInputSchema } from "./account-contracts";

export type StoreSender = {
  onStateChanged?(listener: (revision: number) => void): () => void;
  send<T = unknown>(
    request: WorkerRequest,
    options?: { timeoutMs?: number },
  ): Promise<Result<T>>;
};

const noInput = z.undefined();

export type Registered = {
  channel: string;
  schema: ZodType;
  broadcast: boolean;
  run: (client: StoreSender, input: unknown) => Promise<Result<unknown>>;
};

/**
 * 固定命令 allowlist：每个 channel 对应唯一 schema 与唯一 worker 请求。
 * 不存在“执行 SQL”“读取任意文件”或通用 channel 转发入口。
 */
export const storeRegistry: Registered[] = [];

function register<S extends ZodType, V>(
  channel: string,
  schema: S,
  broadcast: boolean,
  run: (client: StoreSender, input: z.output<S>) => Promise<Result<V>>,
): void {
  storeRegistry.push({
    channel,
    schema,
    broadcast,
    run: run as Registered["run"],
  });
}

register("pickup:account", accountInputSchema, false, (client, input) =>
  client.send({ kind: "account", input }, { timeoutMs: 120000 }),
);
register("pickup:enableSync", enableSyncSchema, false, (client, input) =>
  client.send({ kind: "enableSync", input }, { timeoutMs: 25000 }),
);
register(
  "pickup:pairWithPayload",
  pairingInputSchema,
  false,
  (client, payload) =>
    client.send({ kind: "pairWithPayload", payload }, { timeoutMs: 120000 }),
);
register("pickup:disableSync", noInput, false, (client) =>
  client.send({ kind: "disableSync" }),
);
register("pickup:getSyncStatus", noInput, false, (client) =>
  client.send({ kind: "getSyncStatus" }),
);
register("pickup:syncNow", noInput, false, (client) =>
  client.send({ kind: "syncNow" }, { timeoutMs: 120000 }),
);
register("pickup:getPairingPayload", noInput, false, (client) =>
  client.send({ kind: "getPairingPayload" }),
);

register("pickup:getWorkspaceSnapshot", noInput, false, (client) =>
  client.send<WorkspaceSnapshot>({ kind: "getWorkspaceSnapshot" }),
);
register("pickup:listTasks", listTasksSchema, false, (client, input) =>
  client.send<Page<TaskSummary>>({ kind: "listTasks", input }),
);
register("pickup:getTaskDetail", taskDetailSchema, false, (client, input) =>
  client.send<TaskDetail>({ kind: "getTaskDetail", input }),
);
register(
  "pickup:getCommandResult",
  commandResultSchema,
  false,
  (client, input) =>
    client.send<CommandOutcome>({ kind: "getCommandResult", input }),
);
// 本地日期边界由宿主计算；UI 只能请求当天完成清单分页。
register(
  "pickup:getDailyReview",
  getDailyReviewQuerySchema.optional(),
  false,
  (client, input) => {
    const range = localDayRangeUtc(Date.now());
    return client.send<DailyReview>({
      kind: "getDailyReview",
      input: {
        dayKey: range.dayKey,
        startUtc: range.startUtc,
        endUtc: range.endUtc,
        completedOffset: input?.completedOffset ?? 0,
        completedLimit: input?.completedLimit ?? 50,
      },
    });
  },
);

register("pickup:createTask", createTaskSchema, true, (client, input) =>
  client.send({ kind: "createTask", input }),
);
register("pickup:updateTask", updateTaskSchema, true, (client, input) =>
  client.send({ kind: "updateTask", input }),
);
register("pickup:startTask", startTaskSchema, true, (client, input) =>
  client.send({ kind: "startTask", input }),
);
register("pickup:switchTask", switchTaskSchema, true, (client, input) =>
  client.send({ kind: "switchTask", input }),
);
register("pickup:pauseTask", pauseTaskSchema, true, (client, input) =>
  client.send({ kind: "pauseTask", input }),
);
register("pickup:markWaiting", markWaitingSchema, true, (client, input) =>
  client.send({ kind: "markWaiting", input }),
);
register("pickup:resolveWaiting", resolveWaitingSchema, true, (client, input) =>
  client.send({ kind: "resolveWaiting", input }),
);
register("pickup:completeTask", completeTaskSchema, true, (client, input) =>
  client.send({ kind: "completeTask", input }),
);
register("pickup:cancelTask", cancelTaskSchema, true, (client, input) =>
  client.send({ kind: "cancelTask", input }),
);
register("pickup:reopenTask", reopenTaskSchema, true, (client, input) =>
  client.send({ kind: "reopenTask", input }),
);
register("pickup:saveBreakpoint", saveBreakpointSchema, true, (client, input) =>
  client.send({ kind: "saveBreakpoint", input }),
);
register("pickup:setNextUp", setNextUpSchema, true, (client, input) =>
  client.send({ kind: "setNextUp", input }),
);
register(
  "pickup:finishDailyReview",
  finishDailyReviewSchema,
  true,
  (client, input) => client.send({ kind: "finishDailyReview", input }),
);

// 草稿与偏好按字段/版本条件更新，不广播工作区 revision（业务状态未变化）。
register("pickup:getDraft", noInput, false, (client) =>
  client.send<Draft>({ kind: "getDraft" }),
);
register("pickup:saveDraft", saveDraftSchema, false, (client, input) =>
  client.send({ kind: "saveDraft", input }),
);
register("pickup:clearDraft", clearDraftSchema, false, (client, input) =>
  client.send({ kind: "clearDraft", input }),
);
register("pickup:getPreferences", noInput, false, (client) =>
  client.send<PreferenceState>({ kind: "getPreferences" }),
);
