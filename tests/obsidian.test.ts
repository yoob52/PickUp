import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createCommands } from "../src/worker/commands";
import { migrateSchema } from "../src/worker/migrate";
import {
  buildDailyRelativePath,
  createObsidianService,
  mergeDailyMarkdownContent,
  parseMarkdownTodos,
  renderDailyMarkdownSection,
  resolveInsideVault,
} from "../src/worker/obsidian";
import { createQueries } from "../src/worker/queries";
import type { SqliteDatabase } from "../src/worker/sqlite";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openTestDb(): {
  db: SqliteDatabase;
  close: () => void;
} {
  const dir = makeTempDir("pickup-obsidian-db-");
  const raw = new Database(path.join(dir, "test.sqlite"));
  raw.pragma("foreign_keys = ON");
  const db = raw as unknown as SqliteDatabase;
  migrateSchema(db);
  return { db, close: () => raw.close() };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Obsidian vault path safety & helpers", () => {
  it("keeps relative paths inside the Vault and rejects traversal or external symlinks", () => {
    const vault = makeTempDir("pickup-vault-");
    const outside = makeTempDir("pickup-outside-");
    const vaultReal = fs.realpathSync(vault);
    const outsideFile = path.join(outside, "secret.md");
    fs.writeFileSync(outsideFile, "- [ ] secret\n", "utf8");
    const escapedLink = path.join(vaultReal, "escape.md");
    fs.symlinkSync(outsideFile, escapedLink);

    expect(resolveInsideVault(vaultReal, "Daily/2026-11-28.md")).toBe(
      path.join(vaultReal, "Daily", "2026-11-28.md"),
    );
    expect(() => resolveInsideVault(vaultReal, "../outside.md")).toThrow(
      /超出 Obsidian Vault/,
    );
    expect(() => resolveInsideVault(vaultReal, "/etc/passwd")).toThrow(
      /相对路径/,
    );
    expect(() => resolveInsideVault(vaultReal, "escape.md")).toThrow(
      /符号链接超出 Vault/,
    );
  });

  it("builds safe daily note paths and rejects traversal formats", () => {
    expect(buildDailyRelativePath("Daily", "YYYY-MM-DD", "2026-11-28")).toBe(
      "Daily/2026-11-28.md",
    );
    expect(
      buildDailyRelativePath("Notes/Journal", "YYYY-MM-DD 日记", "2026-11-28"),
    ).toBe("Notes/Journal/2026-11-28 日记.md");
    expect(() =>
      buildDailyRelativePath("Daily", "../YYYY-MM-DD", "2026-11-28"),
    ).toThrow();
  });

  it("parses unchecked Markdown todos, skips fenced code blocks, parses due dates and filters by tag", () => {
    const md = [
      "# Inbox",
      "- [x] 已经完成的任务",
      "- [ ] 写完 Obsidian 集成设计 #work 📅 2026-11-29",
      "* [ ] 整理同步日志 due:: 2026-11-30",
      "```markdown",
      "- [ ] 代码块里的示例待办 #work",
      "```",
      "+ [ ] 准备下周演示 @due(2026-12-01) #work",
    ].join("\n");

    const all = parseMarkdownTodos(md, "Inbox.md", "MyVault", "", new Set());
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({
      title: "写完 Obsidian 集成设计 #work",
      dueDate: "2026-11-29",
      filePath: "Inbox.md",
      alreadyImported: false,
    });
    expect(all[1]).toMatchObject({
      title: "整理同步日志",
      dueDate: "2026-11-30",
    });
    expect(all[2]).toMatchObject({
      title: "准备下周演示 #work",
      dueDate: "2026-12-01",
    });

    const filtered = parseMarkdownTodos(
      md,
      "Inbox.md",
      "MyVault",
      "work",
      new Set([all[0].externalId]),
    );
    expect(filtered).toHaveLength(2);
    expect(filtered[0].alreadyImported).toBe(true);
    expect(filtered[1].alreadyImported).toBe(false);
  });

  it("preserves manual notes around PickUp daily markers on repeat export", () => {
    const section1 = renderDailyMarkdownSection({
      dayKey: "2026-11-28",
      completedTasks: [],
      unfinishedCount: 2,
      currentTaskTitle: "排查同步问题",
      includeBreakpoints: true,
    });
    const manual = "# 2026-11-28\n\n## 我的随手记\n今天喝了拿铁。\n";
    const first = mergeDailyMarkdownContent(manual, "2026-11-28", section1);
    expect(first.updated).toBe(true);
    expect(first.content).toContain("今天喝了拿铁。");
    expect(first.content).toContain("<!-- pickup:daily:start:2026-11-28 -->");

    const withFooter = `${first.content}\n## 晚间复盘\n继续保持。\n`;
    const section2 = renderDailyMarkdownSection({
      dayKey: "2026-11-28",
      completedTasks: [],
      unfinishedCount: 0,
      currentTaskTitle: null,
      includeBreakpoints: false,
    });
    const second = mergeDailyMarkdownContent(
      withFooter,
      "2026-11-28",
      section2,
    );
    expect(second.content).toContain("今天喝了拿铁。");
    expect(second.content).toContain("继续保持。");
    expect(second.content).toContain("今天还没有已完成的事项。");
    expect(second.content).toContain("未结束 0 项");
    expect(
      second.content.match(/<!-- pickup:daily:start:2026-11-28 -->/g),
    ).toHaveLength(1);
  });
});

describe("createObsidianService (SQLite + Vault filesystem)", () => {
  it("scans Vault, deduplicates imports, exports daily notes preserving manual content, and writes back", async () => {
    const { db, close } = openTestDb();
    try {
      const vault = makeTempDir("pickup-obsidian-vault-");
      fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
      fs.mkdirSync(path.join(vault, "Projects"), { recursive: true });
      fs.writeFileSync(
        path.join(vault, ".obsidian", "ignored.md"),
        "- [ ] 内部配置不应被扫描\n",
        "utf8",
      );
      const todoFile = path.join(vault, "Projects", "pickup.md");
      fs.writeFileSync(
        todoFile,
        "# PickUp\r\n- [ ] 完成 Obsidian 集成 #pickup 📅 2026-11-29\r\n- [ ] 另一件待办\r\n",
        "utf8",
      );

      const commands = createCommands(db);
      const queries = createQueries(db);
      const service = createObsidianService(db, {
        createTask: (input) => commands.createTask(input).value,
        dailyReview: queries.dailyReview,
      });

      const initial = await service.handle({ input: { action: "getConfig" } });
      expect(initial.action).toBe("getConfig");
      if (initial.action === "getConfig") {
        expect(initial.config.enabled).toBe(false);
        expect(initial.config.configured).toBe(false);
      }

      const tested = await service.handle({
        input: { action: "testVault", vaultPath: vault },
      });
      expect(tested).toMatchObject({
        action: "testVault",
        vaultName: path.basename(fs.realpathSync(vault)),
        markdownCount: 1,
      });

      const saved = await service.handle({
        input: {
          action: "saveConfig",
          enabled: true,
          vaultPath: vault,
          dailyFolder: "Daily",
          dailyFilenameFormat: "YYYY-MM-DD",
          todoSourcePath: "Projects",
          todoTag: "#pickup",
          autoWriteback: false,
        },
      });
      expect(saved.action).toBe("saveConfig");
      if (saved.action === "saveConfig") {
        expect(saved.config.enabled).toBe(true);
        expect(saved.config.configured).toBe(true);
      }

      const outboxAfterConfig = db
        .prepare("SELECT COUNT(*) AS count FROM sync_outbox")
        .get() as { count: number };
      expect(outboxAfterConfig.count).toBe(0);

      const fetched = await service.handle({
        input: { action: "fetchImportItems" },
      });
      expect(fetched.action).toBe("fetchImportItems");
      if (fetched.action !== "fetchImportItems") return;
      expect(fetched.items).toHaveLength(1);
      expect(fetched.items[0].title).toBe("完成 Obsidian 集成 #pickup");

      const firstImport = await service.handle({
        input: {
          action: "importItems",
          items: [
            {
              externalId: fetched.items[0].externalId,
              title: fetched.items[0].title,
              filePath: fetched.items[0].filePath,
              sourceTitle: fetched.items[0].sourceTitle,
              externalUrl: fetched.items[0].externalUrl,
              dueDate: fetched.items[0].dueDate,
            },
          ],
        },
      });
      expect(firstImport).toMatchObject({
        action: "importItems",
        importedCount: 1,
        skippedCount: 0,
      });

      const duplicateImport = await service.handle({
        input: {
          action: "importItems",
          items: [
            {
              externalId: fetched.items[0].externalId,
              title: fetched.items[0].title,
              filePath: fetched.items[0].filePath,
              sourceTitle: fetched.items[0].sourceTitle,
              externalUrl: fetched.items[0].externalUrl,
              dueDate: fetched.items[0].dueDate,
            },
          ],
        },
      });
      expect(duplicateImport).toMatchObject({
        action: "importItems",
        importedCount: 0,
        skippedCount: 1,
      });

      const snapshot = queries.workspaceSnapshot();
      expect(snapshot.unfinished).toHaveLength(1);
      expect(snapshot.unfinished[0].externalLink).toMatchObject({
        provider: "obsidian",
        externalType: "markdown_todo",
        dueDate: "2026-11-29",
      });

      const taskId = snapshot.unfinished[0].id;
      const wbOff = await service.handle({
        input: { action: "writeBackTask", taskId },
      });
      expect(wbOff).toMatchObject({
        action: "writeBackTask",
        synced: false,
      });

      await service.handle({
        input: { action: "saveConfig", autoWriteback: true },
      });
      const wbOn = await service.handle({
        input: { action: "writeBackTask", taskId },
      });
      expect(wbOn).toEqual({ action: "writeBackTask", synced: true });
      const updatedTodoFile = fs.readFileSync(todoFile, "utf8");
      expect(updatedTodoFile).toContain(
        "- [x] 完成 Obsidian 集成 #pickup 📅 2026-11-29\r\n",
      );
      expect(updatedTodoFile).toContain("- [ ] 另一件待办\r\n");

      // Pre-populate a manual daily note and export PickUp summary into it
      const dailyPath = path.join(vault, "Daily", "2026-11-28.md");
      fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
      fs.writeFileSync(
        dailyPath,
        "# 2026-11-28\n\n手写内容必须保留。\n",
        "utf8",
      );

      const dayRange = {
        dayKey: "2026-11-28",
        startUtc: 0,
        endUtc: Date.now() + 60_000,
      };
      const [exp1, exp2] = await Promise.all([
        service.handle({
          input: { action: "exportDailyReview", includeBreakpoints: true },
          dayRange,
        }),
        service.handle({
          input: { action: "exportDailyReview", includeBreakpoints: true },
          dayRange,
        }),
      ]);
      expect(exp1.action).toBe("exportDailyReview");
      expect(exp2.action).toBe("exportDailyReview");

      const dailyContent = fs.readFileSync(dailyPath, "utf8");
      expect(dailyContent).toContain("手写内容必须保留。");
      expect(dailyContent).toContain("<!-- pickup:daily:start:2026-11-28 -->");
      expect(
        dailyContent.match(/<!-- pickup:daily:start:2026-11-28 -->/g),
      ).toHaveLength(1);
    } finally {
      close();
    }
  });
});
