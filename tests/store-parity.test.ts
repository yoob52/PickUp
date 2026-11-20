// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import initSqlite from "@sqlite.org/sqlite-wasm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCommands } from "../src/worker/commands";
import { createQueries } from "../src/worker/queries";
import { toAppError } from "../src/worker/errors";
import { migrateSchema, schemaVersion } from "../src/worker/migrate";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/worker/migrations";
import type { SqliteDatabase } from "../src/worker/sqlite";
import { SqliteWasmDriver } from "../src/worker/sqlite-wasm-driver";
import type {
  WorkerFaultStage,
  WorkerRequest,
} from "../src/shared/worker-protocol";

const driver = vi.hoisted(() => ({
  open: null as null | ((file: string) => SqliteDatabase),
}));

vi.mock("../src/main/worker-client", () => ({
  StoreClient: class {
    readonly ready = Promise.resolve();
    readonly sqliteVersion: string;
    private closed = false;
    private readonly db: SqliteDatabase;
    private readonly store;

    constructor(file: string, options: { faults?: WorkerFaultStage[] } = {}) {
      this.db = driver.open!(file);
      migrateSchema(this.db);
      this.sqliteVersion = (
        this.db.prepare("SELECT sqlite_version() AS version").get() as {
          version: string;
        }
      ).version;
      this.store = {
        ...createCommands(this.db, options.faults),
        ...createQueries(this.db),
      };
    }

    async send(request: WorkerRequest) {
      if (this.closed) return { ok: false, code: "DB_UNAVAILABLE" };
      const queries: Record<string, string> = {
        getWorkspaceSnapshot: "workspaceSnapshot",
        getTaskDetail: "taskDetail",
        getDailyReview: "dailyReview",
        getCommandResult: "commandOutcome",
      };
      const name = queries[request.kind] ?? request.kind;
      const method = this.store[name as keyof typeof this.store] as (
        input?: unknown,
      ) => unknown;
      try {
        const input = "input" in request ? request.input : undefined;
        const value = method(
          request.kind === "getCommandResult"
            ? (input as { commandId: string }).commandId
            : input,
        );
        if (
          request.kind !== "getCommandResult" &&
          value &&
          typeof value === "object" &&
          "revision" in value &&
          "value" in value
        ) {
          return { ok: true, ...value };
        }
        return { ok: true, value, revision: this.store.revision() };
      } catch (error) {
        return toAppError(error);
      }
    }

    async close() {
      this.closed = true;
      this.db.close();
    }
  },
}));

import { storeScenarios } from "../src/main/integration";

const sqlite = await initSqlite();

describe.each(["better-sqlite3", "sqlite-wasm"] as const)(
  "%s store parity",
  (name) => {
    let directory: string;
    let serial = 0;
    const open = (file = `unit-${++serial}.sqlite`): SqliteDatabase =>
      name === "better-sqlite3"
        ? new Database(join(directory, basename(file)))
        : new SqliteWasmDriver(
            new sqlite.oo1.DB(`${basename(directory)}-${basename(file)}`, "c"),
          );

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "pickup-parity-"));
      driver.open = open;
    });
    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it.each(storeScenarios)("%s", async (_label, run) => {
      await run(directory);
    });

    it("preserves Node SHA-256 receipt hashes for Unicode payloads", () => {
      const db = open();
      try {
        migrateSchema(db);
        const commands = createCommands(db);
        const commandId = crypto.randomUUID();
        const input = {
          commandId,
          title: "接回未完的事 𠮷",
          note: "\u0000\n保留备注",
        };
        const result = commands.createTask(input);
        const receipt = db
          .prepare(
            "SELECT payload_hash FROM command_receipts WHERE command_id = ?",
          )
          .get(commandId);
        expect(receipt).toEqual({
          payload_hash: createHash("sha256")
            .update(
              JSON.stringify(["createTask", input.title, input.note, null]),
            )
            .digest("hex"),
        });
        expect(commands.createTask(input)).toEqual(result);
      } finally {
        db.close();
      }
    });

    it("binds named and positional parameters, returns run metadata and empty results", () => {
      const db = open();
      try {
        db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY, a, b, c)");
        const insert = db.prepare("INSERT INTO sample(a,b,c) VALUES(@a,:b,$c)");
        expect(insert.run({ a: 1, b: "二", c: null })).toEqual({
          changes: 1,
          lastInsertRowid: 1,
        });
        expect(insert.run({ a: 2, b: "三", c: 3n })).toEqual({
          changes: 1,
          lastInsertRowid: 2,
        });
        expect(
          db.prepare("SELECT a,b,c FROM sample WHERE id = ?").get(1),
        ).toEqual({ a: 1, b: "二", c: null });
        expect(db.prepare("SELECT ? AS a, ? AS b").get([4, 5])).toEqual({
          a: 4,
          b: 5,
        });
        expect(
          db.prepare("SELECT * FROM sample WHERE id = ?").get(99),
        ).toBeUndefined();
        expect(db.prepare("SELECT * FROM sample WHERE id = ?").all(99)).toEqual(
          [],
        );
        expect(() => insert.run({ a: 1 })).toThrow();
        expect(() => db.prepare("SELECT ?").get(1, 2)).toThrow();
        expect(db.prepare("SELECT ? AS t").get("前\u0000后")).toEqual({
          t: "前\u0000后",
        });
        expect(db.prepare("SELECT 9007199254740993 AS n").get()).toEqual({
          n: 9007199254740992,
        });
      } finally {
        db.close();
      }
    });

    it("rolls back nested transactions independently and outer transactions completely", () => {
      const db = open();
      try {
        db.exec("CREATE TABLE sample(value INTEGER)");
        const insert = db.prepare("INSERT INTO sample VALUES(?)");
        const inner = db.transaction(() => {
          insert.run(2);
          throw new Error("inner");
        });
        db.transaction((value: number) => {
          insert.run(value);
          expect(inner).toThrow("inner");
          db.transaction(() => insert.run(3))();
        })(1);
        expect(db.prepare("SELECT value FROM sample").all()).toEqual([
          { value: 1 },
          { value: 3 },
        ]);
        expect(
          db.transaction(() => {
            insert.run(4);
            db.transaction(() => insert.run(5))();
            throw new Error("outer");
          }),
        ).toThrow("outer");
        expect(
          db.prepare("SELECT count(*) AS total FROM sample").get(),
        ).toEqual({ total: 2 });
        expect(db.transaction(() => Promise.resolve())).toThrow();
      } finally {
        db.close();
      }
    });

    it("rolls back all migrations when a later migration fails", () => {
      const db = open();
      try {
        const failing: SqliteDatabase = {
          prepare: (sql) => db.prepare(sql),
          transaction: (fn) => db.transaction(fn),
          close: () => db.close(),
          exec: (sql) => {
            if (sql === MIGRATIONS[1].sql) throw new Error("migration fault");
            return db.exec(sql);
          },
        };
        expect(() => migrateSchema(failing)).toThrow("migration fault");
        expect(schemaVersion(db)).toBe(0);
        expect(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all(),
        ).toEqual([]);
        migrateSchema(db);
        expect(() =>
          db
            .prepare(
              "INSERT INTO task_transitions(task_id, from_status, to_status, changed_at, revision) VALUES('missing', NULL, 'todo', 0, 1)",
            )
            .run(),
        ).toThrow(/FOREIGN KEY/);
      } finally {
        db.close();
      }
    });

    it("migrates new and existing schemas, enables foreign keys and rejects unknown versions", () => {
      const db = open();
      try {
        db.exec(MIGRATIONS[0].sql);
        db.exec("PRAGMA user_version = 1");
        migrateSchema(db);
        expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
        expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({
          foreign_keys: 1,
        });
        migrateSchema(db);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        expect(() => migrateSchema(db)).toThrow("schema");
        expect(schemaVersion(db)).toBe(SCHEMA_VERSION + 1);
      } finally {
        db.close();
      }
      const unversioned = open();
      try {
        unversioned.exec("CREATE TABLE existing(value)");
        expect(() => migrateSchema(unversioned)).toThrow("版本信息");
        expect(schemaVersion(unversioned)).toBe(0);
      } finally {
        unversioned.close();
      }
    });
  },
);
