import type {
  Database,
  PreparedStatement,
  SqlValue,
} from "@sqlite.org/sqlite-wasm";
import type { SqliteDatabase, SqliteStatement } from "./sqlite";

function bindValue(value: unknown): SqlValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  )
    return value;
  throw new TypeError("Unsupported SQLite binding");
}

function bind(stmt: PreparedStatement, params: unknown[]): void {
  const positional = params.flatMap((param) =>
    Array.isArray(param) ? param : [param],
  );
  const bound = new Set<number>();
  const values: unknown[] = [];
  for (const param of positional) {
    if (
      param !== null &&
      typeof param === "object" &&
      !(param instanceof Uint8Array)
    ) {
      for (const [key, value] of Object.entries(param)) {
        for (const prefix of ["@", ":", "$"]) {
          const index = stmt.getParamIndex(prefix + key);
          if (index) {
            stmt.bind(index, bindValue(value));
            bound.add(index);
          }
        }
      }
    } else values.push(param);
  }
  let offset = 0;
  for (let index = 1; index <= stmt.parameterCount; index++) {
    if (bound.has(index)) continue;
    if (offset === values.length)
      throw new RangeError("Missing SQLite binding");
    stmt.bind(index, bindValue(values[offset++]));
  }
  if (offset !== values.length)
    throw new RangeError("Too many SQLite bindings");
}

const SQLITE_BLOB = 4;
const utf8 = new TextDecoder();

// oo1 reads TEXT as NUL-terminated; read the bytes so embedded NULs survive.
function row(stmt: PreparedStatement): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < stmt.columnCount; index++) {
    const value = stmt.get(index);
    result[stmt.getColumnName(index)] =
      typeof value === "bigint"
        ? Number(value)
        : typeof value === "string"
          ? utf8.decode(stmt.get(index, SQLITE_BLOB) as Uint8Array)
          : value;
  }
  return result;
}

export class SqliteWasmDriver implements SqliteDatabase {
  private savepoint = 0;

  constructor(private readonly db: Database) {}

  prepare(sql: string): SqliteStatement {
    const execute = <T>(
      params: unknown[],
      read: (stmt: PreparedStatement) => T,
    ): T => {
      const stmt = this.db.prepare(sql);
      try {
        bind(stmt, params);
        return read(stmt);
      } finally {
        stmt.finalize();
      }
    };
    return {
      run: (...params) =>
        execute(params, (stmt) => {
          while (stmt.step()) {
            /* Drain RETURNING rows before reporting changes. */
          }
          return {
            changes: this.db.changes(),
            lastInsertRowid: Number(
              this.db.selectValue("SELECT last_insert_rowid()"),
            ),
          };
        }),
      get: (...params) =>
        execute(params, (stmt) => (stmt.step() ? row(stmt) : undefined)),
      all: (...params) =>
        execute(params, (stmt) => {
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(row(stmt));
          return rows;
        }),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): (...args: Args) => Result {
    return (...args) => {
      const name = `pickup_tx_${++this.savepoint}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn(...args);
        if (result instanceof Promise)
          throw new TypeError("SQLite transactions must be synchronous");
        this.db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
