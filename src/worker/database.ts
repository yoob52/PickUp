import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import migration from "./migrations/001.sql?raw";
import {
  createTaskSchema,
  type CreateTaskInput,
  type Snapshot,
  type Task,
} from "../shared/contracts";
export function openDatabase(path: string) {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = EXTRA");
  db.pragma("busy_timeout = 1000");
  const version = db.pragma("user_version", { simple: true });
  if (version !== 0 && version !== 1) {
    db.close();
    throw new Error("Unsupported schema");
  }
  if (version === 0)
    db.transaction(() => {
      db.exec(migration);
      db.pragma("user_version = 1");
    })();
  if (
    db.pragma("quick_check", { simple: true }) !== "ok" ||
    (db.pragma("foreign_key_check") as unknown[]).length
  ) {
    db.close();
    throw new Error("Database integrity check failed");
  }
  function snapshot(): Snapshot {
    return db.transaction(() => ({
      revision: (
        db.prepare("SELECT revision FROM app_state").get() as {
          revision: number;
        }
      ).revision,
      tasks: db
        .prepare(
          "SELECT id,title,note,status,created_at AS createdAt,version FROM tasks ORDER BY created_at,id",
        )
        .all() as Task[],
    }))();
  }
  const create = db.transaction((raw: CreateTaskInput) => {
    const input = createTaskSchema.parse(raw);
    const hash = createHash("sha256")
      .update(JSON.stringify([input.title, input.note]))
      .digest("hex");
    const prior = db
      .prepare(
        "SELECT payload_hash, result_json, revision FROM command_receipts WHERE command_id=?",
      )
      .get(input.commandId) as
      | { payload_hash: string; result_json: string; revision: number }
      | undefined;
    if (prior) {
      if (prior.payload_hash !== hash) throw new Error("COMMAND_ID_REUSED");
      return {
        value: JSON.parse(prior.result_json) as { taskId: string },
        revision: prior.revision,
      };
    }
    const now = Date.now(),
      id = randomUUID();
    db.prepare("UPDATE app_state SET revision=revision+1").run();
    const { revision } = db.prepare("SELECT revision FROM app_state").get() as {
      revision: number;
    };
    db.prepare(
      "INSERT INTO tasks(id,title,note,status,created_at,updated_at,status_changed_at,status_revision) VALUES(?,?,?,'todo',?,?,?,?)",
    ).run(id, input.title, input.note, now, now, now, revision);
    db.prepare(
      "INSERT INTO task_transitions(task_id,to_status,changed_at,revision) VALUES(?,'todo',?,?)",
    ).run(id, now, revision);
    const value = { taskId: id };
    db.prepare("INSERT INTO command_receipts VALUES(?,?,?,?,?,?)").run(
      input.commandId,
      "createTask",
      hash,
      JSON.stringify(value),
      now,
      revision,
    );
    return { value, revision };
  });
  return {
    snapshot,
    create,
    sqliteVersion: (
      db.prepare("SELECT sqlite_version() AS version").get() as {
        version: string;
      }
    ).version,
    close: () => db.close(),
  };
}
