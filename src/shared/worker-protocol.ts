import type {
  CancelTaskInput,
  ClearDraftInput,
  ClearDraftValue,
  CommandOutcome,
  CommandValue,
  CompleteTaskInput,
  CreateTaskInput,
  DailyReview,
  DailyReviewInput,
  Draft,
  FinishDailyReviewInput,
  ListTasksInput,
  MarkWaitingInput,
  Page,
  PauseTaskInput,
  PreferenceState,
  ReopenTaskInput,
  ResolveWaitingInput,
  Result,
  SaveBreakpointInput,
  SaveDraftInput,
  SaveDraftValue,
  SetNextUpInput,
  StartTaskInput,
  SwitchTaskInput,
  TaskDetail,
  TaskDetailInput,
  TaskSummary,
  UpdatePreferenceInput,
  UpdatePreferenceValue,
  UpdateTaskInput,
  WorkspaceSnapshot,
} from "./contracts";

/** main → worker 的固定命令集合；worker 串行处理。 */
export type WorkerRequest =
  | { kind: "getWorkspaceSnapshot" }
  | { kind: "listTasks"; input: ListTasksInput }
  | { kind: "getTaskDetail"; input: TaskDetailInput }
  | { kind: "getDailyReview"; input: DailyReviewInput }
  | { kind: "getCommandResult"; input: { commandId: string } }
  | { kind: "createTask"; input: CreateTaskInput }
  | { kind: "updateTask"; input: UpdateTaskInput }
  | { kind: "startTask"; input: StartTaskInput }
  | { kind: "switchTask"; input: SwitchTaskInput }
  | { kind: "pauseTask"; input: PauseTaskInput }
  | { kind: "markWaiting"; input: MarkWaitingInput }
  | { kind: "resolveWaiting"; input: ResolveWaitingInput }
  | { kind: "completeTask"; input: CompleteTaskInput }
  | { kind: "cancelTask"; input: CancelTaskInput }
  | { kind: "reopenTask"; input: ReopenTaskInput }
  | { kind: "saveBreakpoint"; input: SaveBreakpointInput }
  | { kind: "setNextUp"; input: SetNextUpInput }
  | { kind: "finishDailyReview"; input: FinishDailyReviewInput }
  | { kind: "getDraft" }
  | { kind: "saveDraft"; input: SaveDraftInput }
  | { kind: "clearDraft"; input: ClearDraftInput }
  | { kind: "getPreferences" }
  | { kind: "updatePreference"; input: UpdatePreferenceInput }
  | { kind: "close" };

export type WorkerReplyValue =
  | WorkspaceSnapshot
  | Page<TaskSummary>
  | TaskDetail
  | DailyReview
  | CommandOutcome
  | Draft
  | PreferenceState
  | CommandValue
  | SaveDraftValue
  | ClearDraftValue
  | UpdatePreferenceValue
  | null;

export type WorkerResponse = {
  requestId: number;
  result: Result<WorkerReplyValue>;
};

export type WorkerBootMessage =
  | {
      ready: true;
      sqliteVersion: string;
      schemaVersion: number;
      /** 本次启动执行了迁移时为升级前保护副本路径，否则为 null。 */
      backupPath: string | null;
    }
  | {
      fatal: true;
      code: "DB_UNAVAILABLE" | "VALIDATION_ERROR";
      message: string;
    };

/**
 * 仅集成测试使用的故障注入点。workerData.faults 未提供时这些分支永不触发；
 * 生产启动路径不传递该参数（见 main/index.ts 的 --integration-test 分支）。
 */
export type WorkerFaultStage =
  | "create.beforeReceipt"
  | "switch.afterBreakpoint"
  | "switch.afterPause"
  | "switch.afterStart"
  | "switch.beforeReceipt"
  | "pause.afterUpdate"
  | "finish.afterPause"
  /** 启动阶段退出：worker 打开数据库后在发送 ready 之前关闭端口。 */
  | "boot.exitBeforeReady"
  /** 就绪后退出：worker 收到请求后不回复，直接关闭数据库与端口。 */
  | "request.exitBeforeReply";

export type WorkerStartOptions = {
  path: string;
  faults?: WorkerFaultStage[];
};
