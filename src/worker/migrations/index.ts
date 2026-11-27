import initial from "./001.sql?raw";
import waitingCheckBack from "./002.sql?raw";
import sync from "./003.sql?raw";
import syncConfig from "./004.sql?raw";
import syncContinuity from "./005.sql?raw";
import syncUploadIdentity from "./006.sql?raw";
import accountSession from "./007.sql?raw";
import syncOutbox from "./008.sql?raw";
import notionIntegration from "./009.sql?raw";

/**
 * 按序迁移列表：版本号 = 数组下标 + 1，与 PRAGMA user_version 对应。
 * 已发布的历史迁移文件禁止修改；新增结构变更必须追加新的顺序文件。
 */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: initial },
  { version: 2, sql: waitingCheckBack },
  { version: 3, sql: sync },
  { version: 4, sql: syncConfig },
  { version: 5, sql: syncContinuity },
  { version: 6, sql: syncUploadIdentity },
  { version: 7, sql: accountSession },
  { version: 8, sql: syncOutbox },
  { version: 9, sql: notionIntegration },
];

export const SCHEMA_VERSION = MIGRATIONS.length;
