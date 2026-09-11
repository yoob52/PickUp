import type {
  BreakpointRecord,
  CommandOutcome,
  CommandType,
  CommandValue,
  DailyReview,
  DailyReviewInput,
  ListTasksInput,
  Page,
  TaskDetail,
  TaskDetailInput,
  TaskSummary,
  TransitionRecord,
  WorkspaceSnapshot,
} from "../shared/contracts";
import { emptyCounts, isEndedStatus, type TaskStatus } from "../shared/task";
import { readAppState } from "./commands";
import { DomainError } from "./errors";
import {
  countTasks,
  mapTaskSummaries,
  readRevision,
  readTaskRow,
  selectTaskRows,
  selectTaskRowsPaged,
  type SqliteDatabase,
} from "./rows";

const UNFINISHED_PREDICATE = "t.status NOT IN ('done','cancelled')";

function statusPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function readCounts(db: SqliteDatabase) {
  const counts = emptyCounts();
  const rows = db
    .prepare("SELECT status, count(*) AS total FROM tasks GROUP BY status")
    .all() as { status: TaskStatus; total: number }[];
  for (const row of rows) counts[row.status] = row.total;
  counts.unfinished =
    counts.todo + counts.doing + counts.paused + counts.waiting;
  return counts;
}

function readNextUp(db: SqliteDatabase, nextUpTaskId: string | null) {
  if (!nextUpTaskId) return null;
  const row = readTaskRow(db, nextUpTaskId);
  if (!row || isEndedStatus(row.status)) return null;
  return { taskId: row.id, title: row.title };
}

function readAllSummaries(
  db: SqliteDatabase,
  where: string,
  parameters: unknown[] = [],
): TaskSummary[] {
  return mapTaskSummaries(db, selectTaskRows(db, where, parameters));
}

function breakpointPage(
  db: SqliteDatabase,
  taskId: string,
  offset: number,
  limit: number,
): Page<BreakpointRecord> {
  const total = (
    db
      .prepare("SELECT count(*) AS total FROM breakpoints WHERE task_id = ?")
      .get(taskId) as { total: number }
  ).total;
  const rows = db
    .prepare(
      `SELECT seq, task_id, progress, next_step, reference_text, saved_at
       FROM breakpoints WHERE task_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
    )
    .all(taskId, limit, offset) as {
    seq: number;
    task_id: string;
    progress: string;
    next_step: string;
    reference_text: string;
    saved_at: number;
  }[];
  return {
    items: rows.map((row) => ({
      seq: row.seq,
      taskId: row.task_id,
      progress: row.progress,
      nextStep: row.next_step,
      referenceText: row.reference_text,
      savedAt: row.saved_at,
    })),
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
  };
}

function transitionPage(
  db: SqliteDatabase,
  taskId: string,
  offset: number,
  limit: number,
): Page<TransitionRecord> {
  const total = (
    db
      .prepare(
        "SELECT count(*) AS total FROM task_transitions WHERE task_id = ?",
      )
      .get(taskId) as { total: number }
  ).total;
  const rows = db
    .prepare(
      `SELECT seq, from_status, to_status, changed_at, revision
       FROM task_transitions WHERE task_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
    )
    .all(taskId, limit, offset) as {
    seq: number;
    from_status: TaskStatus | null;
    to_status: TaskStatus;
    changed_at: number;
    revision: number;
  }[];
  return {
    items: rows.map((row) => ({
      seq: row.seq,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      changedAt: row.changed_at,
      revision: row.revision,
    })),
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
  };
}

export function createQueries(db: SqliteDatabase) {
  const workspaceSnapshot = db.transaction((): WorkspaceSnapshot => {
    const revision = readRevision(db);
    const unfinished = readAllSummaries(db, UNFINISHED_PREDICATE);
    const resumeRow = selectTaskRows(db, "t.status = 'paused'", [], 1)[0];
    const resumeSummary = resumeRow
      ? mapTaskSummaries(db, [resumeRow])[0]
      : undefined;
    const state = readAppState(db);
    return {
      revision,
      currentTask: unfinished.find((task) => task.status === "doing") ?? null,
      counts: readCounts(db),
      unfinished,
      resume:
        resumeRow && resumeSummary
          ? { task: resumeSummary, pausedAt: resumeRow.status_changed_at }
          : null,
      nextUp: readNextUp(db, state.next_up_task_id),
      nextUpVersion: state.next_up_version,
    };
  });

  const listTasks = db.transaction(
    (input: ListTasksInput): Page<TaskSummary> => {
      const where = `t.status IN (${statusPlaceholders(input.statuses.length)})`;
      const total = countTasks(db, where, input.statuses);
      const rows = selectTaskRowsPaged(
        db,
        where,
        input.statuses,
        input.limit,
        input.offset,
      );
      return {
        items: mapTaskSummaries(db, rows),
        total,
        offset: input.offset,
        limit: input.limit,
        hasMore: input.offset + rows.length < total,
      };
    },
  );

  const taskDetail = db.transaction((input: TaskDetailInput): TaskDetail => {
    const row = readTaskRow(db, input.taskId);
    if (!row) throw DomainError.notFound();
    return {
      task: mapTaskSummaries(db, [row])[0],
      breakpoints: breakpointPage(
        db,
        input.taskId,
        input.breakpointOffset,
        input.breakpointLimit,
      ),
      transitions: transitionPage(
        db,
        input.taskId,
        input.transitionOffset,
        input.transitionLimit,
      ),
    };
  });

  const dailyReview = db.transaction((input: DailyReviewInput): DailyReview => {
    const where = "t.status = 'done' AND t.ended_at >= ? AND t.ended_at < ?";
    const parameters = [input.startUtc, input.endUtc];
    const total = countTasks(db, where, parameters);
    const completedRows = selectTaskRowsPaged(
      db,
      where,
      parameters,
      input.completedLimit,
      0,
    );
    const unfinished = readAllSummaries(db, UNFINISHED_PREDICATE);
    const state = readAppState(db);
    return {
      dayKey: input.dayKey,
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      currentTask: unfinished.find((task) => task.status === "doing") ?? null,
      completedToday: {
        items: mapTaskSummaries(db, completedRows),
        total,
        offset: 0,
        limit: input.completedLimit,
        hasMore: completedRows.length < total,
      },
      unfinished,
      counts: readCounts(db),
      nextUp: readNextUp(db, state.next_up_task_id),
      nextUpVersion: state.next_up_version,
    };
  });

  const commandOutcome = (commandId: string): CommandOutcome => {
    const row = db
      .prepare(
        `SELECT command_type, result_json, committed_at, revision
         FROM command_receipts WHERE command_id = ?`,
      )
      .get(commandId) as
      | {
          command_type: string;
          result_json: string;
          committed_at: number;
          revision: number;
        }
      | undefined;
    if (!row) return { status: "unknown" };
    return {
      status: "committed",
      commandId,
      commandType: row.command_type as CommandType,
      committedAt: row.committed_at,
      revision: row.revision,
      value: JSON.parse(row.result_json) as CommandValue,
    };
  };

  return {
    revision: () => readRevision(db),
    workspaceSnapshot,
    listTasks,
    taskDetail,
    dailyReview,
    commandOutcome,
  };
}
