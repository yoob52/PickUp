import type Database from "better-sqlite3";
import type { BreakpointSummary, TaskSummary } from "../shared/contracts";
import type { TaskStatus } from "../shared/task";

export type SqliteDatabase = Database.Database;

export type TaskRow = {
  id: string;
  title: string;
  note: string;
  status: TaskStatus;
  wait_reason: string;
  created_at: number;
  updated_at: number;
  status_changed_at: number;
  status_revision: number;
  ended_at: number | null;
  version: number;
  breakpoint_count: number;
  latest_breakpoint_seq: number | null;
};

export const TASK_COLUMNS = `
  t.id AS id,
  t.title AS title,
  t.note AS note,
  t.status AS status,
  t.wait_reason AS wait_reason,
  t.created_at AS created_at,
  t.updated_at AS updated_at,
  t.status_changed_at AS status_changed_at,
  t.status_revision AS status_revision,
  t.ended_at AS ended_at,
  t.version AS version,
  (SELECT count(*) FROM breakpoints b WHERE b.task_id = t.id) AS breakpoint_count,
  (SELECT b.seq FROM breakpoints b WHERE b.task_id = t.id ORDER BY b.seq DESC LIMIT 1)
    AS latest_breakpoint_seq`;

/**
 * 统一稳定排序：todo 按 created_at ASC、id ASC；doing/paused/waiting 按
 * status_changed_at DESC、status_revision DESC、id ASC；已结束按 ended_at DESC、
 * status_revision DESC、id ASC。混合状态查询沿用同一表达式（见 IPC 契约说明）。
 */
export const TASK_ORDER_BY = `
  CASE WHEN t.status = 'todo' THEN t.created_at
       ELSE -COALESCE(t.ended_at, t.status_changed_at) END ASC,
  CASE WHEN t.status = 'todo' THEN 0 ELSE t.status_revision END DESC,
  t.id ASC`;

export type BreakpointRow = {
  seq: number;
  task_id: string;
  progress: string;
  next_step: string;
  reference_text: string;
  saved_at: number;
};

export function loadBreakpointSummaries(
  db: SqliteDatabase,
  taskRows: TaskRow[],
): Map<number, BreakpointSummary> {
  const seqs = taskRows
    .map((row) => row.latest_breakpoint_seq)
    .filter((seq): seq is number => seq !== null);
  const summaries = new Map<number, BreakpointSummary>();
  if (seqs.length === 0) return summaries;
  const placeholders = seqs.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT seq, progress, next_step, saved_at FROM breakpoints WHERE seq IN (${placeholders})`,
    )
    .all(...seqs) as {
    seq: number;
    progress: string;
    next_step: string;
    saved_at: number;
  }[];
  for (const row of rows)
    summaries.set(row.seq, {
      seq: row.seq,
      progress: row.progress,
      nextStep: row.next_step,
      savedAt: row.saved_at,
    });
  return summaries;
}

export function mapTaskSummaries(
  db: SqliteDatabase,
  rows: TaskRow[],
): TaskSummary[] {
  const summaries = loadBreakpointSummaries(db, rows);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status,
    waitReason: row.wait_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
    statusRevision: row.status_revision,
    endedAt: row.ended_at,
    version: row.version,
    breakpointCount: row.breakpoint_count,
    latestBreakpoint:
      row.latest_breakpoint_seq === null
        ? null
        : (summaries.get(row.latest_breakpoint_seq) ?? null),
  }));
}

export function selectTaskRows(
  db: SqliteDatabase,
  where: string,
  parameters: unknown[] = [],
  limit?: number,
): TaskRow[] {
  const suffix = limit === undefined ? "" : ` LIMIT ${limit}`;
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks t WHERE ${where} ORDER BY ${TASK_ORDER_BY}${suffix}`,
    )
    .all(...parameters) as TaskRow[];
}

export function selectTaskRowsPaged(
  db: SqliteDatabase,
  where: string,
  parameters: unknown[],
  limit: number,
  offset: number,
): TaskRow[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks t WHERE ${where} ORDER BY ${TASK_ORDER_BY} LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset) as TaskRow[];
}

export function readTaskRow(
  db: SqliteDatabase,
  taskId: string,
): TaskRow | undefined {
  return db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ?`)
    .get(taskId) as TaskRow | undefined;
}

export function countTasks(
  db: SqliteDatabase,
  where: string,
  parameters: unknown[] = [],
): number {
  return (
    db
      .prepare(`SELECT count(*) AS total FROM tasks t WHERE ${where}`)
      .get(...parameters) as { total: number }
  ).total;
}

export function readRevision(db: SqliteDatabase): number {
  return (
    db.prepare("SELECT revision FROM app_state WHERE singleton = 1").get() as {
      revision: number;
    }
  ).revision;
}

export function bumpRevision(db: SqliteDatabase): number {
  db.prepare(
    "UPDATE app_state SET revision = revision + 1 WHERE singleton = 1",
  ).run();
  return readRevision(db);
}

export function insertTransition(
  db: SqliteDatabase,
  taskId: string,
  fromStatus: TaskStatus | null,
  toStatus: TaskStatus,
  changedAt: number,
  revision: number,
): void {
  db.prepare(
    `INSERT INTO task_transitions(task_id, from_status, to_status, changed_at, revision)
     VALUES(?, ?, ?, ?, ?)`,
  ).run(taskId, fromStatus, toStatus, changedAt, revision);
}
