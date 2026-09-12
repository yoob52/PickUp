import { z } from "zod";
import { TASK_STATUSES, type StatusCounts, type TaskStatus } from "./task";

/* ------------------------------------------------------------------ 通用 */

export const appErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "STATE_CONFLICT",
  "NEED_SWITCH",
  "COMMAND_ID_REUSED",
  "STORAGE_ERROR",
  "DB_UNAVAILABLE",
  "SHORTCUT_CONFLICT",
  "SYSTEM_SETTING_ERROR",
  "OUTCOME_UNKNOWN",
]);
export type AppErrorCode = z.infer<typeof appErrorCodeSchema>;

export type AppError = {
  ok: false;
  code: AppErrorCode;
  message: string;
  /** 刷新状态或确认回执后重试同一命令是否可能成功。 */
  retryable: boolean;
};

export type Result<T> = { ok: true; value: T; revision: number } | AppError;

export type Page<T> = {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

export const taskStatusSchema = z.enum(TASK_STATUSES);

/** 输入长度上是工程限制，不是产品硬上限；变更需同步文档。 */
export const TITLE_MAX_LENGTH = 300;
export const NOTE_MAX_LENGTH = 10_000;
export const BREAKPOINT_FIELD_MAX_LENGTH = 2_000;
export const WAIT_REASON_MAX_LENGTH = 1_000;

const commandIdSchema = z.uuid();
const taskIdSchema = z.uuid();
const versionSchema = z.number().int().min(1);
const textField = (max: number) => z.string().max(max);

const taskRefSchema = z
  .object({ taskId: taskIdSchema, expectedVersion: versionSchema })
  .strict();
export type TaskRef = z.infer<typeof taskRefSchema>;

const breakpointDraftSchema = z
  .object({
    progress: textField(BREAKPOINT_FIELD_MAX_LENGTH),
    nextStep: textField(BREAKPOINT_FIELD_MAX_LENGTH),
    referenceText: textField(BREAKPOINT_FIELD_MAX_LENGTH),
  })
  .strict();
export type BreakpointDraft = z.infer<typeof breakpointDraftSchema>;

const pagingSchema = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
};

/* ------------------------------------------------------- 命令输入 schema */

export const createTaskSchema = z
  .object({
    commandId: commandIdSchema,
    title: z.string().trim().min(1, "请填写任务标题").max(TITLE_MAX_LENGTH),
    note: textField(NOTE_MAX_LENGTH).default(""),
    /** 提交时所在的草稿版本；匹配则同事务清空草稿。 */
    draftVersion: z.number().int().min(0).optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    commandId: commandIdSchema,
    taskId: taskIdSchema,
    expectedVersion: versionSchema,
    title: z.string().trim().min(1, "请填写任务标题").max(TITLE_MAX_LENGTH),
    /** 省略表示不修改备注；传空字符串表示清空备注。 */
    note: textField(NOTE_MAX_LENGTH).optional(),
  })
  .strict();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const startTaskSchema = z
  .object({ commandId: commandIdSchema, task: taskRefSchema })
  .strict();
export type StartTaskInput = z.infer<typeof startTaskSchema>;

export const switchTaskSchema = z
  .object({
    commandId: commandIdSchema,
    from: taskRefSchema,
    to: taskRefSchema,
    breakpoint: breakpointDraftSchema.optional(),
  })
  .strict();
export type SwitchTaskInput = z.infer<typeof switchTaskSchema>;

export const pauseTaskSchema = z
  .object({
    commandId: commandIdSchema,
    task: taskRefSchema,
    breakpoint: breakpointDraftSchema.optional(),
  })
  .strict();
export type PauseTaskInput = z.infer<typeof pauseTaskSchema>;

export const markWaitingSchema = z
  .object({
    commandId: commandIdSchema,
    task: taskRefSchema,
    reason: textField(WAIT_REASON_MAX_LENGTH).default(""),
  })
  .strict();
export type MarkWaitingInput = z.infer<typeof markWaitingSchema>;

export const resolveWaitingSchema = z
  .object({ commandId: commandIdSchema, task: taskRefSchema })
  .strict();
export type ResolveWaitingInput = z.infer<typeof resolveWaitingSchema>;

export const completeTaskSchema = z
  .object({ commandId: commandIdSchema, task: taskRefSchema })
  .strict();
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;

export const cancelTaskSchema = completeTaskSchema;
export type CancelTaskInput = z.infer<typeof cancelTaskSchema>;

export const reopenTaskSchema = z
  .object({ commandId: commandIdSchema, task: taskRefSchema })
  .strict();
export type ReopenTaskInput = z.infer<typeof reopenTaskSchema>;

export const saveBreakpointSchema = z
  .object({
    commandId: commandIdSchema,
    task: taskRefSchema,
    breakpoint: breakpointDraftSchema,
  })
  .strict();
export type SaveBreakpointInput = z.infer<typeof saveBreakpointSchema>;

export const setNextUpSchema = z
  .object({
    commandId: commandIdSchema,
    taskId: taskIdSchema.nullable(),
    expectedNextUpVersion: z.number().int().min(0),
  })
  .strict();
export type SetNextUpInput = z.infer<typeof setNextUpSchema>;

export const finishDailyReviewSchema = z
  .object({
    commandId: commandIdSchema,
    outcome: z.enum(["keep", "pause"]),
    /** 收尾开始时看到的当前任务；null 表示当时没有当前任务。 */
    currentTask: taskRefSchema.nullable(),
    breakpoint: breakpointDraftSchema.optional(),
  })
  .strict();
export type FinishDailyReviewInput = z.infer<typeof finishDailyReviewSchema>;

export const saveDraftSchema = z
  .object({
    title: textField(TITLE_MAX_LENGTH),
    note: textField(NOTE_MAX_LENGTH),
    expectedDraftVersion: z.number().int().min(0),
  })
  .strict();
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;

export const clearDraftSchema = z
  .object({ expectedDraftVersion: z.number().int().min(0) })
  .strict();
export type ClearDraftInput = z.infer<typeof clearDraftSchema>;

/* --------------------------------------------------------- 偏好与窗口 */

export const widgetBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(120).max(4000),
    height: z.number().int().min(60).max(4000),
  })
  .strict();
export type WidgetBounds = z.infer<typeof widgetBoundsSchema>;

export const preferencesSchema = z
  .object({
    widgetEnabled: z.boolean(),
    widgetPinned: z.boolean(),
    widgetCollapsed: z.boolean(),
    widgetBounds: widgetBoundsSchema.nullable(),
    launchAtLogin: z.boolean(),
    accelerator: z.string().min(1).max(64),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  widgetEnabled: true,
  widgetPinned: false,
  widgetCollapsed: false,
  widgetBounds: null,
  launchAtLogin: false,
  accelerator: "Control+Alt+N",
};

export const preferencePatchSchema = preferencesSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "至少提供一个偏好字段");
export type PreferencePatch = z.infer<typeof preferencePatchSchema>;

export const updatePreferenceSchema = z
  .object({
    patch: preferencePatchSchema,
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export type UpdatePreferenceInput = z.infer<typeof updatePreferenceSchema>;

export const preferenceStateSchema = z
  .object({ values: preferencesSchema, version: z.number().int().min(0) })
  .strict();
export type PreferenceState = z.infer<typeof preferenceStateSchema>;

/* -------------------------------------------------------------- 查询输入 */

export const listTasksSchema = z
  .object({
    statuses: z.array(taskStatusSchema).min(1).max(6),
    ...pagingSchema,
  })
  .strict();
export type ListTasksInput = z.infer<typeof listTasksSchema>;

export const taskDetailSchema = z
  .object({
    taskId: taskIdSchema,
    breakpointOffset: z.number().int().min(0).default(0),
    breakpointLimit: z.number().int().min(1).max(50).default(10),
    transitionOffset: z.number().int().min(0).default(0),
    transitionLimit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type TaskDetailInput = z.infer<typeof taskDetailSchema>;

/** 本地日期边界由 main 的可信代码计算后传入 worker。 */
export const dailyReviewSchema = z
  .object({
    dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startUtc: z.number().int(),
    endUtc: z.number().int(),
    completedOffset: z.number().int().min(0).optional(),
    completedLimit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export type DailyReviewInput = z.infer<typeof dailyReviewSchema>;

/** renderer 只能请求当天完成清单的分页；不能指定日期范围。 */
export const getDailyReviewQuerySchema = z
  .object({
    completedOffset: z.number().int().min(0).default(0),
    completedLimit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type GetDailyReviewQuery = z.infer<typeof getDailyReviewQuerySchema>;

export const commandResultSchema = z
  .object({ commandId: commandIdSchema })
  .strict();
export type CommandResultInput = z.infer<typeof commandResultSchema>;

/* --------------------------------------------------------------- DTO 输出 */

export type BreakpointSummary = {
  seq: number;
  progress: string;
  nextStep: string;
  savedAt: number;
};

export type BreakpointRecord = BreakpointSummary & {
  taskId: string;
  referenceText: string;
};

export type TransitionRecord = {
  seq: number;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  changedAt: number;
  revision: number;
};

export type TaskSummary = {
  id: string;
  title: string;
  note: string;
  status: TaskStatus;
  waitReason: string;
  createdAt: number;
  updatedAt: number;
  statusChangedAt: number;
  /** 最近一次状态变化时的全局 revision，用于稳定排序与显示次序。 */
  statusRevision: number;
  endedAt: number | null;
  version: number;
  breakpointCount: number;
  latestBreakpoint: BreakpointSummary | null;
};

export type TaskDetail = {
  task: TaskSummary;
  breakpoints: Page<BreakpointRecord>;
  transitions: Page<TransitionRecord>;
};

export type ResumeSuggestion = {
  task: TaskSummary;
  pausedAt: number;
};

export type NextUpRef = {
  taskId: string;
  title: string;
};

export type WorkspaceSnapshot = {
  revision: number;
  currentTask: TaskSummary | null;
  counts: StatusCounts;
  /** 全部未结束任务，按状态排序规则稳定排列；已结束列表使用 listTasks 分页查询。 */
  unfinished: TaskSummary[];
  /** 最近进入 paused 的任务；waiting 不参与默认推荐。 */
  resume: ResumeSuggestion | null;
  nextUp: NextUpRef | null;
  nextUpVersion: number;
};

export type DailyReview = {
  dayKey: string;
  startUtc: number;
  endUtc: number;
  currentTask: TaskSummary | null;
  completedToday: Page<TaskSummary>;
  unfinished: TaskSummary[];
  counts: StatusCounts;
  nextUp: NextUpRef | null;
  nextUpVersion: number;
};

export type Draft = {
  title: string;
  note: string;
  version: number;
};

/* --------------------------------------------------------- 命令结果值 */

export type CreateTaskValue = {
  type: "createTask";
  taskId: string;
  /** 提交时按 draftVersion 清空了匹配的草稿。 */
  draftCleared: boolean;
};
export type UpdateTaskValue = {
  type: "updateTask";
  taskId: string;
  changed: boolean;
};
export type StartTaskValue = {
  type: "startTask";
  taskId: string;
  /** 目标已是当前任务时为 false：不产生重复开始。 */
  started: boolean;
  currentTaskId: string;
};
export type SwitchTaskValue = {
  type: "switchTask";
  fromTaskId: string;
  toTaskId: string;
  breakpointSeq: number | null;
  /** from 与 to 相同时为 false：自我切换不改变状态，也不追加断点。 */
  switched: boolean;
};
export type PauseTaskValue = {
  type: "pauseTask";
  taskId: string;
  breakpointSeq: number | null;
};
export type MarkWaitingValue = {
  type: "markWaiting";
  taskId: string;
  reasonUpdated: boolean;
};
export type ResolveWaitingValue = { type: "resolveWaiting"; taskId: string };
export type CompleteTaskValue = {
  type: "completeTask";
  taskId: string;
  wasCurrent: boolean;
  nextUpCleared: boolean;
};
export type CancelTaskValue = {
  type: "cancelTask";
  taskId: string;
  wasCurrent: boolean;
  nextUpCleared: boolean;
};
export type ReopenTaskValue = { type: "reopenTask"; taskId: string };
export type SaveBreakpointValue = {
  type: "saveBreakpoint";
  taskId: string;
  saved: boolean;
  breakpointSeq: number | null;
};
export type SetNextUpValue = {
  type: "setNextUp";
  taskId: string | null;
  changed: boolean;
};
export type FinishDailyReviewValue = {
  type: "finishDailyReview";
  outcome: "keep" | "pause";
  pausedTaskId: string | null;
  breakpointSeq: number | null;
};
export type SaveDraftValue = { type: "saveDraft"; draft: Draft };
export type ClearDraftValue = { type: "clearDraft"; draft: Draft };
export type UpdatePreferenceValue = {
  type: "updatePreference";
  preferences: PreferenceState;
};

export type WindowAction =
  "showMain" | "showCapture" | "hideCapture" | "hideWidget" | "quit";

export type WindowActionValue = { type: "window"; action: WindowAction };

export type DesktopState = {
  accelerator: string;
  acceleratorRegistered: boolean;
  launchAtLogin: boolean;
  launchAtLoginApplied: boolean;
  widgetVisible: boolean;
};

export type CommandValue =
  | CreateTaskValue
  | UpdateTaskValue
  | StartTaskValue
  | SwitchTaskValue
  | PauseTaskValue
  | MarkWaitingValue
  | ResolveWaitingValue
  | CompleteTaskValue
  | CancelTaskValue
  | ReopenTaskValue
  | SaveBreakpointValue
  | SetNextUpValue
  | FinishDailyReviewValue;

export type CommandType = CommandValue["type"];

export type CommandOutcome =
  | {
      status: "committed";
      commandId: string;
      commandType: CommandType;
      committedAt: number;
      revision: number;
      value: CommandValue;
    }
  | { status: "unknown" };

/* --------------------------------------------------------------- 渲染进程 API */

export type PickupAPI = {
  getWorkspaceSnapshot(): Promise<Result<WorkspaceSnapshot>>;
  listTasks(input: ListTasksInput): Promise<Result<Page<TaskSummary>>>;
  getTaskDetail(input: TaskDetailInput): Promise<Result<TaskDetail>>;
  getDailyReview(input?: GetDailyReviewQuery): Promise<Result<DailyReview>>;
  getCommandResult(input: CommandResultInput): Promise<Result<CommandOutcome>>;
  createTask(input: CreateTaskInput): Promise<Result<CreateTaskValue>>;
  updateTask(input: UpdateTaskInput): Promise<Result<UpdateTaskValue>>;
  startTask(input: StartTaskInput): Promise<Result<StartTaskValue>>;
  switchTask(input: SwitchTaskInput): Promise<Result<SwitchTaskValue>>;
  pauseTask(input: PauseTaskInput): Promise<Result<PauseTaskValue>>;
  markWaiting(input: MarkWaitingInput): Promise<Result<MarkWaitingValue>>;
  resolveWaiting(
    input: ResolveWaitingInput,
  ): Promise<Result<ResolveWaitingValue>>;
  completeTask(input: CompleteTaskInput): Promise<Result<CompleteTaskValue>>;
  cancelTask(input: CancelTaskInput): Promise<Result<CancelTaskValue>>;
  reopenTask(input: ReopenTaskInput): Promise<Result<ReopenTaskValue>>;
  saveBreakpoint(
    input: SaveBreakpointInput,
  ): Promise<Result<SaveBreakpointValue>>;
  setNextUp(input: SetNextUpInput): Promise<Result<SetNextUpValue>>;
  finishDailyReview(
    input: FinishDailyReviewInput,
  ): Promise<Result<FinishDailyReviewValue>>;
  getDraft(): Promise<Result<Draft>>;
  saveDraft(input: SaveDraftInput): Promise<Result<SaveDraftValue>>;
  clearDraft(input: ClearDraftInput): Promise<Result<ClearDraftValue>>;
  getPreferences(): Promise<Result<PreferenceState>>;
  updatePreference(
    input: UpdatePreferenceInput,
  ): Promise<Result<UpdatePreferenceValue>>;
  showMain(): Promise<Result<WindowActionValue>>;
  showCapture(): Promise<Result<WindowActionValue>>;
  hideCapture(): Promise<Result<WindowActionValue>>;
  hideWidget(): Promise<Result<WindowActionValue>>;
  quit(): Promise<Result<WindowActionValue>>;
  getDesktopState(): Promise<Result<DesktopState>>;
  onStateChanged(listener: (revision: number) => void): () => void;
  onDayInvalidated(listener: () => void): () => void;
  onCaptureShown(listener: () => void): () => void;
  onPrepareClose(handler: () => Promise<boolean>): () => void;
};
