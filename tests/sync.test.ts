// @vitest-environment node
import Database from "better-sqlite3";
import initSqlite from "@sqlite.org/sqlite-wasm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommands, readAppState } from "../src/worker/commands";
import { createQueries } from "../src/worker/queries";
import { encodeHlc, decodeHlc, tick, receive } from "../src/worker/hlc";
import { migrateSchema, schemaVersion } from "../src/worker/migrate";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/worker/migrations";
import {
  applyRemoteChanges,
  listChangesSince,
  syncChangeSchema,
  type SyncChange,
} from "../src/worker/sync";
import type { SqliteDatabase } from "../src/worker/sqlite";
import { SqliteWasmDriver } from "../src/worker/sqlite-wasm-driver";
import type { TaskStatus } from "../src/shared/task";

const sqlite = await initSqlite();
const uuid = () => globalThis.crypto.randomUUID();
const deviceA = "00000000-0000-4000-8000-000000000001";
const deviceB = "00000000-0000-4000-8000-000000000002";

it("ticks and receives fixed-width sortable HLCs across equal time, clock rollback, ties and counter rollover", () => {
  const a = tick(null, deviceA, 100);
  const b = tick(a, deviceA, 100);
  const c = tick(b, deviceA, 1);
  const d = receive(a, c, deviceB, 0);
  expect([d, b, a, c].sort()).toEqual([a, b, c, d]);
  expect(decodeHlc(d)).toEqual({ wallMs: 100, counter: 3, deviceId: deviceB });
  expect(tick(null, deviceB, 100) > a).toBe(true);
  expect(decodeHlc(receive(null, a, deviceB, 200))).toEqual({
    wallMs: 200,
    counter: 0,
    deviceId: deviceB,
  });
  expect(
    decodeHlc(
      tick(
        encodeHlc({ wallMs: 1, counter: 9_999_999_999, deviceId: deviceA }),
        deviceA,
        0,
      ),
    ),
  ).toEqual({ wallMs: 2, counter: 0, deviceId: deviceA });
  expect(() => decodeHlc("1:0:device")).toThrow();
  expect(() => tick(null, deviceA, -1)).toThrow();
  expect(() =>
    encodeHlc({
      wallMs: Number.MAX_SAFE_INTEGER + 1,
      counter: 0,
      deviceId: deviceA,
    }),
  ).toThrow();
});

describe.each(["better-sqlite3", "sqlite-wasm"] as const)(
  "%s sync",
  (driver) => {
    const opened: SqliteDatabase[] = [];
    function open(migrate = true): SqliteDatabase {
      const db =
        driver === "better-sqlite3"
          ? new Database(":memory:")
          : new SqliteWasmDriver(new sqlite.oo1.DB(":memory:", "c"));
      opened.push(db);
      if (migrate) migrateSchema(db);
      return db;
    }
    afterEach(() => {
      vi.restoreAllMocks();
      for (const db of opened.splice(0)) db.close();
    });
    function changes(db: SqliteDatabase): SyncChange[] {
      const result: SyncChange[] = [];
      let cursor = 0;
      for (;;) {
        const page = listChangesSince(db, cursor, 37);
        result.push(...page.changes);
        if (!page.changes.length) return result;
        cursor = page.cursor;
      }
    }
    function create(db: SqliteDatabase, title = "待办") {
      return createCommands(db).createTask({
        commandId: uuid(),
        title,
        note: "",
      }).value.taskId;
    }
    function ref(db: SqliteDatabase, id: string) {
      const { version } = db
        .prepare("SELECT version FROM tasks WHERE id = ?")
        .get(id) as { version: number };
      return { taskId: id, expectedVersion: version };
    }
    function settled(a: SqliteDatabase, b: SqliteDatabase) {
      for (let round = 0; round < 10; round++) {
        const first = applyRemoteChanges(a, changes(b));
        const second = applyRemoteChanges(b, changes(a));
        if (!first.applied && !second.applied) return;
      }
      throw new Error("merge did not settle");
    }
    function state(db: SqliteDatabase) {
      return {
        tasks: db
          .prepare(
            "SELECT id,title,note,status,wait_reason,check_back_at,created_at,updated_at,status_changed_at,status_revision,ended_at,content_hlc,status_hlc FROM tasks ORDER BY id",
          )
          .all(),
        breakpoints: db
          .prepare(
            "SELECT id,hlc,task_id,progress,next_step,reference_text,saved_at FROM breakpoints ORDER BY id",
          )
          .all(),
        history: db
          .prepare(
            "SELECT id,hlc,task_id,from_status,to_status,changed_at,revision FROM task_transitions ORDER BY id",
          )
          .all(),
        next: db
          .prepare("SELECT next_up_task_id,next_up_hlc FROM app_state")
          .get(),
      };
    }

    it("migrates populated v2 atomically and preserves local-only data and device/entity ids on repeated initialization", () => {
      const db = open(false);
      db.exec(MIGRATIONS[0].sql);
      db.exec(MIGRATIONS[1].sql);
      db.exec("PRAGMA user_version = 2");
      const id = uuid();
      db.prepare(
        "INSERT INTO tasks(id,title,status,created_at,updated_at,status_changed_at,status_revision) VALUES(?,'旧任务','paused',1,2,2,1)",
      ).run(id);
      db.prepare(
        "INSERT INTO breakpoints(task_id,next_step,saved_at) VALUES(?,'继续',2)",
      ).run(id);
      db.prepare(
        "INSERT INTO task_transitions(task_id,from_status,to_status,changed_at,revision) VALUES(?,NULL,'paused',2,1)",
      ).run(id);
      db.exec(
        "UPDATE app_state SET draft_title='本地草稿', preferences_json='{\"widgetPinned\":true}', next_up_task_id=(SELECT id FROM tasks LIMIT 1)",
      );
      migrateSchema(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      const device = db.prepare("SELECT * FROM sync_device").get();
      const events = changes(db);
      expect(events).toHaveLength(5);
      expect(
        events.every((event) => syncChangeSchema.safeParse(event).success),
      ).toBe(true);
      expect(db.prepare("SELECT title FROM tasks WHERE id=?").get(id)).toEqual({
        title: "旧任务",
      });
      expect(readAppState(db).draft_title).toBe("本地草稿");
      migrateSchema(db);
      expect(db.prepare("SELECT * FROM sync_device").get()).toEqual(device);
      expect(changes(db)).toEqual(events);
      const other = open();
      applyRemoteChanges(other, events.slice().reverse());
      expect(state(other)).toEqual(state(db));
      expect(readAppState(other).draft_title).toBe("");
      expect(readAppState(other).preferences_json).toBe("{}");
      expect(other.prepare("SELECT * FROM command_receipts").all()).toEqual([]);
    });

    it("rolls back schema, identity backfill and seed outbox together when the sync migration fails", () => {
      const db = open(false);
      db.exec(MIGRATIONS[0].sql);
      db.exec(MIGRATIONS[1].sql);
      db.exec("PRAGMA user_version = 2");
      const id = uuid();
      db.prepare(
        "INSERT INTO tasks(id,title,status,created_at,updated_at,status_changed_at,status_revision) VALUES(?,'保留旧数据','todo',1,1,1,1)",
      ).run(id);
      const failing: SqliteDatabase = {
        prepare: (sql) => {
          if (sql.includes("INSERT INTO sync_changes"))
            throw new Error("seed failure");
          return db.prepare(sql);
        },
        exec: (sql) => db.exec(sql),
        transaction: (fn) => db.transaction(fn),
        close: () => {},
      };
      expect(() => migrateSchema(failing)).toThrow("seed failure");
      expect(schemaVersion(db)).toBe(2);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sync_%'")
          .all(),
      ).toEqual([]);
      expect(db.prepare("SELECT title FROM tasks WHERE id=?").get(id)).toEqual({
        title: "保留旧数据",
      });
      migrateSchema(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(changes(db)).toHaveLength(2);
    });

    it("keeps empty/no-op/draft/preferences operations out of the outbox, rolls back business writes and clock on receipt failure", () => {
      const db = open();
      expect(listChangesSince(db)).toEqual({ changes: [], cursor: 0 });
      expect(applyRemoteChanges(db, [])).toEqual({ applied: 0, revision: 0 });
      const commands = createCommands(db);
      commands.saveDraft({
        title: "本地",
        note: "备注",
        expectedDraftVersion: 0,
      });
      commands.clearDraft({ expectedDraftVersion: 1 });
      commands.updatePreference({
        patch: { widgetPinned: true },
        expectedVersion: 0,
      });
      expect(changes(db)).toEqual([]);
      const before = db.prepare("SELECT * FROM sync_device").get();
      const failing: SqliteDatabase = {
        prepare: (sql) => {
          if (sql.includes("INSERT INTO command_receipts"))
            throw new Error("receipt failure");
          return db.prepare(sql);
        },
        exec: (sql) => db.exec(sql),
        transaction: (fn) => db.transaction(fn),
        close: () => {},
      };
      expect(() =>
        createCommands(failing).createTask({
          commandId: uuid(),
          title: "回滚",
          note: "",
        }),
      ).toThrow("receipt failure");
      expect(db.prepare("SELECT * FROM tasks").all()).toEqual([]);
      expect(changes(db)).toEqual([]);
      expect(db.prepare("SELECT * FROM sync_device").get()).toEqual(before);
      expect(db.prepare("SELECT * FROM sync_dirty").all()).toEqual([]);
      const input = { commandId: uuid(), title: "幂等", note: "" };
      commands.createTask(input);
      const saved = changes(db);
      commands.createTask(input);
      expect(changes(db)).toEqual(saved);
      expect(saved.map((event) => event.entity).sort()).toEqual([
        "task-content",
        "task-status",
        "transition",
      ]);
    });

    it("records every business command, including switch/review/cancel, without leaving dirty rows", () => {
      const db = open(),
        commands = createCommands(db);
      const first = create(db),
        second = create(db);
      function run(action: () => unknown) {
        const count = changes(db).length;
        action();
        expect(changes(db).length).toBeGreaterThan(count);
        expect(db.prepare("SELECT * FROM sync_dirty").all()).toEqual([]);
      }
      run(() =>
        commands.updateTask({
          commandId: uuid(),
          ...ref(db, first),
          title: "改名",
        }),
      );
      run(() =>
        commands.startTask({ commandId: uuid(), task: ref(db, first) }),
      );
      run(() =>
        commands.saveBreakpoint({
          commandId: uuid(),
          task: ref(db, first),
          breakpoint: {
            progress: "已做",
            nextStep: "继续",
            referenceText: "材料",
          },
        }),
      );
      run(() =>
        commands.pauseTask({ commandId: uuid(), task: ref(db, first) }),
      );
      run(() =>
        commands.startTask({ commandId: uuid(), task: ref(db, first) }),
      );
      run(() =>
        commands.switchTask({
          commandId: uuid(),
          from: ref(db, first),
          to: ref(db, second),
        }),
      );
      run(() =>
        commands.markWaiting({
          commandId: uuid(),
          task: ref(db, second),
          reason: "等待",
          checkBackAt: 12345,
        }),
      );
      run(() =>
        commands.markWaiting({
          commandId: uuid(),
          task: ref(db, second),
          reason: "新原因",
          checkBackAt: 54321,
        }),
      );
      run(() =>
        commands.resolveWaiting({ commandId: uuid(), task: ref(db, second) }),
      );
      run(() =>
        commands.startTask({ commandId: uuid(), task: ref(db, second) }),
      );
      run(() =>
        commands.finishDailyReview({
          commandId: uuid(),
          outcome: "pause",
          currentTask: ref(db, second),
        }),
      );
      run(() =>
        commands.setNextUp({
          commandId: uuid(),
          taskId: first,
          expectedNextUpVersion: readAppState(db).next_up_version,
        }),
      );
      run(() =>
        commands.cancelTask({ commandId: uuid(), task: ref(db, first) }),
      );
      run(() =>
        commands.reopenTask({ commandId: uuid(), task: ref(db, first) }),
      );
      run(() =>
        commands.completeTask({ commandId: uuid(), task: ref(db, first) }),
      );
      expect(
        changes(db).every(
          (change) => syncChangeSchema.safeParse(change).success,
        ),
      ).toBe(true);
    });

    it("keeps last-updated timestamps convergent when the local wall clock rolls back", () => {
      const a = open(),
        b = open();
      const time = vi.spyOn(Date, "now").mockReturnValue(1000);
      const id = create(a);
      settled(a, b);
      time.mockReturnValue(1);
      createCommands(a).updateTask({
        commandId: uuid(),
        ...ref(a, id),
        title: "回拨后的内容",
      });
      createCommands(a).startTask({ commandId: uuid(), task: ref(a, id) });
      createCommands(a).saveBreakpoint({
        commandId: uuid(),
        task: ref(a, id),
        breakpoint: { progress: "", nextStep: "继续", referenceText: "" },
      });
      expect(
        a.prepare("SELECT updated_at FROM tasks WHERE id=?").get(id),
      ).toEqual({ updated_at: 1000 });
      settled(a, b);
      expect(state(a)).toEqual(state(b));
    });

    it("chooses independent content and next-up LWW winners even when older changes arrive last", () => {
      const a = open(),
        b = open();
      const first = create(a),
        second = create(a);
      settled(a, b);
      createCommands(a).updateTask({
        commandId: uuid(),
        ...ref(a, first),
        title: "A 的编辑",
      });
      createCommands(b).updateTask({
        commandId: uuid(),
        ...ref(b, first),
        title: "B 的编辑",
      });
      createCommands(a).setNextUp({
        commandId: uuid(),
        taskId: first,
        expectedNextUpVersion: readAppState(a).next_up_version,
      });
      createCommands(b).setNextUp({
        commandId: uuid(),
        taskId: second,
        expectedNextUpVersion: readAppState(b).next_up_version,
      });
      const events = [...changes(a), ...changes(b)].sort((a, b) =>
        a.hlc < b.hlc ? -1 : 1,
      );
      const winner = events
        .filter(
          (change) =>
            change.entity === "task-content" && change.entityId === first,
        )
        .at(-1)!;
      const next = events
        .filter((change) => change.entity === "next-up")
        .at(-1)!;
      applyRemoteChanges(a, changes(b).reverse());
      applyRemoteChanges(b, changes(a).reverse());
      settled(a, b);
      expect(state(a)).toEqual(state(b));
      expect(
        a.prepare("SELECT title FROM tasks WHERE id=?").get(first),
      ).toEqual({ title: (winner.payload as { title: string }).title });
      expect(readAppState(a).next_up_task_id).toEqual(
        (next.payload as { taskId: string }).taskId,
      );
    });

    it("merges content and status independently and unions out-of-order children without using arrival order for latest breakpoint", () => {
      const a = open(),
        b = open();
      const id = create(a);
      settled(a, b);
      createCommands(a).updateTask({
        commandId: uuid(),
        ...ref(a, id),
        title: "新标题",
        note: "新备注",
      });
      createCommands(b).startTask({ commandId: uuid(), task: ref(b, id) });
      createCommands(a).saveBreakpoint({
        commandId: uuid(),
        task: ref(a, id),
        breakpoint: { progress: "", nextStep: "先保存", referenceText: "" },
      });
      createCommands(b).saveBreakpoint({
        commandId: uuid(),
        task: ref(b, id),
        breakpoint: { progress: "", nextStep: "后保存", referenceText: "" },
      });
      settled(a, b);
      expect(state(a)).toEqual(state(b));
      expect(a.prepare("SELECT title,status FROM tasks").get()).toEqual({
        title: "新标题",
        status: "doing",
      });
      expect(a.prepare("SELECT count(*) AS n FROM breakpoints").get()).toEqual({
        n: 2,
      });
      const receiver = open();
      for (const event of changes(a).reverse())
        applyRemoteChanges(receiver, [event]);
      expect(state(receiver)).toEqual(state(a));
      const input = {
        taskId: id,
        breakpointOffset: 0,
        breakpointLimit: 10,
        transitionOffset: 0,
        transitionLimit: 20,
      };
      expect(
        createQueries(receiver).taskDetail(input).task.latestBreakpoint
          ?.nextStep,
      ).toEqual(
        createQueries(a).taskDetail(input).task.latestBreakpoint?.nextStep,
      );
    });

    it("keeps the most recently started task, pauses other doing tasks with synced history and preserves the unique index", () => {
      const a = open(),
        b = open();
      const first = create(a),
        second = create(a);
      settled(a, b);
      const time = vi.spyOn(Date, "now").mockReturnValue(1000);
      createCommands(a).startTask({ commandId: uuid(), task: ref(a, first) });
      time.mockReturnValue(2000);
      createCommands(b).startTask({ commandId: uuid(), task: ref(b, second) });
      settled(a, b);
      expect(state(a)).toEqual(state(b));
      expect(
        a.prepare("SELECT id FROM tasks WHERE status='doing'").all(),
      ).toEqual([{ id: second }]);
      expect(
        a.prepare("SELECT status FROM tasks WHERE id=?").get(first),
      ).toEqual({ status: "paused" });
      expect(
        a
          .prepare(
            "SELECT count(*) AS n FROM task_transitions WHERE task_id=? AND from_status='doing' AND to_status='paused'",
          )
          .get(first),
      ).toEqual({ n: 1 });
      expect(() =>
        a.prepare("UPDATE tasks SET status='doing' WHERE id=?").run(first),
      ).toThrow(/UNIQUE/);
      const snapshot = state(a),
        outbox = changes(a),
        clock = a.prepare("SELECT * FROM sync_device").get();
      expect(applyRemoteChanges(a, changes(b)).applied).toBe(0);
      expect(state(a)).toEqual(snapshot);
      expect(changes(a)).toEqual(outbox);
      expect(a.prepare("SELECT * FROM sync_device").get()).toEqual(clock);
    });

    it.each(["complete", "pause", "cancel"] as const)(
      "does not resume a suppressed start after the winner's %s",
      (action) => {
        const time = vi.spyOn(Date, "now").mockReturnValue(1000);
        const a = open(),
          b = open(),
          c = open();
        const first = create(a),
          second = create(a);
        settled(a, b);
        applyRemoteChanges(c, changes(a));
        time.mockReturnValue(2000);
        createCommands(a).startTask({ commandId: uuid(), task: ref(a, first) });
        time.mockReturnValue(3000);
        createCommands(b).startTask({
          commandId: uuid(),
          task: ref(b, second),
        });
        settled(a, b);
        time.mockReturnValue(4000);
        const input = { commandId: uuid(), task: ref(b, second) };
        if (action === "complete") createCommands(b).completeTask(input);
        else if (action === "pause") createCommands(b).pauseTask(input);
        else createCommands(b).cancelTask(input);
        expect(
          b.prepare("SELECT id FROM tasks WHERE status='doing'").all(),
        ).toEqual([]);
        settled(a, b);
        for (const event of changes(b).reverse())
          applyRemoteChanges(c, [event]);
        settled(a, c);
        settled(a, b);
        expect(state(a)).toEqual(state(b));
        expect(state(a)).toEqual(state(c));
        expect(
          a.prepare("SELECT status FROM tasks WHERE id=?").get(first),
        ).toEqual({ status: "paused" });
        expect(
          a
            .prepare(
              "SELECT count(*) AS n FROM task_transitions WHERE task_id=? AND from_status='doing' AND to_status='paused'",
            )
            .get(first),
        ).toEqual({ n: 1 });
        time.mockReturnValue(1);
        createCommands(a).startTask({ commandId: uuid(), task: ref(a, first) });
        expect(
          a.prepare("SELECT id FROM tasks WHERE status='doing'").all(),
        ).toEqual([{ id: first }]);
        settled(a, b);
        expect(state(a)).toEqual(state(b));
      },
    );

    it.each(["start", "switch"] as const)(
      "honors an explicit %s after observing future-clock starts",
      (action) => {
        const time = vi.spyOn(Date, "now").mockReturnValue(1000);
        const a = open(),
          b = open();
        const suppressed = create(a),
          current = create(a),
          target = create(a);
        settled(a, b);
        if (action === "switch") {
          time.mockReturnValue(100000);
          createCommands(a).startTask({
            commandId: uuid(),
            task: ref(a, suppressed),
          });
        }
        time.mockReturnValue(200000);
        createCommands(b).startTask({
          commandId: uuid(),
          task: ref(b, current),
        });
        settled(a, b);
        const observed = changes(a)
          .filter(
            (c) => c.entity === "task-status" && c.payload.status === "doing",
          )
          .map((c) => c.hlc)
          .sort()
          .at(-1)!;
        time.mockReturnValue(1);
        if (action === "switch") {
          const result = createCommands(a).switchTask({
            commandId: uuid(),
            from: ref(a, current),
            to: ref(a, target),
          });
          expect(result.value.switched).toBe(true);
        } else {
          createCommands(a).pauseTask({
            commandId: uuid(),
            task: ref(a, current),
          });
          expect(
            createCommands(a).startTask({
              commandId: uuid(),
              task: ref(a, target),
            }).value.started,
          ).toBe(true);
        }
        expect(
          a.prepare("SELECT id FROM tasks WHERE status='doing'").all(),
        ).toEqual([{ id: target }]);
        const started = changes(a)
          .filter((c) => c.entity === "task-status" && c.entityId === target)
          .at(-1)!;
        expect(started.hlc > observed).toBe(true);
        settled(a, b);
        expect(state(a)).toEqual(state(b));
        expect(
          b.prepare("SELECT id FROM tasks WHERE status='doing'").all(),
        ).toEqual([{ id: target }]);
      },
    );

    it.each([false, true])(
      "preserves completion when the following start is delivered first: %s",
      (startFirst) => {
        const time = vi.spyOn(Date, "now").mockReturnValue(1000);
        const a = open(),
          b = open();
        const first = create(a),
          second = create(a);
        createCommands(a).startTask({ commandId: uuid(), task: ref(a, first) });
        settled(a, b);
        const cursor = listChangesSince(a, 0, 1000).cursor;
        time.mockReturnValue(2000);
        createCommands(a).completeTask({
          commandId: uuid(),
          task: ref(a, first),
        });
        const completed = listChangesSince(a, cursor, 1000);
        time.mockReturnValue(3000);
        createCommands(a).startTask({
          commandId: uuid(),
          task: ref(a, second),
        });
        const started = listChangesSince(a, completed.cursor, 1000).changes;
        time.mockReturnValue(100000);
        for (const batch of startFirst
          ? [started, completed.changes]
          : [completed.changes, started])
          applyRemoteChanges(b, batch);
        settled(a, b);
        expect(state(a)).toEqual(state(b));
        expect(
          b.prepare("SELECT status FROM tasks WHERE id=?").get(first),
        ).toEqual({ status: "done" });
        expect(
          b.prepare("SELECT id FROM tasks WHERE status='doing'").all(),
        ).toEqual([{ id: second }]);
        expect(
          changes(b)
            .filter((c) => c.entity === "task-status")
            .map((c) => c.id)
            .sort(),
        ).toEqual(
          changes(a)
            .filter((c) => c.entity === "task-status")
            .map((c) => c.id)
            .sort(),
        );
      },
    );

    it.each([false, true])(
      "restores the user's next-up choice when it arrives before reopen: %s",
      (choiceFirst) => {
        const time = vi.spyOn(Date, "now").mockReturnValue(1000);
        const a = open(),
          b = open();
        const id = create(a);
        createCommands(a).completeTask({ commandId: uuid(), task: ref(a, id) });
        settled(a, b);
        const cursor = listChangesSince(a, 0, 1000).cursor;
        time.mockReturnValue(2000);
        createCommands(a).reopenTask({ commandId: uuid(), task: ref(a, id) });
        const reopened = listChangesSince(a, cursor, 1000);
        time.mockReturnValue(3000);
        createCommands(a).setNextUp({
          commandId: uuid(),
          taskId: id,
          expectedNextUpVersion: readAppState(a).next_up_version,
        });
        const chosen = listChangesSince(a, reopened.cursor, 1000).changes;
        time.mockReturnValue(100000);
        const batches = choiceFirst
          ? [chosen, reopened.changes]
          : [reopened.changes, chosen];
        applyRemoteChanges(b, batches[0]);
        if (choiceFirst) {
          expect(readAppState(b).next_up_task_id).toBeNull();
          expect(changes(b).filter((c) => c.entity === "next-up")).toEqual(
            changes(a).filter((c) => c.entity === "next-up"),
          );
        }
        applyRemoteChanges(b, batches[1]);
        settled(a, b);
        expect(readAppState(a).next_up_task_id).toBe(id);
        expect(readAppState(b).next_up_task_id).toBe(id);
        expect(state(a)).toEqual(state(b));
        createCommands(b).setNextUp({
          commandId: uuid(),
          taskId: null,
          expectedNextUpVersion: readAppState(b).next_up_version,
        });
        settled(a, b);
        applyRemoteChanges(a, [...chosen, ...reopened.changes]);
        expect(readAppState(a).next_up_task_id).toBeNull();
        expect(state(a)).toEqual(state(b));
      },
    );

    it("repairs next-up pointing at an ended or waiting task, resolves next-up LWW and never skips late old-HLC changes with the upload cursor", () => {
      const a = open(),
        b = open();
      const first = create(a),
        second = create(a);
      settled(a, b);
      const version = readAppState(a).next_up_version;
      createCommands(a).setNextUp({
        commandId: uuid(),
        taskId: first,
        expectedNextUpVersion: version,
      });
      createCommands(b).completeTask({
        commandId: uuid(),
        task: ref(b, first),
      });
      settled(a, b);
      expect(readAppState(a).next_up_task_id).toBeNull();
      expect(state(a)).toEqual(state(b));
      createCommands(a).setNextUp({
        commandId: uuid(),
        taskId: second,
        expectedNextUpVersion: readAppState(a).next_up_version,
      });
      createCommands(b).markWaiting({
        commandId: uuid(),
        task: ref(b, second),
        reason: "等待",
        checkBackAt: null,
      });
      settled(a, b);
      expect(readAppState(a).next_up_task_id).toBeNull();
      const prior = listChangesSince(a, 0, 1000).cursor;
      vi.spyOn(Date, "now").mockReturnValue(1);
      const c = open();
      create(c, "迟到的旧事件");
      expect(changes(c)[0].hlc < changes(a)[0].hlc).toBe(true);
      applyRemoteChanges(a, changes(c));
      expect(listChangesSince(a, prior, 1000).changes.map((c) => c.id)).toEqual(
        changes(c).map((c) => c.id),
      );
      expect(() => listChangesSince(a, -1)).toThrow();
      expect(() => listChangesSince(a, 0, 0)).toThrow();
    });

    it("rejects malformed or reused immutable identities atomically, including a failure after dropping the doing index", () => {
      const a = open(),
        b = open();
      create(a);
      const events = changes(a),
        before = state(b),
        clock = b.prepare("SELECT * FROM sync_device").get();
      expect(() =>
        applyRemoteChanges(b, [events[0], { ...events[1], hlc: "invalid" }]),
      ).toThrow();
      expect(changes(b)).toEqual([]);
      expect(state(b)).toEqual(before);
      const bad = {
        ...events[0],
        payload: { ...events[0].payload, note: "different" },
      };
      expect(() => applyRemoteChanges(b, [events[0], bad])).toThrow();
      expect(changes(b)).toEqual([]);
      const failing: SqliteDatabase = {
        prepare: (sql) => b.prepare(sql),
        exec: (sql) => {
          if (sql.startsWith("CREATE UNIQUE INDEX ux_one_doing"))
            throw new Error("index failure");
          return b.exec(sql);
        },
        transaction: (fn) => b.transaction(fn),
        close: () => {},
      };
      expect(() => applyRemoteChanges(failing, events)).toThrow(
        "index failure",
      );
      expect(changes(b)).toEqual([]);
      expect(state(b)).toEqual(before);
      expect(b.prepare("SELECT * FROM sync_device").get()).toEqual(clock);
      expect(
        b
          .prepare("SELECT name FROM sqlite_master WHERE name='ux_one_doing'")
          .get(),
      ).toEqual({ name: "ux_one_doing" });
    });

    it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
      "converges two devices after random commands, duplicate deliveries, batch boundaries and interleavings (seed %i)",
      (seed) => {
        let randomState = seed;
        function random(n: number) {
          randomState ^= randomState << 13;
          randomState ^= randomState >>> 17;
          randomState ^= randomState << 5;
          return (randomState >>> 0) % n;
        }
        function shuffled<T>(items: T[]) {
          const result = items.slice();
          for (let i = result.length - 1; i > 0; i--) {
            const j = random(i + 1);
            [result[i], result[j]] = [result[j], result[i]];
          }
          return result;
        }
        const a = open(),
          b = open();
        create(a, "共享一");
        create(a, "共享二");
        settled(a, b);
        vi.spyOn(Date, "now").mockImplementation(() => 100_000 + random(20));
        for (let step = 0; step < 45; step++) {
          const db = random(2) === 0 ? a : b,
            other = db === a ? b : a,
            commands = createCommands(db);
          const rows = db
            .prepare("SELECT id,status FROM tasks ORDER BY id")
            .all() as { id: string; status: TaskStatus }[];
          const target = rows[random(rows.length)];
          const task = ref(db, target.id),
            commandId = uuid();
          const current = rows.find((row) => row.status === "doing");
          switch (random(9)) {
            case 0:
              create(db, `新事项 ${seed}-${step}`);
              break;
            case 1:
              if (!["done", "cancelled"].includes(target.status))
                commands.updateTask({
                  commandId,
                  ...task,
                  title: `编辑 ${seed}-${step}`,
                  note: "内容独立合并",
                });
              break;
            case 2:
              if (["todo", "paused", "waiting"].includes(target.status)) {
                if (current)
                  commands.switchTask({
                    commandId,
                    from: ref(db, current.id),
                    to: task,
                  });
                else commands.startTask({ commandId, task });
              }
              break;
            case 3:
              if (target.status === "doing")
                commands.pauseTask({
                  commandId,
                  task,
                  breakpoint: {
                    progress: "进展",
                    nextStep: `继续 ${step}`,
                    referenceText: "",
                  },
                });
              break;
            case 4:
              if (!["done", "cancelled"].includes(target.status))
                commands.saveBreakpoint({
                  commandId,
                  task,
                  breakpoint: {
                    progress: "",
                    nextStep: `线索 ${step}`,
                    referenceText: "",
                  },
                });
              break;
            case 5:
              if (!["done", "cancelled"].includes(target.status))
                commands.completeTask({ commandId, task });
              else commands.reopenTask({ commandId, task });
              break;
            case 6:
              if (["todo", "doing", "paused"].includes(target.status))
                commands.markWaiting({
                  commandId,
                  task,
                  reason: "依赖",
                  checkBackAt: 200_000,
                });
              else if (target.status === "waiting")
                commands.resolveWaiting({ commandId, task });
              break;
            case 7:
              if (!["done", "cancelled", "waiting"].includes(target.status))
                commands.setNextUp({
                  commandId,
                  taskId: target.id,
                  expectedNextUpVersion: readAppState(db).next_up_version,
                });
              break;
            case 8:
              applyRemoteChanges(
                other,
                shuffled(changes(db)).slice(0, random(8)),
              );
              break;
          }
          expect(db.prepare("SELECT * FROM sync_dirty").all()).toEqual([]);
          expect(
            (
              db
                .prepare("SELECT count(*) AS n FROM tasks WHERE status='doing'")
                .get() as { n: number }
            ).n,
          ).toBeLessThanOrEqual(1);
        }
        for (const event of shuffled(changes(a)))
          applyRemoteChanges(b, [event]);
        for (const event of shuffled(changes(b)))
          applyRemoteChanges(a, [event]);
        settled(a, b);
        expect(state(a)).toEqual(state(b));
        expect(new Set(changes(a).map((c) => c.id))).toEqual(
          new Set(changes(b).map((c) => c.id)),
        );
        const snapshot = state(a),
          events = changes(a);
        expect(applyRemoteChanges(a, shuffled(events)).applied).toBe(0);
        expect(state(a)).toEqual(snapshot);
        expect(changes(a)).toEqual(events);
        for (const db of [a, b]) {
          expect(
            (
              db
                .prepare("SELECT count(*) AS n FROM tasks WHERE status='doing'")
                .get() as { n: number }
            ).n,
          ).toBeLessThanOrEqual(1);
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        }
      },
    );
  },
);
