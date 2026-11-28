import { z } from "zod";

export type ObsidianConfig = {
  enabled: boolean;
  configured: boolean;
  vaultPath: string;
  dailyFolder: string;
  dailyFilenameFormat: string;
  todoSourcePath: string;
  todoTag: string;
  autoWriteback: boolean;
  updatedAt: number;
};

export type ObsidianImportCandidate = {
  externalId: string;
  title: string;
  filePath: string;
  lineNumber: number;
  sourceTitle: string;
  externalUrl: string;
  dueDate: string | null;
  alreadyImported: boolean;
};

export type ObsidianDailyExportRecord = {
  dayKey: string;
  targetPath: string;
  exportedAt: number;
  taskCount: number;
};

const pathStr = z.string().trim().max(1024);
const relPathStr = z.string().trim().max(512);
const tagStr = z.string().trim().max(64);
const formatStr = z.string().trim().min(1).max(64);

export const obsidianImportItemSchema = z
  .object({
    externalId: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(300),
    filePath: relPathStr,
    sourceTitle: z.string().trim().max(300).default(""),
    externalUrl: z.string().trim().max(2000).default(""),
    dueDate: z.string().trim().max(64).nullable().default(null),
  })
  .strict();

export type ObsidianImportItemInput = z.infer<typeof obsidianImportItemSchema>;

export const obsidianInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("getConfig") }).strict(),
  z.object({ action: z.literal("pickVault") }).strict(),
  z
    .object({
      action: z.literal("saveConfig"),
      enabled: z.boolean().optional(),
      vaultPath: pathStr.optional(),
      dailyFolder: relPathStr.optional(),
      dailyFilenameFormat: formatStr.optional(),
      todoSourcePath: relPathStr.optional(),
      todoTag: tagStr.optional(),
      autoWriteback: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("testVault"),
      vaultPath: pathStr.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("fetchImportItems"),
      sourcePath: relPathStr.optional(),
      tag: tagStr.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("importItems"),
      items: z.array(obsidianImportItemSchema).min(1).max(50),
    })
    .strict(),
  z.object({ action: z.literal("getDailyExportStatus") }).strict(),
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

export type ObsidianInput = z.infer<typeof obsidianInputSchema>;

/** 内部 main -> worker 消息。 */
export type WorkerObsidianRequest = {
  input: Exclude<ObsidianInput, { action: "pickVault" }>;
  dayRange?: { dayKey: string; startUtc: number; endUtc: number };
};

export type ObsidianReply =
  | { action: "getConfig"; config: ObsidianConfig }
  | { action: "pickVault"; vaultPath: string | null }
  | { action: "saveConfig"; config: ObsidianConfig }
  | {
      action: "testVault";
      vaultName: string;
      vaultPath: string;
      markdownCount: number;
    }
  | {
      action: "fetchImportItems";
      items: ObsidianImportCandidate[];
      vaultName: string;
      scannedFiles: number;
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
      targetPath: string;
      record: ObsidianDailyExportRecord | null;
      config: ObsidianConfig;
    }
  | {
      action: "exportDailyReview";
      record: ObsidianDailyExportRecord;
      updated: boolean;
    }
  | {
      action: "writeBackTask";
      synced: boolean;
      skippedReason?: string;
    };
