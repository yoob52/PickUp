// @vitest-environment node
import Database from "better-sqlite3";
import initSqlite from "@sqlite.org/sqlite-wasm";
import { expect, it } from "vitest";
import { createCommands } from "../src/worker/commands";
import { migrateSchema } from "../src/worker/migrate";
import type { SqliteDatabase } from "../src/worker/sqlite";
import { SqliteWasmDriver } from "../src/worker/sqlite-wasm-driver";
import { SyncClient } from "../src/worker/sync-client";
import { serverUrlSchema } from "../src/shared/sync-contracts";
import { startSyncRelay } from "./sync-relay";

function reference(db: SqliteDatabase, taskId: string) {
  const { version } = db
    .prepare("SELECT version FROM tasks WHERE id=?")
    .get(taskId) as { version: number };
  return { taskId, expectedVersion: version };
}

function state(db: SqliteDatabase) {
  return {
    tasks: db
      .prepare(
        "SELECT id,title,note,status,wait_reason,check_back_at,created_at,updated_at,status_changed_at,ended_at,content_hlc,status_hlc FROM tasks ORDER BY id",
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
    nextUp: db
      .prepare(
        "SELECT next_up_task_id,next_up_hlc FROM app_state WHERE singleton=1",
      )
      .get(),
  };
}

it("converges desktop and WASM stores against the selected real account server", async () => {
  const configured = process.env.PICKUP_E2E_SERVER_URL;
  if (configured !== undefined) serverUrlSchema.parse(configured);
  const local = configured === undefined ? await startSyncRelay() : undefined;
  const serverUrl = serverUrlSchema.parse(configured ?? local!.url);
  const email = `e2e+${Date.now()}@pickup.test`;
  const password = crypto.randomUUID() + crypto.randomUUID();
  const stores: SqliteDatabase[] = [];
  const clients: SyncClient[] = [];
  try {
    const sqlite = await initSqlite();
    const desktopDb = new Database(":memory:");
    stores.push(desktopDb);
    const mobileDb = new SqliteWasmDriver(new sqlite.oo1.DB(":memory:", "c"));
    stores.push(mobileDb);
    for (const db of stores) migrateSchema(db);
    const desktop = new SyncClient(desktopDb),
      mobile = new SyncClient(mobileDb);
    clients.push(desktop, mobile);
    const credentials = { serverUrl, email, password };
    await desktop.account({ action: "register", ...credentials });
    await desktop.syncNow();
    await expect(
      mobile.account({
        action: "login",
        ...credentials,
        password: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    expect(mobile.status().enabled).toBe(false);
    await mobile.account({ action: "login", ...credentials });
    await mobile.syncNow();
    expect(state(desktopDb)).toEqual(state(mobileDb));
    expect(state(desktopDb).tasks).toHaveLength(0);

    const capture = (db: SqliteDatabase, title: string) =>
      createCommands(db).createTask({
        commandId: crypto.randomUUID(),
        title,
        note: "Throwaway encrypted sync verification",
      }).value.taskId;
    const desktopTask = capture(desktopDb, "Desktop to WASM");
    capture(desktopDb, "Desktop pending work");
    const mobileTask = capture(mobileDb, "WASM to desktop");
    capture(mobileDb, "Mobile pending work");
    const settle = async () => {
      for (let round = 0; round < 3; round++) {
        await desktop.syncNow();
        await mobile.syncNow();
      }
      expect(state(desktopDb)).toEqual(state(mobileDb));
      expect(desktop.status().error).toBeNull();
      expect(mobile.status().error).toBeNull();
    };
    await settle();
    expect(state(desktopDb).tasks).toHaveLength(4);
    expect(
      desktopDb.prepare("SELECT title FROM tasks WHERE id=?").get(mobileTask),
    ).toEqual({ title: "WASM to desktop" });
    expect(
      mobileDb.prepare("SELECT title FROM tasks WHERE id=?").get(desktopTask),
    ).toEqual({ title: "Desktop to WASM" });

    createCommands(desktopDb).startTask({
      commandId: crypto.randomUUID(),
      task: reference(desktopDb, desktopTask),
    });
    createCommands(mobileDb).startTask({
      commandId: crypto.randomUUID(),
      task: reference(mobileDb, mobileTask),
    });
    await settle();
    const doing = desktopDb
      .prepare("SELECT id FROM tasks WHERE status='doing'")
      .all() as { id: string }[];
    expect(doing).toHaveLength(1);
    expect(
      desktopDb
        .prepare("SELECT count(*) AS n FROM tasks WHERE status='paused'")
        .get(),
    ).toEqual({ n: 1 });
    createCommands(desktopDb).completeTask({
      commandId: crypto.randomUUID(),
      task: reference(desktopDb, doing[0].id),
    });
    await settle();
    expect(
      desktopDb
        .prepare("SELECT count(*) AS n FROM tasks WHERE status='doing'")
        .get(),
    ).toEqual({ n: 0 });
    for (const sync of clients) await sync.account({ action: "logout" });
    process.stdout.write(
      JSON.stringify(
        {
          mode: local ? "local" : "external",
          server: new URL(serverUrl).origin,
          account: email,
          desktopDriver: "better-sqlite3",
          mobileDriver: "sqlite-wasm",
          bidirectionalSync: "passed",
          doingConflict: "passed",
          suppressedStartAfterCompletion: "passed",
          convergence: "passed",
          tasks: 4,
          sessionsRevoked: true,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await Promise.all(clients.map((sync) => sync.close()));
    for (const db of stores.reverse()) db.close();
    await local?.close();
  }
}, 120000);
