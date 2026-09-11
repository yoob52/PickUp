import { createHash, randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import {
  DEFAULT_PREFERENCES,
  cancelTaskSchema,
  clearDraftSchema,
  completeTaskSchema,
  createTaskSchema,
  finishDailyReviewSchema,
  markWaitingSchema,
  pauseTaskSchema,
  preferencesSchema,
  reopenTaskSchema,
  resolveWaitingSchema,
  saveBreakpointSchema,
  saveDraftSchema,
  setNextUpSchema,
  startTaskSchema,
  switchTaskSchema,
  updatePreferenceSchema,
  updateTaskSchema,
  type BreakpointDraft,
  type CancelTaskValue,
  type ClearDraftValue,
  type CommandType,
  type CommandValue,
  type CompleteTaskValue,
  type CreateTaskValue,
  type Draft,
  type FinishDailyReviewValue,
  type MarkWaitingValue,
  type PauseTaskValue,
  type PreferenceState,
  type Preferences,
  type ReopenTaskValue,
  type ResolveWaitingValue,
  type SaveBreakpointValue,
  type SaveDraftValue,
  type SetNextUpValue,
  type StartTaskValue,
  type SwitchTaskValue,
  type UpdatePreferenceValue,
  type UpdateTaskValue,
} from "../shared/contracts";
import type { WorkerFaultStage } from "../shared/worker-protocol";
import { DomainError } from "./errors";
import {
  bumpRevision,
  insertTransition,
  readRevision,
  readTaskRow,
  type SqliteDatabase,
  type TaskRow,
} from "./rows";
import { canTransition, isEndedStatus, type TaskStatus } from "../shared/task";

export type AppStateRow = {
  revision: number;
  next_up_task_id: string | null;
  next_up_version: number;
  draft_title: string;
  draft_note: string;
  draft_version: number;
  preferences_json: string;
  preferences_version: number;
};

export function readAppState(db: SqliteDatabase): AppStateRow {
  return db
    .prepare(
      `SELECT revision, next_up_task_id, next_up_version, draft_title, draft_note,
              draft_version, preferences_json, preferences_version
       FROM app_state WHERE singleton = 1`,
    )
    .get() as AppStateRow;
}

const PREFERENCE_KEYS = Object.keys(
  DEFAULT_PREFERENCES,
) as (keyof Preferences)[];

/**
 * 存储中的偏好与默认值合并后再校验：初始值为 '{}' 表示全部使用默认值，
 * 未知字段被忽略，已知字段的非法值明确报错而不是静默重置。
 */
export function resolvePreferences(raw: string): Preferences {
  let stored: unknown;
  try {
    stored = JSON.parse(raw) as unknown;
  } catch {
    throw new DomainError(
      "STORAGE_ERROR",
      "本地设置数据无法解析，未做任何修改。请检查数据库文件。",
      false,
    );
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored))
    throw new DomainError(
      "STORAGE_ERROR",
      "本地设置数据格式异常，未做任何修改。请检查数据库文件。",
      false,
    );
  const merged: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  const record = stored as Record<string, unknown>;
  for (const key of PREFERENCE_KEYS)
    if (record[key] !== undefined) merged[key] = record[key];
  const parsed = preferencesSchema.safeParse(merged);
  if (!parsed.success)
    throw new DomainError(
      "STORAGE_ERROR",
      "本地设置数据不符合当前版本格式，未做任何修改。请检查数据库文件。",
      false,
    );
  return parsed.data;
}

export function parseInput<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw DomainError.validation(
      parsed.error.issues[0]?.message ?? "输入内容不符合要求，请检查后重试。",
    );
  return parsed.data;
}

/** 断点空白判定统一走 trim；空白提交不写库、不覆盖历史。 */
function normalizeBreakpoint(draft: BreakpointDraft): BreakpointDraft {
  return {
    progress: draft.progress.trim(),
    nextStep: draft.nextStep.trim(),
    referenceText: draft.referenceText.trim(),
  };
}

function isBlankBreakpoint(draft: BreakpointDraft): boolean {
  return (
    draft.progress.length === 0 &&
    draft.nextStep.length === 0 &&
    draft.referenceText.length === 0
  );
}

function breakpointHashFields(
  draft: BreakpointDraft | undefined,
): [string, string, string] | null {
  if (!draft) return null;
  const normalized = normalizeBreakpoint(draft);
  return [normalized.progress, normalized.nextStep, normalized.referenceText];
}

type TaskUpdate = {
  title?: string;
  note?: string;
  status?: "todo" | "doing" | "paused" | "waiting" | "done" | "cancelled";
  waitReason?: string;
  statusChangedAt?: number;
  statusRevision?: number;
  endedAt?: number | null;
};

/** 一次命令内每个受影响任务只递增一次 version；updated_at 同步刷新。 */
function touchTask(
  db: SqliteDatabase,
  taskId: string,
  update: TaskUpdate,
  now: number,
): void {
  const columns: [string, unknown][] = [["updated_at", now]];
  if (update.title !== undefined) columns.push(["title", update.title]);
  if (update.note !== undefined) columns.push(["note", update.note]);
  if (update.status !== undefined) columns.push(["status", update.status]);
  if (update.waitReason !== undefined)
    columns.push(["wait_reason", update.waitReason]);
  if (update.statusChangedAt !== undefined)
    columns.push(["status_changed_at", update.statusChangedAt]);
  if (update.statusRevision !== undefined)
    columns.push(["status_revision", update.statusRevision]);
  if (update.endedAt !== undefined) columns.push(["ended_at", update.endedAt]);
  const assignments = columns.map(([column]) => `${column} = ?`);
  assignments.push("version = version + 1");
  db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`).run(
    ...columns.map(([, value]) => value),
    taskId,
  );
}

function insertBreakpoint(
  db: SqliteDatabase,
  taskId: string,
  draft: BreakpointDraft,
  now: number,
): number {
  const result = db
    .prepare(
      `INSERT INTO breakpoints(task_id, progress, next_step, reference_text, saved_at)
       VALUES(?, ?, ?, ?, ?)`,
    )
    .run(taskId, draft.progress, draft.nextStep, draft.referenceText, now);
  return Number(result.lastInsertRowid);
}

export function createCommands(
  db: SqliteDatabase,
  faults: WorkerFaultStage[] = [],
) {
  const injectedFaults = new Set(faults);
  function injectFault(stage: WorkerFaultStage): void {
    if (!injectedFaults.delete(stage)) return;
    throw new Error(`injected-fault:${stage}`);
  }

  function payloadHash(type: CommandType, fields: unknown[]): string {
    return createHash("sha256")
      .update(JSON.stringify([type, ...fields]))
      .digest("hex");
  }

  function requireTask(taskId: string): TaskRow {
    const task = readTaskRow(db, taskId);
    if (!task) throw DomainError.notFound();
    return task;
  }

  function requireVersion(task: TaskRow, expectedVersion: number): void {
    if (task.version !== expectedVersion)
      throw DomainError.stateConflict(
        "这条任务已被其他窗口修改，请刷新后重试。",
      );
  }

  /** 状态转换规则的唯一来源是 shared 的 TASK_TRANSITIONS。 */
  function requireTransition(
    task: TaskRow,
    target: TaskStatus,
    hint: string,
  ): void {
    if (!canTransition(task.status, target))
      throw DomainError.stateConflict(hint);
  }

  function findCurrentTask(): TaskRow | undefined {
    return db
      .prepare(
        `SELECT id, title, note, status, wait_reason, created_at, updated_at,
                status_changed_at, status_revision, ended_at, version,
                (SELECT count(*) FROM breakpoints b WHERE b.task_id = t.id) AS breakpoint_count,
                (SELECT b.seq FROM breakpoints b WHERE b.task_id = t.id ORDER BY b.seq DESC LIMIT 1)
                  AS latest_breakpoint_seq
         FROM tasks t WHERE t.status = 'doing' LIMIT 1`,
      )
      .get() as TaskRow | undefined;
  }

  type Committed<T extends CommandValue> = { value: T; revision: number };

  /**
   * 已提交回执查找先于当前状态与版本检查：同 ID 同 payload 直接返回原结果，
   * 同 ID 不同内容或不同命令类型明确拒绝。
   */
  function findReceipt<T extends CommandValue>(
    commandId: string,
    type: CommandType,
    hash: string,
  ): Committed<T> | null {
    const row = db
      .prepare(
        `SELECT command_type, payload_hash, result_json, revision
         FROM command_receipts WHERE command_id = ?`,
      )
      .get(commandId) as
      | {
          command_type: string;
          payload_hash: string;
          result_json: string;
          revision: number;
        }
      | undefined;
    if (!row) return null;
    if (row.command_type !== type || row.payload_hash !== hash)
      throw DomainError.commandIdReused();
    return {
      value: JSON.parse(row.result_json) as T,
      revision: row.revision,
    };
  }

  function writeReceipt(
    commandId: string,
    type: CommandType,
    hash: string,
    value: CommandValue,
    now: number,
    revision: number,
  ): void {
    db.prepare(
      `INSERT INTO command_receipts(command_id, command_type, payload_hash, result_json, committed_at, revision)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(commandId, type, hash, JSON.stringify(value), now, revision);
  }

  /** 无副作用但需要幂等回执的命令（重复已提交命令、自我切换、空断点等）。 */
  function commitNoop<T extends CommandValue>(
    commandId: string,
    type: CommandType,
    hash: string,
    value: T,
    now: number,
  ): Committed<T> {
    const revision = readRevision(db);
    writeReceipt(commandId, type, hash, value, now, revision);
    return { value, revision };
  }

  function clearNextUpFor(taskId: string): boolean {
    const state = readAppState(db);
    if (state.next_up_task_id !== taskId) return false;
    db.prepare(
      `UPDATE app_state SET next_up_task_id = NULL, next_up_version = next_up_version + 1
       WHERE singleton = 1`,
    ).run();
    return true;
  }

  const createTaskTx = db.transaction(
    (raw: unknown): Committed<CreateTaskValue> => {
      const input = parseInput(createTaskSchema, raw);
      const type: CommandType = "createTask";
      const hash = payloadHash(type, [
        input.title,
        input.note,
        input.draftVersion ?? null,
      ]);
      const prior = findReceipt<CreateTaskValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const taskId = randomUUID();
      const revision = bumpRevision(db);
      db.prepare(
        `INSERT INTO tasks(id, title, note, status, created_at, updated_at, status_changed_at, status_revision)
       VALUES(?, ?, ?, 'todo', ?, ?, ?, ?)`,
      ).run(taskId, input.title, input.note, now, now, now, revision);
      insertTransition(db, taskId, null, "todo", now, revision);
      let draftCleared = false;
      if (input.draftVersion !== undefined) {
        const result = db
          .prepare(
            `UPDATE app_state SET draft_title = '', draft_note = '', draft_version = draft_version + 1
           WHERE singleton = 1 AND draft_version = ?`,
          )
          .run(input.draftVersion);
        draftCleared = result.changes === 1;
      }
      injectFault("create.beforeReceipt");
      const value: CreateTaskValue = { type, taskId, draftCleared };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const updateTaskTx = db.transaction(
    (raw: unknown): Committed<UpdateTaskValue> => {
      const input = parseInput(updateTaskSchema, raw);
      const type: CommandType = "updateTask";
      const hash = payloadHash(type, [
        input.taskId,
        input.expectedVersion,
        input.title,
        input.note ?? null,
      ]);
      const prior = findReceipt<UpdateTaskValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const task = requireTask(input.taskId);
      requireVersion(task, input.expectedVersion);
      if (isEndedStatus(task.status))
        throw DomainError.stateConflict(
          "已结束的事项不能编辑内容，请先重新打开。",
        );
      const changed =
        task.title !== input.title ||
        (input.note !== undefined && task.note !== input.note);
      if (!changed)
        return commitNoop(
          input.commandId,
          type,
          hash,
          { type, taskId: task.id, changed: false },
          now,
        );
      const revision = bumpRevision(db);
      touchTask(db, task.id, { title: input.title, note: input.note }, now);
      const value: UpdateTaskValue = { type, taskId: task.id, changed: true };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const startTaskTx = db.transaction(
    (raw: unknown): Committed<StartTaskValue> => {
      const input = parseInput(startTaskSchema, raw);
      const type: CommandType = "startTask";
      const hash = payloadHash(type, [
        input.task.taskId,
        input.task.expectedVersion,
      ]);
      const prior = findReceipt<StartTaskValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const task = requireTask(input.task.taskId);
      requireVersion(task, input.task.expectedVersion);
      if (task.status === "doing")
        return commitNoop(
          input.commandId,
          type,
          hash,
          { type, taskId: task.id, started: false, currentTaskId: task.id },
          now,
        );
      requireTransition(task, "doing", "已结束的事项需要先重新打开才能开始。");
      const current = findCurrentTask();
      if (current && current.id !== task.id) throw DomainError.needSwitch();
      const revision = bumpRevision(db);
      touchTask(
        db,
        task.id,
        { status: "doing", statusChangedAt: now, statusRevision: revision },
        now,
      );
      insertTransition(db, task.id, task.status, "doing", now, revision);
      const value: StartTaskValue = {
        type,
        taskId: task.id,
        started: true,
        currentTaskId: task.id,
      };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const switchTaskTx = db.transaction(
    (raw: unknown): Committed<SwitchTaskValue> => {
      const input = parseInput(switchTaskSchema, raw);
      const type: CommandType = "switchTask";
      const hash = payloadHash(type, [
        input.from.taskId,
        input.from.expectedVersion,
        input.to.taskId,
        input.to.expectedVersion,
        breakpointHashFields(input.breakpoint),
      ]);
      const prior = findReceipt<SwitchTaskValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const fromTask = requireTask(input.from.taskId);
      const toTask = requireTask(input.to.taskId);
      requireVersion(fromTask, input.from.expectedVersion);
      if (fromTask.id === toTask.id) {
        requireTransition(
          fromTask,
          "paused",
          "来源任务已不是当前任务，请刷新后重试。",
        );
        return commitNoop(
          input.commandId,
          type,
          hash,
          {
            type,
            fromTaskId: fromTask.id,
            toTaskId: toTask.id,
            breakpointSeq: null,
            switched: false,
          },
          now,
        );
      }
      requireTransition(
        fromTask,
        "paused",
        "来源任务已不是当前任务，请刷新后重试。",
      );
      requireVersion(toTask, input.to.expectedVersion);
      requireTransition(
        toTask,
        "doing",
        "目标任务已经结束，无法作为切换目标。",
      );
      const revision = bumpRevision(db);
      const breakpoint = input.breakpoint
        ? normalizeBreakpoint(input.breakpoint)
        : null;
      let breakpointSeq: number | null = null;
      if (breakpoint && !isBlankBreakpoint(breakpoint)) {
        breakpointSeq = insertBreakpoint(db, fromTask.id, breakpoint, now);
      }
      injectFault("switch.afterBreakpoint");
      touchTask(
        db,
        fromTask.id,
        { status: "paused", statusChangedAt: now, statusRevision: revision },
        now,
      );
      insertTransition(db, fromTask.id, "doing", "paused", now, revision);
      injectFault("switch.afterPause");
      touchTask(
        db,
        toTask.id,
        { status: "doing", statusChangedAt: now, statusRevision: revision },
        now,
      );
      insertTransition(db, toTask.id, toTask.status, "doing", now, revision);
      injectFault("switch.afterStart");
      injectFault("switch.beforeReceipt");
      const value: SwitchTaskValue = {
        type,
        fromTaskId: fromTask.id,
        toTaskId: toTask.id,
        breakpointSeq,
        switched: true,
      };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const pauseTaskTx = db.transaction(
    (raw: unknown): Committed<PauseTaskValue> => {
      const input = parseInput(pauseTaskSchema, raw);
      const type: CommandType = "pauseTask";
      const hash = payloadHash(type, [
        input.task.taskId,
        input.task.expectedVersion,
        breakpointHashFields(input.breakpoint),
      ]);
      const prior = findReceipt<PauseTaskValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const task = requireTask(input.task.taskId);
      requireVersion(task, input.task.expectedVersion);
      requireTransition(task, "paused", "该事项已不是当前任务，请刷新后重试。");
      const revision = bumpRevision(db);
      const breakpoint = input.breakpoint
        ? normalizeBreakpoint(input.breakpoint)
        : null;
      let breakpointSeq: number | null = null;
      if (breakpoint && !isBlankBreakpoint(breakpoint)) {
        breakpointSeq = insertBreakpoint(db, task.id, breakpoint, now);
      }
      touchTask(
        db,
        task.id,
        { status: "paused", statusChangedAt: now, statusRevision: revision },
        now,
      );
      insertTransition(db, task.id, "doing", "paused", now, revision);
      injectFault("pause.afterUpdate");
      const value: PauseTaskValue = { type, taskId: task.id, breakpointSeq };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const markWaitingTx = db.transaction(
    (raw: unknown): Committed<MarkWaitingValue> => {
      const input = parseInput(markWaitingSchema, raw);
      const type: CommandType = "markWaiting";
      const reason = input.reason.trim();
      const hash = payloadHash(type, [
        input.task.taskId,
        input.task.expectedVersion,
        reason,
      ]);
      const prior = findReceipt<MarkWaitingValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const task = requireTask(input.task.taskId);
      requireVersion(task, input.task.expectedVersion);
      if (task.status === "waiting") {
        if (reason === task.wait_reason)
          return commitNoop(
            input.commandId,
            type,
            hash,
            { type, taskId: task.id, reasonUpdated: false },
            now,
          );
        const revision = bumpRevision(db);
        touchTask(db, task.id, { waitReason: reason }, now);
        const value: MarkWaitingValue = {
          type,
          taskId: task.id,
          reasonUpdated: true,
        };
        writeReceipt(input.commandId, type, hash, value, now, revision);
        return { value, revision };
      }
      requireTransition(
        task,
        "waiting",
        "已结束的事项不能标记等待，请先重新打开。",
      );
      const revision = bumpRevision(db);
      touchTask(
        db,
        task.id,
        {
          status: "waiting",
          waitReason: reason,
          statusChangedAt: now,
          statusRevision: revision,
        },
        now,
      );
      insertTransition(db, task.id, task.status, "waiting", now, revision);
      const value: MarkWaitingValue = {
        type,
        taskId: task.id,
        reasonUpdated: true,
      };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const resolveWaitingTx = db.transaction(
    (raw: unknown): Committed<ResolveWaitingValue> => {
      const input = parseInput(resolveWaitingSchema, raw);
      const type: CommandType = "resolveWaiting";
      const hash = payloadHash(type, [
        input.task.taskId,
        input.task.expectedVersion,
      ]);
      const prior = findReceipt<ResolveWaitingValue>(
        input.commandId,
        type,
        hash,
      );
      if (prior) return prior;
      const now = Date.now();
      const task = requireTask(input.task.taskId);
      requireVersion(task, input.task.expectedVersion);
      // 命令来源前置条件：只有等待中的事项可以回到待处理。
      // 共享转换表允许 done/cancelled → todo（重新打开），不能替代本命令的来源校验。
      if (task.status !== "waiting")
        throw DomainError.stateConflict(
          "只有等待中的事项可以回到待处理，请刷新后重试。",
        );
      const revision = bumpRevision(db);
      touchTask(
        db,
        task.id,
        { status: "todo", statusChangedAt: now, statusRevision: revision },
        now,
      );
      insertTransition(db, task.id, "waiting", "todo", now, revision);
      const value: ResolveWaitingValue = { type, taskId: task.id };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  function createEndTaskTransaction(
    target: "done" | "cancelled",
    type: "completeTask" | "cancelTask",
  ) {
    return db.transaction(
      (raw: unknown): Committed<CompleteTaskValue | CancelTaskValue> => {
        const input = parseInput(
          target === "done" ? completeTaskSchema : cancelTaskSchema,
          raw,
        );
        const hash = payloadHash(type, [
          input.task.taskId,
          input.task.expectedVersion,
        ]);
        const prior = findReceipt<CompleteTaskValue | CancelTaskValue>(
          input.commandId,
          type,
          hash,
        );
        if (prior) return prior;
        const now = Date.now();
        const task = requireTask(input.task.taskId);
        requireVersion(task, input.task.expectedVersion);
        requireTransition(
          task,
          target,
          "该事项已经结束，请刷新后查看最新状态。",
        );
        const revision = bumpRevision(db);
        const wasCurrent = task.status === "doing";
        touchTask(
          db,
          task.id,
          {
            status: target,
            endedAt: now,
            statusChangedAt: now,
            statusRevision: revision,
          },
          now,
        );
        insertTransition(db, task.id, task.status, target, now, revision);
        const nextUpCleared = clearNextUpFor(task.id);
        const value = {
          type,
          taskId: task.id,
          wasCurrent,
          nextUpCleared,
        };
        writeReceipt(input.commandId, type, hash, value, now, revision);
        return { value, revision };
      },
    );
  }

  const completeTaskTx = createEndTaskTransaction("done", "completeTask");
  const cancelTaskTx = createEndTaskTransaction("cancelled", "cancelTask");

  const reopenTaskTx = db.transaction(
    (raw: unknown): Committed<ReopenTaskValue> => {
      const input = parseInput(reopenTaskSchema, raw);
      const type: CommandType = "reopenTask";
      const hash = payloadHash(type, [
        input.task.taskId,
        input.task.expectedVersion,
      ]);
      const prior = findReceipt<ReopenTaskValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const task = requireTask(input.task.taskId);
      requireVersion(task, input.task.expectedVersion);
      // 命令来源前置条件：只有已完成或已取消的事项可以重新打开。
      // 共享转换表同时允许 waiting → todo，不能替代本命令的来源校验。
      if (!isEndedStatus(task.status))
        throw DomainError.stateConflict("该事项尚未结束，无需重新打开。");
      const revision = bumpRevision(db);
      touchTask(
        db,
        task.id,
        {
          status: "todo",
          endedAt: null,
          statusChangedAt: now,
          statusRevision: revision,
        },
        now,
      );
      insertTransition(db, task.id, task.status, "todo", now, revision);
      const value: ReopenTaskValue = { type, taskId: task.id };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const saveBreakpointTx = db.transaction(
    (raw: unknown): Committed<SaveBreakpointValue> => {
      const input = parseInput(saveBreakpointSchema, raw);
      const type: CommandType = "saveBreakpoint";
      const normalized = normalizeBreakpoint(input.breakpoint);
      const hash = payloadHash(type, [
        input.task.taskId,
        input.task.expectedVersion,
        [normalized.progress, normalized.nextStep, normalized.referenceText],
      ]);
      const prior = findReceipt<SaveBreakpointValue>(
        input.commandId,
        type,
        hash,
      );
      if (prior) return prior;
      const now = Date.now();
      const task = requireTask(input.task.taskId);
      requireVersion(task, input.task.expectedVersion);
      if (isEndedStatus(task.status))
        throw DomainError.stateConflict(
          "已结束的事项不再追加断点，请先重新打开。",
        );
      if (isBlankBreakpoint(normalized))
        return commitNoop(
          input.commandId,
          type,
          hash,
          { type, taskId: task.id, saved: false, breakpointSeq: null },
          now,
        );
      const revision = bumpRevision(db);
      const breakpointSeq = insertBreakpoint(db, task.id, normalized, now);
      touchTask(db, task.id, {}, now);
      const value: SaveBreakpointValue = {
        type,
        taskId: task.id,
        saved: true,
        breakpointSeq,
      };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const setNextUpTx = db.transaction(
    (raw: unknown): Committed<SetNextUpValue> => {
      const input = parseInput(setNextUpSchema, raw);
      const type: CommandType = "setNextUp";
      const hash = payloadHash(type, [
        input.taskId,
        input.expectedNextUpVersion,
      ]);
      const prior = findReceipt<SetNextUpValue>(input.commandId, type, hash);
      if (prior) return prior;
      const now = Date.now();
      const state = readAppState(db);
      if (state.next_up_version !== input.expectedNextUpVersion)
        throw DomainError.stateConflict(
          "下次开工选择已被其他窗口修改，请刷新后重试。",
        );
      if (input.taskId === null) {
        if (state.next_up_task_id === null)
          return commitNoop(
            input.commandId,
            type,
            hash,
            { type, taskId: null, changed: false },
            now,
          );
        const revision = bumpRevision(db);
        db.prepare(
          `UPDATE app_state SET next_up_task_id = NULL, next_up_version = next_up_version + 1
         WHERE singleton = 1`,
        ).run();
        const value: SetNextUpValue = { type, taskId: null, changed: true };
        writeReceipt(input.commandId, type, hash, value, now, revision);
        return { value, revision };
      }
      const task = requireTask(input.taskId);
      if (isEndedStatus(task.status))
        throw DomainError.stateConflict(
          "已结束的事项不能作为下次开工的第一件事。",
        );
      if (state.next_up_task_id === task.id)
        return commitNoop(
          input.commandId,
          type,
          hash,
          { type, taskId: task.id, changed: false },
          now,
        );
      const revision = bumpRevision(db);
      db.prepare(
        `UPDATE app_state SET next_up_task_id = ?, next_up_version = next_up_version + 1
       WHERE singleton = 1`,
      ).run(task.id);
      const value: SetNextUpValue = { type, taskId: task.id, changed: true };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  const finishDailyReviewTx = db.transaction(
    (raw: unknown): Committed<FinishDailyReviewValue> => {
      const input = parseInput(finishDailyReviewSchema, raw);
      const type: CommandType = "finishDailyReview";
      const hash = payloadHash(type, [
        input.outcome,
        input.currentTask?.taskId ?? null,
        input.currentTask?.expectedVersion ?? null,
        breakpointHashFields(input.breakpoint),
      ]);
      const prior = findReceipt<FinishDailyReviewValue>(
        input.commandId,
        type,
        hash,
      );
      if (prior) return prior;
      const now = Date.now();
      const current = findCurrentTask();
      const seen = input.currentTask;
      if (input.outcome === "keep") {
        if (seen && !current)
          throw DomainError.stateConflict(
            "当前任务在收尾过程中已变化，请刷新收尾页面后重试。",
          );
        if (current && (!seen || seen.taskId !== current.id))
          throw DomainError.stateConflict(
            "当前任务在收尾过程中已变化，请刷新收尾页面后重试。",
          );
        if (current && seen && current.version !== seen.expectedVersion)
          throw DomainError.stateConflict(
            "当前任务已被其他窗口修改，请刷新收尾页面后重试。",
          );
        return commitNoop(
          input.commandId,
          type,
          hash,
          {
            type,
            outcome: "keep",
            pausedTaskId: null,
            breakpointSeq: null,
          },
          now,
        );
      }
      if (!current) {
        // 只有“收尾时与实际提交时都没有当前任务”才是无操作成功；
        // 收尾时看到过当前任务说明它已被其他调用暂停、完成、标记等待或切换，必须冲突。
        if (seen)
          throw DomainError.stateConflict(
            "当前任务在收尾过程中已变化，请刷新收尾页面后重试。",
          );
        return commitNoop(
          input.commandId,
          type,
          hash,
          {
            type,
            outcome: "pause",
            pausedTaskId: null,
            breakpointSeq: null,
          },
          now,
        );
      }
      if (!seen || seen.taskId !== current.id)
        throw DomainError.stateConflict(
          "当前任务在收尾过程中已变化，请刷新收尾页面后重试。",
        );
      if (current.version !== seen.expectedVersion)
        throw DomainError.stateConflict(
          "当前任务已被其他窗口修改，请刷新收尾页面后重试。",
        );
      const revision = bumpRevision(db);
      const breakpoint = input.breakpoint
        ? normalizeBreakpoint(input.breakpoint)
        : null;
      let breakpointSeq: number | null = null;
      if (breakpoint && !isBlankBreakpoint(breakpoint)) {
        breakpointSeq = insertBreakpoint(db, current.id, breakpoint, now);
      }
      touchTask(
        db,
        current.id,
        { status: "paused", statusChangedAt: now, statusRevision: revision },
        now,
      );
      insertTransition(db, current.id, "doing", "paused", now, revision);
      injectFault("finish.afterPause");
      const value: FinishDailyReviewValue = {
        type,
        outcome: "pause",
        pausedTaskId: current.id,
        breakpointSeq,
      };
      writeReceipt(input.commandId, type, hash, value, now, revision);
      return { value, revision };
    },
  );

  /* 草稿与偏好：可高频覆盖，采用版本条件更新，不逐键写命令回执。 */

  function readDraft(): Draft {
    const state = readAppState(db);
    return {
      title: state.draft_title,
      note: state.draft_note,
      version: state.draft_version,
    };
  }

  const saveDraftTx = db.transaction((raw: unknown): SaveDraftValue => {
    const input = parseInput(saveDraftSchema, raw);
    const state = readAppState(db);
    if (state.draft_version !== input.expectedDraftVersion)
      throw DomainError.stateConflict("草稿已更新，请重新载入后再保存。");
    if (state.draft_title === input.title && state.draft_note === input.note)
      return { type: "saveDraft", draft: readDraft() };
    db.prepare(
      `UPDATE app_state SET draft_title = ?, draft_note = ?, draft_version = draft_version + 1
       WHERE singleton = 1`,
    ).run(input.title, input.note);
    return { type: "saveDraft", draft: readDraft() };
  });

  const clearDraftTx = db.transaction((raw: unknown): ClearDraftValue => {
    const input = parseInput(clearDraftSchema, raw);
    const state = readAppState(db);
    if (state.draft_version !== input.expectedDraftVersion)
      throw DomainError.stateConflict("草稿已更新，请重新载入后再清空。");
    if (state.draft_title.length === 0 && state.draft_note.length === 0)
      return { type: "clearDraft", draft: readDraft() };
    db.prepare(
      `UPDATE app_state SET draft_title = '', draft_note = '', draft_version = draft_version + 1
       WHERE singleton = 1`,
    ).run();
    return { type: "clearDraft", draft: readDraft() };
  });

  function readPreferences(): PreferenceState {
    const state = readAppState(db);
    return {
      values: resolvePreferences(state.preferences_json),
      version: state.preferences_version,
    };
  }

  const updatePreferenceTx = db.transaction(
    (raw: unknown): UpdatePreferenceValue => {
      const input = parseInput(updatePreferenceSchema, raw);
      const state = readAppState(db);
      if (state.preferences_version !== input.expectedVersion)
        throw DomainError.stateConflict(
          "设置已在其他窗口更新，请重新载入后再保存。",
        );
      const current = readPreferences().values;
      const next: Preferences = { ...current, ...input.patch };
      const changed = (Object.keys(input.patch) as (keyof Preferences)[]).some(
        (key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]),
      );
      if (!changed)
        return { type: "updatePreference", preferences: readPreferences() };
      db.prepare(
        `UPDATE app_state SET preferences_json = ?, preferences_version = preferences_version + 1
         WHERE singleton = 1`,
      ).run(JSON.stringify(next));
      return { type: "updatePreference", preferences: readPreferences() };
    },
  );

  return {
    createTask: createTaskTx,
    updateTask: updateTaskTx,
    startTask: startTaskTx,
    switchTask: switchTaskTx,
    pauseTask: pauseTaskTx,
    markWaiting: markWaitingTx,
    resolveWaiting: resolveWaitingTx,
    completeTask: completeTaskTx,
    cancelTask: cancelTaskTx,
    reopenTask: reopenTaskTx,
    saveBreakpoint: saveBreakpointTx,
    setNextUp: setNextUpTx,
    finishDailyReview: finishDailyReviewTx,
    getDraft: readDraft,
    saveDraft: saveDraftTx,
    clearDraft: clearDraftTx,
    getPreferences: readPreferences,
    updatePreference: updatePreferenceTx,
  };
}
