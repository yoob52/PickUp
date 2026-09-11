import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { z, type ZodType } from "zod";
import {
  cancelTaskSchema,
  clearDraftSchema,
  commandResultSchema,
  completeTaskSchema,
  createTaskSchema,
  finishDailyReviewSchema,
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
  updatePreferenceSchema,
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
} from "../shared/contracts";
import { localDayRangeUtc } from "../shared/local-date";
import type { StoreClient } from "./worker-client";

const COMPLETED_TODAY_LIMIT = 100;

const noInput = z.undefined();

type Registered = {
  channel: string;
  schema: ZodType;
  broadcast: boolean;
  run: (client: StoreClient, input: unknown) => Promise<Result<unknown>>;
};

/**
 * 固定命令 allowlist：每个 channel 对应唯一 schema 与唯一 worker 请求。
 * 不存在“执行 SQL”“读取任意文件”或通用 channel 转发入口。
 */
const registry: Registered[] = [];

function register<S extends ZodType, V>(
  channel: string,
  schema: S,
  broadcast: boolean,
  run: (client: StoreClient, input: z.output<S>) => Promise<Result<V>>,
): void {
  registry.push({
    channel,
    schema,
    broadcast,
    run: run as Registered["run"],
  });
}

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
// 本地日期边界由 main 的可信代码计算；renderer 不能指定或推导查询范围。
register("pickup:getDailyReview", noInput, false, (client) => {
  const range = localDayRangeUtc(Date.now());
  return client.send<DailyReview>({
    kind: "getDailyReview",
    input: {
      dayKey: range.dayKey,
      startUtc: range.startUtc,
      endUtc: range.endUtc,
      completedLimit: COMPLETED_TODAY_LIMIT,
    },
  });
});

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
register(
  "pickup:updatePreference",
  updatePreferenceSchema,
  false,
  (client, input) => client.send({ kind: "updatePreference", input }),
);

/** 校验已登记窗口、主 frame 与允许的来源；renderer 参数不构成权限证明。 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame)
    throw new Error("untrusted-ipc-sender");
  const url = new URL(event.senderFrame.url);
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (url.protocol === "pickup:" && url.host === "app") return;
  if (!app.isPackaged && devServer && url.origin === new URL(devServer).origin)
    return;
  throw new Error("untrusted-ipc-origin");
}

/**
 * 事务已提交后才广播刷新通知；通知发送失败不影响已提交的结果，
 * 也不会被描述成数据库保存失败。
 */
function notifyStateChanged(revision: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send("pickup:changed", revision);
    } catch {
      console.error("state-changed-notification-failed", { revision });
    }
  }
}

export function registerIpcHandlers(client: StoreClient): void {
  for (const entry of registry) {
    ipcMain.handle(entry.channel, async (event, raw: unknown) => {
      try {
        assertTrustedSender(event);
      } catch {
        console.error("rejected-ipc-request", { channel: entry.channel });
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "请求来源不可信，已拒绝处理。",
          retryable: false,
        } satisfies Result<never>;
      }
      const parsed = entry.schema.safeParse(raw);
      if (!parsed.success)
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "提交内容不符合要求，请检查后重试。",
          retryable: false,
        } satisfies Result<never>;
      const result = await entry.run(client, parsed.data);
      if (entry.broadcast && result.ok) notifyStateChanged(result.revision);
      return result;
    });
  }
}

export function registeredChannels(): string[] {
  return registry.map((entry) => entry.channel);
}
