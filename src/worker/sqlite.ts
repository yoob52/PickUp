export interface SqliteStatement {
  run(...params: unknown[]): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): (...args: Args) => Result;
  close(): unknown;
}
