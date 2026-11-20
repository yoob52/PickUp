import { IntegrityError, SchemaTooNewError } from "./errors";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations";
import type { SqliteDatabase } from "./sqlite";

export function schemaVersion(db: SqliteDatabase): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
}

export function migrationSource(db: SqliteDatabase): number {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION) throw new SchemaTooNewError(from, SCHEMA_VERSION);
  if (from < 0) throw new IntegrityError("数据库 schema 版本号异常。");
  if (from === 0) {
    const { total } = db
      .prepare(
        `SELECT count(*) AS total FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get() as { total: number };
    if (total > 0)
      throw new IntegrityError(
        "数据库缺少版本信息但已存在数据表，已停止初始化以避免覆盖现有文件。",
      );
  }
  return from;
}

export function migrateSchema(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  const from = migrationSource(db);
  if (from === SCHEMA_VERSION) return;
  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version > from) db.exec(migration.sql);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}
