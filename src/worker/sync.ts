import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { z } from "zod";
import { DomainError } from "./errors";
import { hlcSchema, receive, tick } from "./hlc";
import { bumpRevision, readRevision } from "./rows";
import type { SqliteDatabase } from "./sqlite";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const status = z.enum([
  "todo",
  "doing",
  "paused",
  "waiting",
  "done",
  "cancelled",
]);
const content = z.strictObject({
  title: z.string().refine((value) => value.trim().length > 0),
  note: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
});
const taskStatus = z
  .strictObject({
    status,
    wait_reason: z.string(),
    check_back_at: timestamp.nullable(),
    status_changed_at: timestamp,
    status_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ended_at: timestamp.nullable(),
    updated_at: timestamp,
  })
  .refine(
    (value) =>
      (value.status === "done" || value.status === "cancelled") ===
        (value.ended_at !== null) &&
      (value.check_back_at === null || value.status === "waiting"),
  );
const breakpoint = z
  .strictObject({
    task_id: z.uuid(),
    progress: z.string(),
    next_step: z.string(),
    reference_text: z.string(),
    saved_at: timestamp,
  })
  .refine(
    (value) =>
      (value.progress + value.next_step + value.reference_text).trim().length >
      0,
  );
const transition = z.strictObject({
  task_id: z.uuid(),
  from_status: status.nullable(),
  to_status: status,
  changed_at: timestamp,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const common = { id: z.uuid(), hlc: hlcSchema, entityId: z.uuid() };
export const syncChangeSchema = z.discriminatedUnion("entity", [
  z.strictObject({
    ...common,
    entity: z.literal("task-content"),
    payload: content,
  }),
  z.strictObject({
    ...common,
    entity: z.literal("task-status"),
    payload: taskStatus,
  }),
  z.strictObject({
    ...common,
    entity: z.literal("breakpoint"),
    payload: breakpoint,
  }),
  z.strictObject({
    ...common,
    entity: z.literal("transition"),
    payload: transition,
  }),
  z.strictObject({
    ...common,
    entityId: z.literal("singleton"),
    entity: z.literal("next-up"),
    payload: z.strictObject({ taskId: z.uuid().nullable() }),
  }),
]);
export type SyncChange = z.infer<typeof syncChangeSchema>;
type Entity = SyncChange["entity"];
type ChangeRow = {
  seq: number;
  id: string;
  hlc: string;
  entity: Entity;
  entity_id: string;
  payload: string;
};
type Device = { id: string; last_hlc: string | null };

function nextClock(db: SqliteDatabase, now: number, remote?: string): string {
  const device = db
    .prepare("SELECT id, last_hlc FROM sync_device WHERE singleton = 1")
    .get() as Device;
  const hlc =
    remote === undefined
      ? tick(device.last_hlc, device.id, now)
      : receive(device.last_hlc, remote, device.id, now);
  db.prepare("UPDATE sync_device SET last_hlc = ? WHERE singleton = 1").run(
    hlc,
  );
  return hlc;
}

function decodeRow(row: ChangeRow): SyncChange {
  return {
    id: row.id,
    hlc: row.hlc,
    entity: row.entity,
    entityId: row.entity_id,
    payload: JSON.parse(row.payload),
  } as SyncChange;
}

function insertChange(
  db: SqliteDatabase,
  change: SyncChange,
  now: number,
): void {
  db.prepare(
    "INSERT INTO sync_changes(id, hlc, entity, entity_id, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  ).run(
    change.id,
    change.hlc,
    change.entity,
    change.entityId,
    JSON.stringify(change.payload),
    now,
  );
}

export function initializeSync(db: SqliteDatabase): void {
  db.prepare("INSERT INTO sync_device(singleton, id) VALUES(1, ?)").run(
    globalThis.crypto.randomUUID(),
  );
  for (const table of ["breakpoints", "task_transitions"] as const) {
    for (const row of db
      .prepare(`SELECT seq FROM ${table} ORDER BY seq`)
      .all() as { seq: number }[])
      db.prepare(`UPDATE ${table} SET id = ? WHERE seq = ?`).run(
        globalThis.crypto.randomUUID(),
        row.seq,
      );
  }
  db.exec(`INSERT OR IGNORE INTO sync_dirty SELECT 'task-content', id FROM tasks;
    INSERT OR IGNORE INTO sync_dirty SELECT 'task-status', id FROM tasks;
    INSERT OR IGNORE INTO sync_dirty SELECT 'breakpoint', CAST(seq AS TEXT) FROM breakpoints;
    INSERT OR IGNORE INTO sync_dirty SELECT 'transition', CAST(seq AS TEXT) FROM task_transitions;
    INSERT OR IGNORE INTO sync_dirty SELECT 'next-up', 'singleton' FROM app_state WHERE next_up_task_id IS NOT NULL;`);
  recordLocalChanges(db, Date.now());
}

/** Called inside the business transaction, before its receipt is committed. */
export function recordLocalChanges(db: SqliteDatabase, now: number): void {
  flushLocalChanges(db, now);
  materializeDoing(db, now);
  materializeNextUp(db);
  db.exec("DELETE FROM sync_dirty");
}

function flushLocalChanges(db: SqliteDatabase, now: number): void {
  const dirty = db
    .prepare(
      `SELECT entity, entity_id FROM sync_dirty ORDER BY entity,
    CASE WHEN entity IN ('breakpoint','transition') THEN CAST(entity_id AS INTEGER) ELSE 0 END, entity_id`,
    )
    .all() as { entity: Entity; entity_id: string }[];
  for (const item of dirty) {
    const hlc = nextClock(db, now);
    let payload: SyncChange["payload"];
    let entityId = item.entity_id;
    switch (item.entity) {
      case "task-content":
        payload = db
          .prepare(
            "SELECT title, note, created_at, updated_at FROM tasks WHERE id = ?",
          )
          .get(entityId) as z.infer<typeof content>;
        db.prepare("UPDATE tasks SET content_hlc = ? WHERE id = ?").run(
          hlc,
          entityId,
        );
        break;
      case "task-status":
        payload = db
          .prepare(
            "SELECT status, wait_reason, check_back_at, status_changed_at, status_revision, ended_at, updated_at FROM tasks WHERE id = ?",
          )
          .get(entityId) as z.infer<typeof taskStatus>;
        db.prepare("UPDATE tasks SET status_hlc = ? WHERE id = ?").run(
          hlc,
          entityId,
        );
        break;
      case "breakpoint":
      case "transition": {
        const table =
          item.entity === "breakpoint" ? "breakpoints" : "task_transitions";
        const row = db
          .prepare(`SELECT id FROM ${table} WHERE seq = ?`)
          .get(Number(entityId)) as { id: string | null };
        const id = row.id ?? globalThis.crypto.randomUUID();
        db.prepare(`UPDATE ${table} SET id = ?, hlc = ? WHERE seq = ?`).run(
          id,
          hlc,
          Number(entityId),
        );
        const columns =
          item.entity === "breakpoint"
            ? "task_id, progress, next_step, reference_text, saved_at"
            : "task_id, from_status, to_status, changed_at, revision";
        payload = db
          .prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`)
          .get(id) as SyncChange["payload"];
        entityId = id;
        break;
      }
      case "next-up": {
        const state = db
          .prepare("SELECT next_up_task_id FROM app_state WHERE singleton = 1")
          .get() as { next_up_task_id: string | null };
        payload = { taskId: state.next_up_task_id };
        db.prepare(
          "UPDATE app_state SET next_up_hlc = ? WHERE singleton = 1",
        ).run(hlc);
        break;
      }
    }
    insertChange(
      db,
      {
        id: globalThis.crypto.randomUUID(),
        hlc,
        entity: item.entity,
        entityId,
        payload,
      } as SyncChange,
      now,
    );
  }
  db.exec("DELETE FROM sync_dirty");
}

/** The cursor is a local append sequence, never an HLC watermark. */
export function listChangesSince(
  db: SqliteDatabase,
  cursor = 0,
  limit = 200,
): { changes: SyncChange[]; cursor: number } {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw DomainError.validation("同步游标或分页大小无效。");
  const rows = db
    .prepare(
      "SELECT seq, id, hlc, entity, entity_id, payload FROM sync_changes WHERE seq > ? ORDER BY seq LIMIT ?",
    )
    .all(cursor, limit) as ChangeRow[];
  return { changes: rows.map(decodeRow), cursor: rows.at(-1)?.seq ?? cursor };
}

function latest(
  db: SqliteDatabase,
  entity: Entity,
  id: string,
): SyncChange | undefined {
  const row = db
    .prepare(
      "SELECT id, hlc, entity, entity_id, payload FROM sync_changes WHERE entity = ? AND entity_id = ? ORDER BY hlc DESC, id DESC LIMIT 1",
    )
    .get(entity, id) as ChangeRow | undefined;
  return row === undefined ? undefined : decodeRow(row);
}

function materializeTasks(db: SqliteDatabase, ids: Set<string>): void {
  for (const id of ids) {
    const title = latest(db, "task-content", id) as
      Extract<SyncChange, { entity: "task-content" }> | undefined;
    const state = latest(db, "task-status", id) as
      Extract<SyncChange, { entity: "task-status" }> | undefined;
    if (!title || !state) continue;
    const prior = db
      .prepare(
        "SELECT content_hlc, status_hlc, updated_at, status FROM tasks WHERE id = ?",
      )
      .get(id) as
      | {
          content_hlc: string;
          status_hlc: string;
          updated_at: number;
          status: string;
        }
      | undefined;
    const { updated_at: updatedAt } = db
      .prepare(
        `SELECT max(value) AS updated_at FROM (
      SELECT CAST(json_extract(payload, '$.updated_at') AS INTEGER) AS value FROM sync_changes
        WHERE entity_id = ? AND entity IN ('task-content','task-status')
      UNION ALL SELECT CAST(json_extract(payload, '$.saved_at') AS INTEGER) FROM sync_changes
        WHERE entity = 'breakpoint' AND json_extract(payload, '$.task_id') = ?
    )`,
      )
      .get(id, id) as { updated_at: number };
    if (
      prior?.content_hlc === title.hlc &&
      prior.status_hlc === state.hlc &&
      prior.status === state.payload.status
    ) {
      if (prior.updated_at !== updatedAt)
        db.prepare(
          "UPDATE tasks SET updated_at = ?, version = version + 1 WHERE id = ?",
        ).run(updatedAt, id);
      continue;
    }
    const c = title.payload;
    const s = state.payload;
    db.prepare(
      `INSERT INTO tasks(id, title, note, created_at, updated_at, content_hlc, status_hlc,
      status, wait_reason, check_back_at, status_changed_at, status_revision, ended_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, note=excluded.note, created_at=excluded.created_at,
      updated_at=excluded.updated_at, content_hlc=excluded.content_hlc, status_hlc=excluded.status_hlc,
      status=excluded.status, wait_reason=excluded.wait_reason, check_back_at=excluded.check_back_at,
      status_changed_at=excluded.status_changed_at, status_revision=excluded.status_revision,
      ended_at=excluded.ended_at, version=tasks.version + 1`,
    ).run(
      id,
      c.title,
      c.note,
      c.created_at,
      updatedAt,
      title.hlc,
      state.hlc,
      s.status,
      s.wait_reason,
      s.check_back_at,
      s.status_changed_at,
      s.status_revision,
      s.ended_at,
    );
  }
}

function materializeAppendOnly(db: SqliteDatabase, ids: Set<string>): void {
  for (const id of ids) {
    if (!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id)) continue;
    const rows = db
      .prepare(
        `SELECT id, hlc, entity, entity_id, payload FROM sync_changes
      WHERE entity IN ('breakpoint','transition') AND json_extract(payload, '$.task_id') = ? ORDER BY hlc, id`,
      )
      .all(id) as ChangeRow[];
    for (const row of rows) {
      const change = decodeRow(row) as Extract<
        SyncChange,
        { entity: "breakpoint" | "transition" }
      >;
      if (change.entity === "breakpoint") {
        const p = change.payload;
        const result = db
          .prepare(
            "INSERT OR IGNORE INTO breakpoints(id, hlc, task_id, progress, next_step, reference_text, saved_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            change.entityId,
            change.hlc,
            p.task_id,
            p.progress,
            p.next_step,
            p.reference_text,
            p.saved_at,
          );
        if (result.changes)
          db.prepare(
            "UPDATE tasks SET updated_at = max(updated_at, ?), version = version + 1 WHERE id = ?",
          ).run(p.saved_at, p.task_id);
      } else {
        const p = change.payload;
        db.prepare(
          "INSERT OR IGNORE INTO task_transitions(id, hlc, task_id, from_status, to_status, changed_at, revision) VALUES(?, ?, ?, ?, ?, ?, ?)",
        ).run(
          change.entityId,
          change.hlc,
          p.task_id,
          p.from_status,
          p.to_status,
          p.changed_at,
          p.revision,
        );
      }
    }
  }
}

function materializeNextUp(db: SqliteDatabase): void {
  const change = latest(db, "next-up", "singleton") as
    Extract<SyncChange, { entity: "next-up" }> | undefined;
  if (!change) return;
  const task =
    change.payload.taskId === null
      ? undefined
      : (db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(change.payload.taskId) as { status: string } | undefined);
  const invalid =
    task !== undefined &&
    ["done", "cancelled", "waiting"].includes(task.status);
  const id = task && !invalid ? change.payload.taskId : null;
  db.prepare(
    `UPDATE app_state SET next_up_task_id = ?, next_up_hlc = ?, next_up_version = next_up_version + 1
    WHERE singleton = 1 AND (next_up_task_id IS NOT ? OR next_up_hlc != ?)`,
  ).run(id, change.hlc, id, change.hlc);
}

function materializeDoing(db: SqliteDatabase, now: number): void {
  db.exec("DROP INDEX ux_one_doing");
  const ids = new Set(
    (
      db
        .prepare(
          "SELECT DISTINCT entity_id FROM sync_changes WHERE entity IN ('task-content','task-status')",
        )
        .all() as { entity_id: string }[]
    ).map((row) => row.entity_id),
  );
  materializeTasks(db, ids);
  materializeAppendOnly(db, ids);
  const doing = db
    .prepare(
      "SELECT id, status_hlc, status_changed_at, status_revision FROM tasks WHERE status = 'doing' ORDER BY status_changed_at DESC, status_hlc DESC, id ASC",
    )
    .all() as {
    id: string;
    status_hlc: string;
    status_changed_at: number;
    status_revision: number;
  }[];
  const winner = doing[0];
  for (const loser of doing.slice(1)) {
    db.prepare(
      "UPDATE tasks SET status = 'paused', status_changed_at = ?, status_revision = ?, version = version + 1 WHERE id = ?",
    ).run(winner.status_changed_at, winner.status_revision, loser.id);
    const hash = bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify([
            "doing-conflict",
            loser.id,
            loser.status_hlc,
            winner.id,
            winner.status_hlc,
          ]),
        ),
      ),
    );
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const payload = {
      task_id: loser.id,
      from_status: "doing" as const,
      to_status: "paused" as const,
      changed_at: winner.status_changed_at,
      revision: winner.status_revision,
    };
    if (!db.prepare("SELECT 1 FROM sync_changes WHERE id = ?").get(id))
      insertChange(
        db,
        {
          id,
          entityId: id,
          entity: "transition",
          hlc: winner.status_hlc,
          payload,
        },
        now,
      );
    db.prepare(
      "INSERT OR IGNORE INTO task_transitions(id,hlc,task_id,from_status,to_status,changed_at,revision) VALUES(?, ?, ?, 'doing','paused',?,?)",
    ).run(
      id,
      winner.status_hlc,
      loser.id,
      payload.changed_at,
      payload.revision,
    );
  }
  db.exec("DELETE FROM sync_dirty");
  db.exec(
    "CREATE UNIQUE INDEX ux_one_doing ON tasks(status) WHERE status = 'doing'",
  );
}

export function applyRemoteChanges(
  db: SqliteDatabase,
  input: unknown,
): { applied: number; revision: number } {
  const parsed = z.array(syncChangeSchema).safeParse(input);
  if (!parsed.success)
    throw DomainError.validation("同步变更格式无效，未做任何修改。");
  return db.transaction(() => {
    const now = Date.now();
    let applied = 0;
    let newest: string | undefined;
    for (const change of parsed.data) {
      const prior = db
        .prepare(
          "SELECT id, hlc, entity, entity_id, payload FROM sync_changes WHERE id = ?",
        )
        .get(change.id) as ChangeRow | undefined;
      if (prior) {
        if (
          prior.hlc !== change.hlc ||
          prior.entity !== change.entity ||
          prior.entity_id !== change.entityId ||
          prior.payload !== JSON.stringify(change.payload)
        )
          throw DomainError.validation("同步变更标识被重复用于不同内容。");
        continue;
      }
      const existing = db
        .prepare(
          `SELECT payload, hlc FROM sync_changes WHERE entity = ? AND entity_id = ?
        AND (hlc = ? OR entity IN ('breakpoint','transition')) LIMIT 1`,
        )
        .get(change.entity, change.entityId, change.hlc) as
        { payload: string; hlc: string } | undefined;
      if (
        existing &&
        (existing.payload !== JSON.stringify(change.payload) ||
          ((change.entity === "breakpoint" || change.entity === "transition") &&
            existing.hlc !== change.hlc))
      )
        throw DomainError.validation("同步记录的不可变标识或时钟冲突。");
      insertChange(db, change, now);
      if (newest === undefined || newest < change.hlc) newest = change.hlc;
      applied++;
    }
    if (newest === undefined) return { applied: 0, revision: readRevision(db) };
    nextClock(db, now, newest);
    const revision = bumpRevision(db);
    materializeDoing(db, now);
    materializeNextUp(db);
    db.exec("DELETE FROM sync_dirty");
    return { applied, revision };
  })();
}
