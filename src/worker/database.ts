import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerFaultStage } from "../shared/worker-protocol";
import { createCommands } from "./commands";
import {
  BackendUnavailableError,
  IntegrityError,
  MigrationFailedError,
  SchemaTooNewError,
} from "./errors";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations";
import { createQueries } from "./queries";
import type { SqliteDatabase } from "./rows";

const BACKUP_DIRECTORY = "backups";
const BACKUP_PREFIX = "pickup-pre-upgrade-";
/** 升级前一致副本的保留份数；轮换只影响副本，不触碰业务数据库。 */
const BACKUP_RETENTION = 2;

function applyPragmas(db: SqliteDatabase): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = EXTRA");
  db.pragma("busy_timeout = 1000");
}

function schemaVersion(db: SqliteDatabase): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function tableCount(db: SqliteDatabase): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS total FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get() as { total: number }
  ).total;
}

function rotateBackups(directory: string): void {
  const names = readdirSync(directory)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort();
  const obsolete = names.slice(0, Math.max(0, names.length - BACKUP_RETENTION));
  for (const name of obsolete) rmSync(join(directory, name), { force: true });
}

/**
 * 使用 SQLite VACUUM INTO 生成一致副本（不是复制正在写入的数据库文件），
 * 校验副本可读且版本一致后才执行迁移。
 */
function createUpgradeBackup(
  db: SqliteDatabase,
  dbPath: string,
  fromVersion: number,
): string {
  const directory = join(dirname(dbPath), BACKUP_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${BACKUP_PREFIX}v${fromVersion}-to-v${SCHEMA_VERSION}-${stamp}`;
  let target = join(directory, `${base}.sqlite`);
  let suffix = 1;
  while (existsSync(target))
    target = join(directory, `${base}-${suffix++}.sqlite`);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (error) {
    throw new MigrationFailedError(
      "升级前无法生成一致的保护副本，已停止升级且未修改原数据库。",
      null,
      { cause: error },
    );
  }
  const copy = new Database(target, { readonly: true, fileMustExist: true });
  try {
    if (
      copy.pragma("quick_check", { simple: true }) !== "ok" ||
      schemaVersion(copy) !== fromVersion
    )
      throw new MigrationFailedError(
        "升级前保护副本校验失败，已停止升级且未修改原数据库。",
        target,
      );
  } finally {
    copy.close();
  }
  rotateBackups(directory);
  return target;
}

function migrate(db: SqliteDatabase, dbPath: string): string | null {
  const from = schemaVersion(db);
  if (from === SCHEMA_VERSION) return null;
  if (from > SCHEMA_VERSION) throw new SchemaTooNewError(from, SCHEMA_VERSION);
  if (from < 0) throw new IntegrityError("数据库 schema 版本号异常。");
  let backupPath: string | null = null;
  if (from === 0) {
    if (tableCount(db) > 0)
      throw new IntegrityError(
        "数据库缺少版本信息但已存在数据表，已停止初始化以避免覆盖现有文件。",
      );
  } else {
    backupPath = createUpgradeBackup(db, dbPath, from);
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > from);
  try {
    db.transaction(() => {
      for (const migration of pending) db.exec(migration.sql);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } catch (error) {
    throw new MigrationFailedError(
      "数据库升级失败，事务已回滚，原数据库与保护副本均保留。",
      backupPath,
      { cause: error },
    );
  }
  return backupPath;
}

function verifyIntegrity(db: SqliteDatabase): void {
  const result = db.pragma("quick_check", { simple: true });
  if (result !== "ok")
    throw new IntegrityError(`数据库一致性检查未通过：${String(result)}`);
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) throw new IntegrityError("数据库外键检查未通过。");
}

/**
 * 打开唯一连接、完成迁移与一致性检查，并组装 worker 使用的 store。
 * 任何失败都保留原文件：不创建空库、不写入示例数据、不删除副本。
 */
export function openStore(
  dbPath: string,
  options: { faults?: WorkerFaultStage[] } = {},
) {
  let db: SqliteDatabase;
  try {
    db = new Database(dbPath);
  } catch (error) {
    throw new BackendUnavailableError(
      "无法打开本地数据库文件（可能被占用、只读或磁盘空间不足）。原文件未被修改。",
      { cause: error },
    );
  }
  try {
    try {
      applyPragmas(db);
    } catch (error) {
      throw new IntegrityError(
        "数据库文件无法读取，或不是有效的 SQLite 数据库。原文件已保留。",
        { cause: error },
      );
    }
    const backupPath = migrate(db, dbPath);
    verifyIntegrity(db);
    const sqliteVersion = (
      db.prepare("SELECT sqlite_version() AS version").get() as {
        version: string;
      }
    ).version;
    return {
      ...createQueries(db),
      ...createCommands(db, options.faults),
      sqliteVersion,
      schemaVersion: SCHEMA_VERSION,
      backupPath,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type Store = ReturnType<typeof openStore>;
