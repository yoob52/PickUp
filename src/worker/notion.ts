import { randomUUID } from "node:crypto";
import type {
  CreateTaskInput,
  CreateTaskValue,
  DailyReview,
  DailyReviewInput,
} from "../shared/contracts";
import type {
  NotionConfig,
  NotionDailyExportRecord,
  NotionExternalType,
  NotionImportItemInput,
  NotionReply,
  NotionSourceType,
  WorkerNotionRequest,
} from "../shared/notion-contracts";
import { DomainError } from "./errors";
import { NotionApiClient } from "./notion-client";
import type { SqliteDatabase } from "./sqlite";

type NotionConfigRow = {
  token_enc: string;
  token_hint: string;
  workspace_name: string;
  daily_parent_id: string;
  daily_parent_title: string;
  import_source_id: string;
  import_source_title: string;
  import_source_type: NotionSourceType;
  auto_writeback: number;
  updated_at: number;
};

type DailyExportRow = {
  day_key: string;
  parent_page_id: string;
  page_id: string;
  page_url: string;
  exported_at: number;
  task_count: number;
};

type ExternalLinkRow = {
  task_id: string;
  provider: "notion";
  external_id: string;
  external_type: NotionExternalType;
  external_url: string;
  source_title: string;
  due_date: string | null;
  last_synced_at: number;
};

function readConfigRow(db: SqliteDatabase): NotionConfigRow {
  return db
    .prepare(
      `SELECT token_enc, token_hint, workspace_name,
              daily_parent_id, daily_parent_title,
              import_source_id, import_source_title, import_source_type,
              auto_writeback, updated_at
       FROM notion_config WHERE singleton = 1`,
    )
    .get() as NotionConfigRow;
}

function readEnabled(db: SqliteDatabase): boolean {
  const row = db
    .prepare(
      `SELECT enabled FROM integration_settings WHERE provider = 'notion'`,
    )
    .get() as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function writeEnabled(db: SqliteDatabase, enabled: boolean, now: number): void {
  db.prepare(
    `INSERT INTO integration_settings(provider, enabled, updated_at)
     VALUES ('notion', ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(enabled ? 1 : 0, now);
}

function toConfig(row: NotionConfigRow, enabled: boolean): NotionConfig {
  const hasToken = row.token_enc.length > 0;
  return {
    enabled,
    connected: hasToken && row.workspace_name.length > 0,
    hasToken,
    tokenHint: row.token_hint,
    workspaceName: row.workspace_name,
    dailyParentId: row.daily_parent_id,
    dailyParentTitle: row.daily_parent_title,
    importSourceId: row.import_source_id,
    importSourceTitle: row.import_source_title,
    importSourceType: row.import_source_type,
    autoWriteback: row.auto_writeback === 1,
    updatedAt: row.updated_at,
  };
}

function readDailyExport(
  db: SqliteDatabase,
  dayKey: string,
): NotionDailyExportRecord | null {
  const row = db
    .prepare(
      `SELECT day_key, parent_page_id, page_id, page_url, exported_at, task_count
       FROM notion_daily_exports WHERE day_key = ?`,
    )
    .get(dayKey) as DailyExportRow | undefined;
  if (!row) return null;
  return {
    dayKey: row.day_key,
    parentPageId: row.parent_page_id,
    pageId: row.page_id,
    pageUrl: row.page_url,
    exportedAt: row.exported_at,
    taskCount: row.task_count,
  };
}

function listImportedNotionIds(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT external_id FROM external_links WHERE provider = 'notion'`)
    .all() as { external_id: string }[];
  return new Set(rows.map((row) => row.external_id));
}

function formatImportedNote(item: NotionImportItemInput): string {
  const parts: string[] = [];
  if (item.sourceTitle) {
    const kind = item.externalType === "database_item" ? "数据库" : "页面";
    parts.push(`来源：Notion「${item.sourceTitle}」${kind}`);
  } else {
    parts.push("来源：Notion");
  }
  if (item.dueDate) parts.push(`日期：${item.dueDate}`);
  if (item.externalUrl) parts.push(`链接：${item.externalUrl}`);
  return parts.join("\n");
}

export type NotionStoreDeps = {
  createTask: (input: CreateTaskInput) => CreateTaskValue;
  dailyReview: (input: DailyReviewInput) => DailyReview;
  api?: NotionApiClient;
};

export function createNotionService(db: SqliteDatabase, deps: NotionStoreDeps) {
  const api = deps.api ?? new NotionApiClient();
  const inFlightExports = new Map<string, Promise<NotionReply>>();

  const importTransaction = db.transaction((items: NotionImportItemInput[]) => {
    const existing = listImportedNotionIds(db);
    const insertLink = db.prepare(
      `INSERT INTO external_links(
           task_id, provider, external_id, external_type,
           external_url, source_title, due_date, last_synced_at
         ) VALUES (?, 'notion', ?, ?, ?, ?, ?, ?)`,
    );
    const taskIds: string[] = [];
    let skippedCount = 0;
    const now = Date.now();
    for (const item of items) {
      if (existing.has(item.externalId)) {
        skippedCount += 1;
        continue;
      }
      const created = deps.createTask({
        commandId: randomUUID(),
        title: item.title,
        note: formatImportedNote(item),
      });
      insertLink.run(
        created.taskId,
        item.externalId,
        item.externalType,
        item.externalUrl,
        item.sourceTitle,
        item.dueDate,
        now,
      );
      existing.add(item.externalId);
      taskIds.push(created.taskId);
    }
    return {
      importedCount: taskIds.length,
      skippedCount,
      taskIds,
    };
  });

  function getEncryptedToken(): string {
    return readConfigRow(db).token_enc;
  }

  async function handle(req: WorkerNotionRequest): Promise<NotionReply> {
    const { input } = req;

    switch (input.action) {
      case "getConfig": {
        return {
          action: "getConfig",
          config: toConfig(readConfigRow(db), readEnabled(db)),
        };
      }

      case "saveConfig": {
        const current = readConfigRow(db);
        const now = Date.now();
        if (input.enabled !== undefined) {
          writeEnabled(db, input.enabled, now);
        }
        let nextTokenEnc = current.token_enc;
        let nextTokenHint = current.token_hint;
        let nextWorkspace =
          input.workspaceName !== undefined
            ? input.workspaceName
            : current.workspace_name;

        if (input.clearToken) {
          nextTokenEnc = "";
          nextTokenHint = "";
          nextWorkspace = "";
        } else if (req.encryptedToken !== undefined) {
          nextTokenEnc = req.encryptedToken;
          nextTokenHint = req.tokenHint ?? "";
        }

        const nextDailyParentId =
          input.dailyParentId !== undefined
            ? input.dailyParentId
            : current.daily_parent_id;
        const nextDailyParentTitle =
          input.dailyParentTitle !== undefined
            ? input.dailyParentTitle
            : current.daily_parent_title;
        const nextImportSourceId =
          input.importSourceId !== undefined
            ? input.importSourceId
            : current.import_source_id;
        const nextImportSourceTitle =
          input.importSourceTitle !== undefined
            ? input.importSourceTitle
            : current.import_source_title;
        const nextImportSourceType =
          input.importSourceType !== undefined
            ? input.importSourceType
            : current.import_source_type;
        const nextAutoWriteback =
          input.autoWriteback !== undefined
            ? input.autoWriteback
              ? 1
              : 0
            : current.auto_writeback;

        db.prepare(
          `UPDATE notion_config SET
             token_enc = ?,
             token_hint = ?,
             workspace_name = ?,
             daily_parent_id = ?,
             daily_parent_title = ?,
             import_source_id = ?,
             import_source_title = ?,
             import_source_type = ?,
             auto_writeback = ?,
             updated_at = ?
           WHERE singleton = 1`,
        ).run(
          nextTokenEnc,
          nextTokenHint,
          nextWorkspace,
          nextDailyParentId,
          nextDailyParentTitle,
          nextImportSourceId,
          nextImportSourceTitle,
          nextImportSourceType,
          nextAutoWriteback,
          now,
        );
        return {
          action: "saveConfig",
          config: toConfig(readConfigRow(db), readEnabled(db)),
        };
      }

      case "testConnection": {
        const token = req.plainToken ?? "";
        const [bot, targets] = await Promise.all([
          api.getBotUser(token),
          api.searchTargets(token),
        ]);
        const current = readConfigRow(db);
        if (current.token_enc.length > 0 && !input.token) {
          db.prepare(
            `UPDATE notion_config SET workspace_name = ?, updated_at = ? WHERE singleton = 1`,
          ).run(bot.workspaceName, Date.now());
        }
        return {
          action: "testConnection",
          workspaceName: bot.workspaceName,
          botName: bot.botName,
          targets,
        };
      }

      case "listTargets": {
        const targets = await api.searchTargets(req.plainToken ?? "");
        return { action: "listTargets", targets };
      }

      case "fetchImportItems": {
        const config = readConfigRow(db);
        const token = req.plainToken ?? "";
        if (!token) {
          throw DomainError.validation("请先在设置中配置 Notion Token。");
        }
        const importedIds = listImportedNotionIds(db);

        let sourceId = input.sourceId || config.import_source_id;
        let sourceTitle = config.import_source_title;
        let sourceType: "database" | "page" =
          input.tab ??
          (config.import_source_type === "page" ? "page" : "database");

        if (
          input.tab &&
          !input.sourceId &&
          config.import_source_type &&
          config.import_source_type !== input.tab
        ) {
          const targets = await api.searchTargets(token);
          const matched = targets.find((t) => t.type === input.tab);
          if (!matched) {
            return {
              action: "fetchImportItems",
              items: [],
              sourceTitle: "",
              sourceType: input.tab,
            };
          }
          sourceId = matched.id;
          sourceTitle = matched.title;
          sourceType = matched.type;
        }

        if (!sourceId) {
          throw DomainError.validation(
            "请先在设置中选择 Notion 待办或日程来源。",
          );
        }

        const items =
          sourceType === "database"
            ? await api.queryDatabaseItems(
                token,
                sourceId,
                sourceTitle || "Notion 数据库",
                importedIds,
              )
            : await api.fetchPageTodoBlocks(
                token,
                sourceId,
                sourceTitle || "Notion 页面",
                importedIds,
              );

        return {
          action: "fetchImportItems",
          items,
          sourceTitle:
            sourceTitle ||
            (sourceType === "database" ? "Notion 数据库" : "Notion 页面"),
          sourceType,
        };
      }

      case "importItems": {
        const result = importTransaction(input.items);
        return {
          action: "importItems",
          ...result,
        };
      }

      case "getDailyExportStatus": {
        if (!req.dayRange) {
          throw DomainError.validation("缺少本地日期范围。");
        }
        return {
          action: "getDailyExportStatus",
          dayKey: req.dayRange.dayKey,
          record: readDailyExport(db, req.dayRange.dayKey),
          config: toConfig(readConfigRow(db), readEnabled(db)),
        };
      }

      case "exportDailyReview": {
        if (!req.dayRange) {
          throw DomainError.validation("缺少本地日期范围。");
        }
        const dayRange = req.dayRange;
        const existingJob = inFlightExports.get(dayRange.dayKey);
        if (existingJob) {
          return await existingJob;
        }

        const run = (async (): Promise<NotionReply> => {
          const config = readConfigRow(db);
          const token = req.plainToken ?? "";
          if (!token) {
            throw DomainError.validation("请先在设置中配置 Notion Token。");
          }
          if (!config.daily_parent_id) {
            throw DomainError.validation("请先在设置中选择日报写入的父页面。");
          }

          const firstReview = deps.dailyReview({
            dayKey: dayRange.dayKey,
            startUtc: dayRange.startUtc,
            endUtc: dayRange.endUtc,
            completedOffset: 0,
            completedLimit: 200,
          });
          const completedTasks = [...firstReview.completedToday.items];
          let offset = firstReview.completedToday.items.length;
          let hasMore = firstReview.completedToday.hasMore;
          while (hasMore && offset < 2000) {
            const nextPage = deps.dailyReview({
              dayKey: dayRange.dayKey,
              startUtc: dayRange.startUtc,
              endUtc: dayRange.endUtc,
              completedOffset: offset,
              completedLimit: 200,
            });
            if (nextPage.completedToday.items.length === 0) break;
            completedTasks.push(...nextPage.completedToday.items);
            offset += nextPage.completedToday.items.length;
            hasMore = nextPage.completedToday.hasMore;
          }

          const upsertExportRow = (record: NotionDailyExportRecord) => {
            db.prepare(
              `INSERT INTO notion_daily_exports(
                 day_key, parent_page_id, page_id, page_url, exported_at, task_count
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(day_key) DO UPDATE SET
                 parent_page_id = excluded.parent_page_id,
                 page_id = excluded.page_id,
                 page_url = excluded.page_url,
                 exported_at = excluded.exported_at,
                 task_count = excluded.task_count`,
            ).run(
              record.dayKey,
              record.parentPageId,
              record.pageId,
              record.pageUrl,
              record.exportedAt,
              record.taskCount,
            );
          };

          const existing = readDailyExport(db, dayRange.dayKey);
          const result = await api.upsertDailyPage(token, {
            parentPageId: config.daily_parent_id,
            existingPageId:
              existing && existing.parentPageId === config.daily_parent_id
                ? existing.pageId
                : null,
            dayKey: dayRange.dayKey,
            completedTasks,
            unfinishedCount: firstReview.counts.unfinished,
            currentTaskTitle: firstReview.currentTask?.title ?? null,
            includeBreakpoints: input.includeBreakpoints,
            onPageCreated: (pageId, pageUrl) => {
              upsertExportRow({
                dayKey: dayRange.dayKey,
                parentPageId: config.daily_parent_id,
                pageId,
                pageUrl,
                exportedAt: Date.now(),
                taskCount: 0,
              });
            },
          });

          const exportedAt = Date.now();
          const record: NotionDailyExportRecord = {
            dayKey: dayRange.dayKey,
            parentPageId: config.daily_parent_id,
            pageId: result.pageId,
            pageUrl: result.pageUrl,
            exportedAt,
            taskCount: completedTasks.length,
          };

          upsertExportRow(record);

          return {
            action: "exportDailyReview",
            record,
            updated: result.updated,
          };
        })();

        inFlightExports.set(dayRange.dayKey, run);
        try {
          return await run;
        } finally {
          if (inFlightExports.get(dayRange.dayKey) === run) {
            inFlightExports.delete(dayRange.dayKey);
          }
        }
      }

      case "writeBackTask": {
        if (!readEnabled(db)) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "Notion 集成未启用。",
          };
        }
        const config = readConfigRow(db);
        if (config.auto_writeback !== 1) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "disabled",
          };
        }
        const token = req.plainToken ?? "";
        if (!token) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "no_token",
          };
        }
        const link = db
          .prepare(
            `SELECT task_id, provider, external_id, external_type, external_url, source_title, due_date, last_synced_at
             FROM external_links WHERE task_id = ? AND provider = 'notion'`,
          )
          .get(input.taskId) as ExternalLinkRow | undefined;
        if (!link) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "not_linked",
          };
        }
        const synced = await api.markExternalDone(
          token,
          link.external_id,
          link.external_type,
        );
        if (synced) {
          db.prepare(
            `UPDATE external_links SET last_synced_at = ? WHERE task_id = ?`,
          ).run(Date.now(), input.taskId);
        }
        return { action: "writeBackTask", synced };
      }
    }
  }

  return {
    getEncryptedToken,
    handle,
  };
}
