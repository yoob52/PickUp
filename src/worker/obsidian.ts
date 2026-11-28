import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CreateTaskInput,
  CreateTaskValue,
  DailyReview,
  DailyReviewInput,
  TaskSummary,
} from "../shared/contracts";
import type {
  ObsidianConfig,
  ObsidianDailyExportRecord,
  ObsidianImportCandidate,
  ObsidianImportItemInput,
  ObsidianReply,
  WorkerObsidianRequest,
} from "../shared/obsidian-contracts";
import { DomainError } from "./errors";
import type { SqliteDatabase } from "./sqlite";

const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const MAX_SCAN_FILES = 300;
const MAX_SCAN_CANDIDATES = 300;
const MAX_FILE_BYTES = 1024 * 1024; // 1MB guard per markdown file

type ObsidianConfigRow = {
  vault_path: string;
  daily_folder: string;
  daily_filename_format: string;
  todo_source_path: string;
  todo_tag: string;
  auto_writeback: number;
  updated_at: number;
};

type DailyExportRow = {
  day_key: string;
  target_path: string;
  exported_at: number;
  task_count: number;
};

export type ObsidianStoreDeps = {
  createTask: (input: CreateTaskInput) => CreateTaskValue;
  dailyReview: (input: DailyReviewInput) => DailyReview;
};

function readEnabled(db: SqliteDatabase): boolean {
  const row = db
    .prepare(
      `SELECT enabled FROM integration_settings WHERE provider = 'obsidian'`,
    )
    .get() as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function writeEnabled(db: SqliteDatabase, enabled: boolean, now: number): void {
  db.prepare(
    `INSERT INTO integration_settings(provider, enabled, updated_at)
     VALUES ('obsidian', ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(enabled ? 1 : 0, now);
}

function readConfigRow(db: SqliteDatabase): ObsidianConfigRow {
  return db
    .prepare(
      `SELECT vault_path, daily_folder, daily_filename_format,
              todo_source_path, todo_tag, auto_writeback, updated_at
       FROM obsidian_config WHERE singleton = 1`,
    )
    .get() as ObsidianConfigRow;
}

function toConfig(row: ObsidianConfigRow, enabled: boolean): ObsidianConfig {
  return {
    enabled,
    configured: row.vault_path.trim().length > 0,
    vaultPath: row.vault_path,
    dailyFolder: row.daily_folder,
    dailyFilenameFormat: row.daily_filename_format || "YYYY-MM-DD",
    todoSourcePath: row.todo_source_path,
    todoTag: row.todo_tag,
    autoWriteback: row.auto_writeback === 1,
    updatedAt: row.updated_at,
  };
}

function readDailyExport(
  db: SqliteDatabase,
  dayKey: string,
): ObsidianDailyExportRecord | null {
  const row = db
    .prepare(
      `SELECT day_key, target_path, exported_at, task_count
       FROM integration_daily_exports
       WHERE provider = 'obsidian' AND day_key = ?`,
    )
    .get(dayKey) as DailyExportRow | undefined;
  if (!row) return null;
  return {
    dayKey: row.day_key,
    targetPath: row.target_path,
    exportedAt: row.exported_at,
    taskCount: row.task_count,
  };
}

function listImportedObsidianIds(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare(
      `SELECT external_id FROM external_links WHERE provider = 'obsidian'`,
    )
    .all() as { external_id: string }[];
  return new Set(rows.map((row) => row.external_id));
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function assertVaultDir(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw DomainError.validation("请先选择 Obsidian Vault 目录。");
  }
  let real: string;
  try {
    real = fs.realpathSync(trimmed);
  } catch {
    throw DomainError.validation("所选 Obsidian Vault 目录不存在或无法访问。");
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw DomainError.validation("所选路径不是文件夹，请选择 Vault 根目录。");
  }
  return real;
}

function isInsideRoot(rootReal: string, candidate: string): boolean {
  const rel = path.relative(rootReal, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 严格限制相对路径落在 Vault 根目录内部，防止路径穿越或符号链接越界。 */
export function resolveInsideVault(
  vaultReal: string,
  relativePath: string,
): string {
  const cleaned = relativePath.trim().replace(/\\/g, "/");
  if (!cleaned) return vaultReal;
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw DomainError.validation("Vault 内路径必须为相对路径。");
  }
  const resolved = path.resolve(vaultReal, cleaned);
  if (!isInsideRoot(vaultReal, resolved)) {
    throw DomainError.validation("路径超出 Obsidian Vault 目录范围，已拒绝。");
  }
  if (fs.existsSync(resolved)) {
    const realTarget = fs.realpathSync(resolved);
    if (!isInsideRoot(vaultReal, realTarget)) {
      throw DomainError.validation("目标符号链接超出 Vault 目录范围，已拒绝。");
    }
    return realTarget;
  }
  return resolved;
}

export function buildDailyRelativePath(
  dailyFolder: string,
  filenameFormat: string,
  dayKey: string,
): string {
  const rawFormat = filenameFormat.trim() || "YYYY-MM-DD";
  if (
    rawFormat.includes("..") ||
    rawFormat.includes("/") ||
    rawFormat.includes("\\")
  ) {
    throw DomainError.validation("日记文件名格式不能包含路径分隔符或 ..。");
  }
  const [yyyy, mm, dd] = dayKey.split("-");
  const baseFormat = rawFormat
    .replace(/YYYY/g, yyyy ?? dayKey)
    .replace(/MM/g, mm ?? "")
    .replace(/DD/g, dd ?? "")
    .replace(/[:*?"<>|]/g, "-");
  const filename = baseFormat.toLowerCase().endsWith(".md")
    ? baseFormat
    : `${baseFormat}.md`;
  const folder = dailyFolder
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${filename}` : filename;
}

function normalizeTodoText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function hashTodoTitle(raw: string): string {
  return createHash("sha1")
    .update(normalizeTodoText(raw))
    .digest("hex")
    .slice(0, 16);
}

function extractDueDate(line: string): string | null {
  const match =
    line.match(/(?:📅|due::|@due\(|@)\s*(\d{4}-\d{2}-\d{2})/i) ?? null;
  return match?.[1] ?? null;
}

function cleanTodoTitle(raw: string): string {
  return normalizeTodoText(
    raw
      .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
      .replace(/@due\(\d{4}-\d{2}-\d{2}\)/gi, "")
      .replace(/due::\s*\d{4}-\d{2}-\d{2}/gi, ""),
  ).slice(0, 300);
}

function matchesTag(raw: string, tagFilter: string): boolean {
  const cleaned = tagFilter.trim().replace(/^#/, "");
  if (!cleaned) return true;
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|\\s)#${escaped}(?=$|[\\s/.,;:!?])`, "i");
  return regex.test(raw);
}

function buildObsidianUrl(vaultName: string, relPosixPath: string): string {
  const withoutExt = relPosixPath.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(withoutExt)}`;
}

function collectMarkdownFiles(
  vaultReal: string,
  targetPath: string,
  limit = MAX_SCAN_FILES,
): string[] {
  const files: string[] = [];
  if (!fs.existsSync(targetPath)) return files;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (targetPath.toLowerCase().endsWith(".md")) files.push(targetPath);
    return files;
  }
  const queue: string[] = [targetPath];
  while (queue.length > 0 && files.length < limit) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (!isInsideRoot(vaultReal, full)) continue;
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }
  return files;
}

type CodeFence = { char: "`" | "~"; length: number };

function updateFenceState(
  line: string,
  active: CodeFence | null,
): { active: CodeFence | null; isFenceLine: boolean } {
  if (active === null) {
    const open = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!open) return { active: null, isFenceLine: false };
    const marker = open[1]!;
    const rest = open[2] ?? "";
    const char = marker[0] as "`" | "~";
    if (char === "`" && rest.includes("`")) {
      return { active: null, isFenceLine: false };
    }
    return { active: { char, length: marker.length }, isFenceLine: true };
  }
  const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  if (
    close &&
    close[1]![0] === active.char &&
    close[1]!.length >= active.length
  ) {
    return { active: null, isFenceLine: true };
  }
  return { active, isFenceLine: false };
}

export function vaultFingerprint(vaultReal: string): string {
  return createHash("sha1").update(vaultReal).digest("hex").slice(0, 12);
}

function parseObsidianExternalId(externalId: string): {
  vaultKey: string | null;
  relPosixPath: string;
  expectedHash: string;
  occurrence: number;
} | null {
  const lastSep = externalId.lastIndexOf("::");
  if (lastSep <= 0) return null;
  const hashSpec = externalId.slice(lastSep + 2);
  const prefix = externalId.slice(0, lastSep);
  if (!hashSpec || !prefix) return null;

  let vaultKey: string | null = null;
  let relPosixPath = prefix;
  const firstSep = prefix.indexOf("::");
  if (firstSep > 0) {
    vaultKey = prefix.slice(0, firstSep);
    relPosixPath = prefix.slice(firstSep + 2);
  }
  if (!relPosixPath) return null;

  const occIdx = hashSpec.lastIndexOf("#");
  const expectedHash = occIdx > 0 ? hashSpec.slice(0, occIdx) : hashSpec;
  const parsedOcc = occIdx > 0 ? Number(hashSpec.slice(occIdx + 1)) : 1;
  const occurrence =
    Number.isInteger(parsedOcc) && parsedOcc >= 1 ? parsedOcc : 1;
  return { vaultKey, relPosixPath, expectedHash, occurrence };
}

export function parseMarkdownTodos(
  content: string,
  relPosixPath: string,
  vaultName: string,
  tagFilter: string,
  importedIds: Set<string>,
  vaultKey = "",
): ObsidianImportCandidate[] {
  const candidates: ObsidianImportCandidate[] = [];
  const lines = content.split(/\r?\n/);
  const sourceTitle = path.posix.basename(relPosixPath, ".md");
  const url = buildObsidianUrl(vaultName, relPosixPath);
  const seenCounts = new Map<string, number>();
  let fence: CodeFence | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceStep = updateFenceState(line, fence);
    fence = fenceStep.active;
    if (fenceStep.isFenceLine || fence !== null) continue;
    const anyCheckbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (!anyCheckbox) continue;
    const state = anyCheckbox[1]!;
    const rawBody = anyCheckbox[2]!.trim();
    if (!rawBody) continue;
    const lineHash = hashTodoTitle(rawBody);
    const occurrence = (seenCounts.get(lineHash) ?? 0) + 1;
    seenCounts.set(lineHash, occurrence);
    if (state !== " ") continue;
    if (!matchesTag(rawBody, tagFilter)) continue;
    const title = cleanTodoTitle(rawBody);
    if (!title) continue;
    const idPrefix = vaultKey ? `${vaultKey}::${relPosixPath}` : relPosixPath;
    const externalId = `${idPrefix}::${lineHash}#${occurrence}`;
    candidates.push({
      externalId,
      title,
      filePath: relPosixPath,
      lineNumber: i + 1,
      sourceTitle,
      externalUrl: url,
      dueDate: extractDueDate(rawBody),
      alreadyImported: importedIds.has(externalId),
    });
  }
  return candidates;
}

export function renderDailyMarkdownSection(params: {
  dayKey: string;
  completedTasks: TaskSummary[];
  unfinishedCount: number;
  currentTaskTitle: string | null;
  includeBreakpoints: boolean;
}): string {
  const startMarker = `<!-- pickup:daily:start:${params.dayKey} -->`;
  const endMarker = `<!-- pickup:daily:end:${params.dayKey} -->`;
  const lines: string[] = [
    startMarker,
    `## PickUp 每日总结（${params.dayKey}）`,
    "",
  ];
  if (params.completedTasks.length === 0) {
    lines.push("- 今天还没有已完成的事项。");
  } else {
    for (const task of params.completedTasks) {
      const bp =
        params.includeBreakpoints && task.latestBreakpoint
          ? task.latestBreakpoint.progress || task.latestBreakpoint.nextStep
          : "";
      lines.push(bp ? `- [x] ${task.title}（${bp}）` : `- [x] ${task.title}`);
    }
  }
  const summaryParts = [
    `已完成 ${params.completedTasks.length} 项`,
    `未结束 ${params.unfinishedCount} 项`,
  ];
  if (params.currentTaskTitle) {
    summaryParts.push(`当前进行：${params.currentTaskTitle}`);
  }
  lines.push(
    "",
    `> 由 PickUp 自动同步 · ${summaryParts.join(" · ")}`,
    endMarker,
  );
  return lines.join("\n");
}

export function mergeDailyMarkdownContent(
  existingContent: string | null,
  dayKey: string,
  section: string,
): { content: string; updated: boolean } {
  if (existingContent === null) {
    return {
      content: `# ${dayKey}\n\n${section}\n`,
      updated: false,
    };
  }
  const startMarker = `<!-- pickup:daily:start:${dayKey} -->`;
  const endMarker = `<!-- pickup:daily:end:${dayKey} -->`;
  const startIdx = existingContent.indexOf(startMarker);
  const endIdx = existingContent.indexOf(endMarker);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + endMarker.length);
    return {
      content: `${before}${section}${after}`,
      updated: true,
    };
  }
  const trimmed = existingContent.replace(/\s+$/, "");
  const next = trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
  return { content: next, updated: true };
}

function ensureSafeDirInsideVault(vaultReal: string, dirPath: string): void {
  const rel = path.relative(vaultReal, dirPath);
  if (rel === "") return;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw DomainError.validation(
      "日报目录超出 Obsidian Vault 范围，已拒绝写入。",
    );
  }
  const segments = rel.split(path.sep).filter(Boolean);
  let cursor = vaultReal;
  for (const segment of segments) {
    const next = path.join(cursor, segment);
    if (fs.existsSync(next)) {
      const realNext = fs.realpathSync(next);
      if (!isInsideRoot(vaultReal, realNext)) {
        throw DomainError.validation(
          "日报目录包含指向 Vault 外部的符号链接，已拒绝写入。",
        );
      }
      if (!fs.statSync(realNext).isDirectory()) {
        throw DomainError.validation("日报路径中的父级目标不是文件夹。");
      }
      cursor = realNext;
    } else {
      fs.mkdirSync(next);
      cursor = next;
    }
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  let existingMode: number | null = null;
  if (fs.existsSync(filePath)) {
    existingMode = fs.statSync(filePath).mode & 0o777;
  }
  const tmpPath = path.join(
    dir,
    `.pickup-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  fs.writeFileSync(tmpPath, content, {
    encoding: "utf8",
    mode: existingMode ?? 0o600,
  });
  if (existingMode !== null && process.platform !== "win32") {
    fs.chmodSync(tmpPath, existingMode);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw error;
  }
}

function formatImportedNote(item: ObsidianImportItemInput): string {
  const parts: string[] = [];
  if (item.filePath) {
    parts.push(`来源：Obsidian「${item.filePath}」`);
  } else {
    parts.push("来源：Obsidian");
  }
  if (item.dueDate) parts.push(`日期：${item.dueDate}`);
  if (item.externalUrl) parts.push(`链接：${item.externalUrl}`);
  return parts.join("\n");
}

export function createObsidianService(
  db: SqliteDatabase,
  deps: ObsidianStoreDeps,
) {
  const inFlightExports = new Map<string, Promise<ObsidianReply>>();

  const importTransaction = db.transaction(
    (items: ObsidianImportItemInput[]) => {
      const existing = listImportedObsidianIds(db);
      const insertLink = db.prepare(
        `INSERT INTO external_links(
           task_id, provider, external_id, external_type,
           external_url, source_title, due_date, last_synced_at
         ) VALUES (?, 'obsidian', ?, 'markdown_todo', ?, ?, ?, ?)`,
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
          item.externalUrl,
          item.sourceTitle || item.filePath,
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
    },
  );

  async function handle(req: WorkerObsidianRequest): Promise<ObsidianReply> {
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
        const nextVault =
          input.vaultPath !== undefined
            ? input.vaultPath.trim()
            : current.vault_path;
        const nextDailyFolder =
          input.dailyFolder !== undefined
            ? input.dailyFolder.trim()
            : current.daily_folder;
        const nextDailyFormat =
          input.dailyFilenameFormat !== undefined
            ? input.dailyFilenameFormat.trim() || "YYYY-MM-DD"
            : current.daily_filename_format;
        const nextTodoSource =
          input.todoSourcePath !== undefined
            ? input.todoSourcePath.trim()
            : current.todo_source_path;
        const nextTodoTag =
          input.todoTag !== undefined ? input.todoTag.trim() : current.todo_tag;
        const nextAutoWriteback =
          input.autoWriteback !== undefined
            ? input.autoWriteback
              ? 1
              : 0
            : current.auto_writeback;

        // Validate daily folder & filename format before persisting so Daily Review never silently hides export
        const previewDailyRel = buildDailyRelativePath(
          nextDailyFolder,
          nextDailyFormat,
          "2026-01-01",
        );
        if (nextVault) {
          const vaultReal = assertVaultDir(nextVault);
          resolveInsideVault(vaultReal, previewDailyRel);
          if (nextTodoSource) {
            resolveInsideVault(vaultReal, nextTodoSource);
          }
        }

        if (input.enabled !== undefined) {
          writeEnabled(db, input.enabled, now);
        }

        db.prepare(
          `UPDATE obsidian_config SET
             vault_path = ?,
             daily_folder = ?,
             daily_filename_format = ?,
             todo_source_path = ?,
             todo_tag = ?,
             auto_writeback = ?,
             updated_at = ?
           WHERE singleton = 1`,
        ).run(
          nextVault,
          nextDailyFolder,
          nextDailyFormat,
          nextTodoSource,
          nextTodoTag,
          nextAutoWriteback,
          now,
        );
        return {
          action: "saveConfig",
          config: toConfig(readConfigRow(db), readEnabled(db)),
        };
      }

      case "testVault": {
        const config = readConfigRow(db);
        const vaultReal = assertVaultDir(input.vaultPath ?? config.vault_path);
        const mdFiles = collectMarkdownFiles(vaultReal, vaultReal, 500);
        return {
          action: "testVault",
          vaultName: path.basename(vaultReal),
          vaultPath: vaultReal,
          markdownCount: mdFiles.length,
        };
      }

      case "fetchImportItems": {
        const config = readConfigRow(db);
        const vaultReal = assertVaultDir(config.vault_path);
        const vaultName = path.basename(vaultReal);
        const sourceRel = input.sourcePath ?? config.todo_source_path;
        const tagFilter = input.tag ?? config.todo_tag;
        const target = resolveInsideVault(vaultReal, sourceRel);
        if (!fs.existsSync(target)) {
          throw DomainError.validation(
            sourceRel
              ? `Vault 中未找到路径「${sourceRel}」。`
              : "Obsidian Vault 目录不存在。",
          );
        }
        const files = collectMarkdownFiles(vaultReal, target, MAX_SCAN_FILES);
        const importedIds = listImportedObsidianIds(db);
        const vaultKey = vaultFingerprint(vaultReal);
        const unimported: ObsidianImportCandidate[] = [];
        const imported: ObsidianImportCandidate[] = [];
        for (const file of files) {
          if (unimported.length >= MAX_SCAN_CANDIDATES) break;
          let stat: fs.Stats;
          try {
            stat = fs.statSync(file);
          } catch {
            continue;
          }
          if (stat.size > MAX_FILE_BYTES) continue;
          let content: string;
          try {
            content = fs.readFileSync(file, "utf8");
          } catch {
            continue;
          }
          const relPosix = toPosix(path.relative(vaultReal, file));
          const parsed = parseMarkdownTodos(
            content,
            relPosix,
            vaultName,
            tagFilter,
            importedIds,
            vaultKey,
          );
          for (const candidate of parsed) {
            if (candidate.alreadyImported) {
              if (imported.length < MAX_SCAN_CANDIDATES) {
                imported.push(candidate);
              }
            } else if (unimported.length < MAX_SCAN_CANDIDATES) {
              unimported.push(candidate);
            }
          }
        }
        const items = [
          ...unimported,
          ...imported.slice(
            0,
            Math.max(0, MAX_SCAN_CANDIDATES - unimported.length),
          ),
        ];
        return {
          action: "fetchImportItems",
          items,
          vaultName,
          scannedFiles: files.length,
        };
      }

      case "importItems": {
        const res = importTransaction(input.items);
        return {
          action: "importItems",
          ...res,
        };
      }

      case "getDailyExportStatus": {
        if (!req.dayRange) {
          throw DomainError.validation("缺少本地日期范围。");
        }
        const row = readConfigRow(db);
        const config = toConfig(row, readEnabled(db));
        const targetPath = buildDailyRelativePath(
          config.dailyFolder,
          config.dailyFilenameFormat,
          req.dayRange.dayKey,
        );
        return {
          action: "getDailyExportStatus",
          dayKey: req.dayRange.dayKey,
          targetPath,
          record: readDailyExport(db, req.dayRange.dayKey),
          config,
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

        const run = (async (): Promise<ObsidianReply> => {
          const row = readConfigRow(db);
          const vaultReal = assertVaultDir(row.vault_path);
          const relPath = buildDailyRelativePath(
            row.daily_folder,
            row.daily_filename_format,
            dayRange.dayKey,
          );
          const fullPath = resolveInsideVault(vaultReal, relPath);
          const parentDir = path.dirname(fullPath);
          ensureSafeDirInsideVault(vaultReal, parentDir);

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

          const section = renderDailyMarkdownSection({
            dayKey: dayRange.dayKey,
            completedTasks,
            unfinishedCount: firstReview.counts.unfinished,
            currentTaskTitle: firstReview.currentTask?.title ?? null,
            includeBreakpoints: input.includeBreakpoints,
          });

          const existingContent = fs.existsSync(fullPath)
            ? fs.readFileSync(fullPath, "utf8")
            : null;
          const merged = mergeDailyMarkdownContent(
            existingContent,
            dayRange.dayKey,
            section,
          );
          writeFileAtomic(fullPath, merged.content);

          const exportedAt = Date.now();
          const record: ObsidianDailyExportRecord = {
            dayKey: dayRange.dayKey,
            targetPath: relPath,
            exportedAt,
            taskCount: completedTasks.length,
          };
          db.prepare(
            `INSERT INTO integration_daily_exports(
               provider, day_key, target_id, target_path, exported_at, task_count
             ) VALUES ('obsidian', ?, ?, ?, ?, ?)
             ON CONFLICT(provider, day_key) DO UPDATE SET
               target_id = excluded.target_id,
               target_path = excluded.target_path,
               exported_at = excluded.exported_at,
               task_count = excluded.task_count`,
          ).run(
            record.dayKey,
            record.targetPath,
            record.targetPath,
            record.exportedAt,
            record.taskCount,
          );

          return {
            action: "exportDailyReview",
            record,
            updated: merged.updated,
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
            skippedReason: "Obsidian 集成未启用。",
          };
        }
        const config = readConfigRow(db);
        if (config.auto_writeback !== 1) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "未开启 Obsidian 完成后自动回写。",
          };
        }
        if (!config.vault_path.trim()) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "未配置 Obsidian Vault 目录。",
          };
        }
        const link = db
          .prepare(
            `SELECT external_id FROM external_links
             WHERE task_id = ? AND provider = 'obsidian'`,
          )
          .get(input.taskId) as { external_id: string } | undefined;
        if (!link) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "该任务未关联 Obsidian 条目。",
          };
        }
        const parsedId = parseObsidianExternalId(link.external_id);
        if (!parsedId) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "无法解析 Obsidian 外部标识。",
          };
        }
        const vaultReal = assertVaultDir(config.vault_path);
        if (
          parsedId.vaultKey &&
          parsedId.vaultKey !== vaultFingerprint(vaultReal)
        ) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "该任务来自其他 Obsidian Vault，已跳过回写。",
          };
        }
        const fullPath = resolveInsideVault(vaultReal, parsedId.relPosixPath);
        if (!fs.existsSync(fullPath)) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "未找到对应的 Markdown 文件。",
          };
        }
        const raw = fs.readFileSync(fullPath, "utf8");
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const lines = raw.split(/\r?\n/);
        let changed = false;
        let fence: CodeFence | null = null;
        let seen = 0;
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]!;
          const fenceStep = updateFenceState(line, fence);
          fence = fenceStep.active;
          if (fenceStep.isFenceLine || fence !== null) continue;
          const match = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$/);
          if (!match) continue;
          const rawBody = match[4]!.trim();
          const lineHash = hashTodoTitle(rawBody);
          const legacyTitleHash = hashTodoTitle(cleanTodoTitle(rawBody));
          if (
            lineHash === parsedId.expectedHash ||
            legacyTitleHash === parsedId.expectedHash
          ) {
            seen += 1;
            if (seen === parsedId.occurrence) {
              if (match[2] === " ") {
                lines[i] = `${match[1]}x${match[3]}${match[4]}`;
                changed = true;
              }
              break;
            }
          }
        }
        if (!changed) {
          return {
            action: "writeBackTask",
            synced: false,
            skippedReason: "未找到未勾选的对应待办行。",
          };
        }
        writeFileAtomic(fullPath, lines.join(eol));
        db.prepare(
          `UPDATE external_links SET last_synced_at = ? WHERE task_id = ?`,
        ).run(Date.now(), input.taskId);
        return { action: "writeBackTask", synced: true };
      }
    }
  }

  return { handle };
}
