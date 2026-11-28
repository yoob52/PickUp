import { z } from "zod";

export const notionSourceTypeSchema = z.enum(["", "database", "page"]);
export type NotionSourceType = z.infer<typeof notionSourceTypeSchema>;

export const integrationProviderSchema = z.enum(["notion", "obsidian"]);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;

export const externalTypeSchema = z.enum([
  "database_item",
  "todo_block",
  "markdown_todo",
]);
export type ExternalLinkType = z.infer<typeof externalTypeSchema>;

export const notionExternalTypeSchema = z.enum(["database_item", "todo_block"]);
export type NotionExternalType = z.infer<typeof notionExternalTypeSchema>;

export type ExternalLinkSummary = {
  provider: IntegrationProvider;
  externalId: string;
  externalType: ExternalLinkType;
  externalUrl: string;
  sourceTitle: string;
  dueDate: string | null;
};

export type NotionConfig = {
  enabled: boolean;
  connected: boolean;
  hasToken: boolean;
  tokenHint: string;
  workspaceName: string;
  dailyParentId: string;
  dailyParentTitle: string;
  importSourceId: string;
  importSourceTitle: string;
  importSourceType: NotionSourceType;
  autoWriteback: boolean;
  updatedAt: number;
};

export type NotionTargetOption = {
  id: string;
  title: string;
  type: "page" | "database";
  url: string;
};

export type NotionImportCandidate = {
  externalId: string;
  externalType: NotionExternalType;
  title: string;
  sourceTitle: string;
  externalUrl: string;
  dueDate: string | null;
  statusLabel: string;
  alreadyImported: boolean;
};

export type NotionDailyExportRecord = {
  dayKey: string;
  parentPageId: string;
  pageId: string;
  pageUrl: string;
  exportedAt: number;
  taskCount: number;
};

const nonEmptyId = z.string().trim().min(1).max(128);
const optionalId = z.string().trim().max(128);
const titleStr = z.string().trim().max(300);

export const notionImportItemSchema = z
  .object({
    externalId: nonEmptyId,
    externalType: notionExternalTypeSchema,
    title: z.string().trim().min(1).max(300),
    sourceTitle: titleStr.default(""),
    externalUrl: z.string().trim().max(2000).default(""),
    dueDate: z.string().trim().max(64).nullable().default(null),
  })
  .strict();
export type NotionImportItemInput = z.infer<typeof notionImportItemSchema>;

export const notionInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("getConfig") }).strict(),
  z
    .object({
      action: z.literal("saveConfig"),
      enabled: z.boolean().optional(),
      token: z.string().trim().max(512).optional(),
      clearToken: z.boolean().optional(),
      workspaceName: titleStr.optional(),
      dailyParentId: optionalId.optional(),
      dailyParentTitle: titleStr.optional(),
      importSourceId: optionalId.optional(),
      importSourceTitle: titleStr.optional(),
      importSourceType: notionSourceTypeSchema.optional(),
      autoWriteback: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("testConnection"),
      token: z.string().trim().max(512).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("listTargets"),
      token: z.string().trim().max(512).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("fetchImportItems"),
      tab: z.enum(["database", "page"]).optional(),
      sourceId: optionalId.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("importItems"),
      items: z.array(notionImportItemSchema).min(1).max(50),
    })
    .strict(),
  z
    .object({
      action: z.literal("getDailyExportStatus"),
    })
    .strict(),
  z
    .object({
      action: z.literal("exportDailyReview"),
      includeBreakpoints: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("writeBackTask"),
      taskId: z.uuid(),
    })
    .strict(),
]);

export type NotionInput = z.infer<typeof notionInputSchema>;

/** 内部 main -> worker 消息（仅主进程可附加解密后的内存 token 与加密密文）。 */
export type WorkerNotionRequest = {
  input: NotionInput;
  /** 本次请求在内存中使用的明文 token（由 main safeStorage 解密或用户输入，不落日志）。 */
  plainToken?: string;
  /** saveConfig 时由 main safeStorage 加密后的密文。 */
  encryptedToken?: string;
  /** saveConfig 时计算的安全脱敏提示（如 ntn_••••1234）。 */
  tokenHint?: string;
  /** exportDailyReview / getDailyExportStatus 由宿主计算的本地日期范围。 */
  dayRange?: { dayKey: string; startUtc: number; endUtc: number };
};

export type NotionReply =
  | { action: "getConfig"; config: NotionConfig }
  | { action: "saveConfig"; config: NotionConfig }
  | {
      action: "testConnection";
      workspaceName: string;
      botName: string;
      targets: NotionTargetOption[];
    }
  | { action: "listTargets"; targets: NotionTargetOption[] }
  | {
      action: "fetchImportItems";
      items: NotionImportCandidate[];
      sourceTitle: string;
      sourceType: "database" | "page";
    }
  | {
      action: "importItems";
      importedCount: number;
      skippedCount: number;
      taskIds: string[];
    }
  | {
      action: "getDailyExportStatus";
      dayKey: string;
      record: NotionDailyExportRecord | null;
      config: NotionConfig;
    }
  | {
      action: "exportDailyReview";
      record: NotionDailyExportRecord;
      updated: boolean;
    }
  | {
      action: "writeBackTask";
      synced: boolean;
      skippedReason?: string;
    };
