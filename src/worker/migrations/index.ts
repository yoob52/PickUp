import initial from "./001.sql?raw";

/**
 * 按序迁移列表：版本号 = 数组下标 + 1，与 PRAGMA user_version 对应。
 * 已发布的历史迁移文件禁止修改；新增结构变更必须追加新的顺序文件。
 */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: initial },
];

export const SCHEMA_VERSION = MIGRATIONS.length;
