// @vitest-environment node
import initSqlite from "@sqlite.org/sqlite-wasm";
import { describe, expect, it, vi } from "vitest";
import { openPoolStore } from "../src/mobile/database";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/worker/migrations";
import { SqliteWasmDriver } from "../src/worker/sqlite-wasm-driver";
import { dispatch } from "../src/worker/dispatch";
import type { WorkerRequest } from "../src/shared/worker-protocol";

async function pool() {
  const sqlite = await initSqlite();
  const names = new Set<string>();
  class DB extends sqlite.oo1.DB {
    constructor(name: string) {
      super(name, "c");
      names.add(name);
    }
  }
  return {
    names,
    OpfsSAHPoolDb: DB,
    getFileNames: () => [...names],
    unlink: vi.fn((name: string) => names.delete(name)),
  };
}

describe("mobile pre-upgrade protection", () => {
  it("opens a new store and never replaces an unversioned nonempty store", async () => {
    const fresh = await pool();
    const store = openPoolStore(fresh);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(store.workspaceSnapshot().counts.unfinished).toBe(0);
    expect(
      dispatch(store, { kind: "unknown" } as unknown as WorkerRequest),
    ).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    store.close();
    const existing = await pool();
    const db = new existing.OpfsSAHPoolDb("/pickup.sqlite");
    db.exec(
      "CREATE TABLE existing(value); INSERT INTO existing VALUES('preserved')",
    );
    db.close();
    expect(() => openPoolStore(existing)).toThrow("版本信息");
    const check = new existing.OpfsSAHPoolDb("/pickup.sqlite");
    expect(check.selectValue("SELECT value FROM existing")).toBe("preserved");
    check.close();
  });

  it("refuses orphaned backup files and future schema versions", async () => {
    const orphan = await pool();
    orphan.names.add("/pickup-pre-upgrade-old.sqlite");
    expect(() => openPoolStore(orphan)).toThrow("找不到主数据库");
    expect(orphan.names.has("/pickup.sqlite")).toBe(false);
    const future = await pool();
    const db = new future.OpfsSAHPoolDb("/pickup.sqlite");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openPoolStore(future)).toThrow("schema");
  });

  it("does not migrate when the consistent-copy operation fails", async () => {
    const existing = await pool();
    const db = new existing.OpfsSAHPoolDb("/pickup.sqlite");
    db.exec(MIGRATIONS[0].sql);
    db.exec("PRAGMA user_version = 1");
    db.close();
    const method = SqliteWasmDriver.prototype.prepare;
    const spy = vi
      .spyOn(SqliteWasmDriver.prototype, "prepare")
      .mockImplementation(function (this: SqliteWasmDriver, sql: string) {
        if (sql.startsWith("VACUUM INTO")) throw new Error("copy failed");
        return method.call(this, sql);
      });
    try {
      expect(() => openPoolStore(existing)).toThrow("保护副本");
    } finally {
      spy.mockRestore();
    }
    const check = new existing.OpfsSAHPoolDb("/pickup.sqlite");
    expect(check.selectValue("PRAGMA user_version")).toBe(1);
    check.close();
  });

  it("verifies an upgrade copy before migrating and keeps the last two copies", async () => {
    const existing = await pool();
    const db = new existing.OpfsSAHPoolDb("/pickup.sqlite");
    db.exec(MIGRATIONS[0].sql);
    db.exec("PRAGMA user_version = 1");
    db.close();
    existing.names.add("/pickup-pre-upgrade-100-v1-old.sqlite");
    existing.names.add("/pickup-pre-upgrade-200-v1-newer.sqlite");
    const store = openPoolStore(existing);
    try {
      expect(store.schemaVersion).toBe(SCHEMA_VERSION);
      expect(store.backupPath).toBeTruthy();
      const backup = new existing.OpfsSAHPoolDb(store.backupPath!);
      expect(backup.selectValue("PRAGMA user_version")).toBe(1);
      expect(backup.selectValue("PRAGMA quick_check")).toBe("ok");
      backup.close();
      expect(existing.unlink).toHaveBeenCalledWith(
        "/pickup-pre-upgrade-100-v1-old.sqlite",
      );
      expect(
        existing
          .getFileNames()
          .filter((name) => name.startsWith("/pickup-pre-upgrade-")),
      ).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("preserves the original version and verified backup when migration fails", async () => {
    const existing = await pool();
    const db = new existing.OpfsSAHPoolDb("/pickup.sqlite");
    db.exec(MIGRATIONS[0].sql);
    db.exec("PRAGMA user_version = 1");
    db.close();
    const exec = SqliteWasmDriver.prototype.exec;
    const spy = vi
      .spyOn(SqliteWasmDriver.prototype, "exec")
      .mockImplementation(function (this: SqliteWasmDriver, sql: string) {
        if (sql === MIGRATIONS[1].sql) throw new Error("migration failure");
        return exec.call(this, sql);
      });
    try {
      expect(() => openPoolStore(existing)).toThrow("事务已回滚");
    } finally {
      spy.mockRestore();
    }
    for (const name of existing.getFileNames()) {
      const check = new existing.OpfsSAHPoolDb(name);
      expect(check.selectValue("PRAGMA user_version")).toBe(1);
      expect(check.selectValue("PRAGMA quick_check")).toBe("ok");
      check.close();
    }
    expect(existing.getFileNames()).toHaveLength(2);
    expect(existing.unlink).not.toHaveBeenCalled();
  });
});
