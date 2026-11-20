import initSqlite, {
  type SAHPoolUtil,
  type Database,
} from "@sqlite.org/sqlite-wasm";
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";
import { createCommands } from "../worker/commands";
import { createQueries } from "../worker/queries";
import { SqliteWasmDriver } from "../worker/sqlite-wasm-driver";
import {
  migrateSchema,
  migrationSource,
  schemaVersion,
} from "../worker/migrate";
import { SCHEMA_VERSION } from "../worker/migrations";
import {
  BackendUnavailableError,
  IntegrityError,
  MigrationFailedError,
} from "../worker/errors";

const DATABASE = "/pickup.sqlite";
const BACKUP_PREFIX = "/pickup-pre-upgrade-";

function verify(db: SqliteWasmDriver): void {
  const check = db.prepare("PRAGMA quick_check").get() as {
    quick_check: string;
  };
  if (check.quick_check !== "ok")
    throw new IntegrityError("本地数据库一致性检查未通过，原数据已保留。");
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new IntegrityError("本地数据库外键检查未通过，原数据已保留。");
}

export function openPoolStore(
  pool: Pick<SAHPoolUtil, "getFileNames" | "unlink"> & {
    OpfsSAHPoolDb: new (name: string) => Database;
  },
) {
  const names = pool.getFileNames();
  if (!names.includes(DATABASE) && names.length > 0)
    throw new IntegrityError(
      "找不到主数据库，但存储池中仍有文件。已停止初始化以保留原数据。",
    );
  const db = new SqliteWasmDriver(new pool.OpfsSAHPoolDb(DATABASE));
  try {
    db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA",
    );
    const from = migrationSource(db);
    let backupPath: string | null = null;
    if (from > 0 && from < SCHEMA_VERSION) {
      backupPath = `${BACKUP_PREFIX}${Date.now()}-v${from}-${crypto.randomUUID()}.sqlite`;
      try {
        db.prepare("VACUUM INTO ?").run(backupPath);
        const copy = new SqliteWasmDriver(new pool.OpfsSAHPoolDb(backupPath));
        try {
          verify(copy);
          if (schemaVersion(copy) !== from)
            throw new IntegrityError("保护副本版本不一致。");
        } finally {
          copy.close();
        }
      } catch (error) {
        throw new MigrationFailedError(
          "升级前无法生成或校验保护副本，已停止升级，原数据已保留。",
          backupPath,
          { cause: error },
        );
      }
    }
    try {
      migrateSchema(db);
    } catch (error) {
      throw new MigrationFailedError(
        "数据库升级失败，事务已回滚，原数据库与保护副本均保留。",
        backupPath,
        { cause: error },
      );
    }
    verify(db);
    if (backupPath) {
      const backups = pool
        .getFileNames()
        .filter((name) => name.startsWith(BACKUP_PREFIX))
        .sort();
      for (const name of backups.slice(0, -2)) pool.unlink(name);
    }
    return {
      ...createCommands(db),
      ...createQueries(db),
      sqliteVersion: (
        db.prepare("SELECT sqlite_version() AS version").get() as {
          version: string;
        }
      ).version,
      schemaVersion: SCHEMA_VERSION,
      backupPath,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function openMobileStore() {
  if (!globalThis.navigator?.storage?.getDirectory)
    throw new BackendUnavailableError(
      "此浏览器不支持 OPFS 持久存储，无法打开数据库。请使用支持 OPFS 的浏览器；未切换到内存存储。",
    );
  const sqlite = await initSqlite({ locateFile: () => wasmUrl });
  const pool = await sqlite.installOpfsSAHPoolVfs({
    name: "pickup-opfs-sahpool",
    directory: "/pickup-sahpool",
    initialCapacity: 12,
  });
  await pool.reserveMinimumCapacity(12);
  return openPoolStore(pool);
}
