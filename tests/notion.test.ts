import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { NotionApiClient } from "../src/worker/notion-client";
import { createNotionService } from "../src/worker/notion";
import { migrateSchema } from "../src/worker/migrate";
import { createCommands } from "../src/worker/commands";
import { createQueries } from "../src/worker/queries";
import { notionInputSchema } from "../src/shared/notion-contracts";
import type { TaskSummary } from "../src/shared/contracts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sampleTask(id: string, title: string, progress?: string): TaskSummary {
  return {
    id,
    title,
    note: "",
    status: "done",
    waitReason: "",
    checkBackAt: null,
    version: 1,
    statusRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    statusChangedAt: 1,
    endedAt: 1,
    breakpointCount: progress ? 1 : 0,
    latestBreakpoint: progress
      ? {
          seq: 1,
          progress,
          nextStep: "",
          savedAt: 1,
        }
      : null,
  };
}

describe("NotionApiClient", () => {
  it("parses workspace identity and searchable pages/databases", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/users/me")) {
        return jsonResponse({
          name: "PickUp Bot",
          bot: { workspace_name: "Liu Workspace" },
        });
      }
      if (target.endsWith("/search")) {
        return jsonResponse({
          results: [
            {
              object: "database",
              id: "db-1",
              url: "https://notion.so/db-1",
              title: [{ plain_text: "个人待办与日程" }],
            },
            {
              object: "page",
              id: "page-1",
              url: "https://notion.so/page-1",
              properties: {
                title: {
                  type: "title",
                  title: [{ plain_text: "PickUp 每日归档" }],
                },
              },
            },
            {
              object: "page",
              id: "archived-page",
              archived: true,
              properties: {},
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const client = new NotionApiClient(fetcher);
    const bot = await client.getBotUser("ntn_test_token");
    expect(bot).toEqual({
      workspaceName: "Liu Workspace",
      botName: "PickUp Bot",
    });

    const targets = await client.searchTargets("ntn_test_token");
    expect(targets).toEqual([
      {
        id: "db-1",
        title: "个人待办与日程",
        type: "database",
        url: "https://notion.so/db-1",
      },
      {
        id: "page-1",
        title: "PickUp 每日归档",
        type: "page",
        url: "https://notion.so/page-1",
      },
    ]);
  });

  it("queries database items, skips done items, and flags already-imported IDs", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            id: "item-1",
            url: "https://notion.so/item-1",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "评审 Q2 同步方案" }],
              },
              Date: { type: "date", date: { start: "2026-11-27" } },
              Status: { type: "status", status: { name: "In progress" } },
            },
          },
          {
            id: "item-done",
            url: "https://notion.so/item-done",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "已完成事项" }],
              },
              Status: { type: "status", status: { name: "Done" } },
            },
          },
          {
            id: "item-2",
            url: "https://notion.so/item-2",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "已经导入过的任务" }],
              },
              Done: { type: "checkbox", checkbox: false },
            },
          },
        ],
      }),
    );

    const client = new NotionApiClient(fetcher);
    const items = await client.queryDatabaseItems(
      "ntn_test_token",
      "db-1",
      "个人待办与日程",
      new Set(["item-2"]),
    );

    expect(items).toEqual([
      {
        externalId: "item-1",
        externalType: "database_item",
        title: "评审 Q2 同步方案",
        sourceTitle: "个人待办与日程",
        externalUrl: "https://notion.so/item-1",
        dueDate: "2026-11-27",
        statusLabel: "In progress",
        alreadyImported: false,
      },
      {
        externalId: "item-2",
        externalType: "database_item",
        title: "已经导入过的任务",
        sourceTitle: "个人待办与日程",
        externalUrl: "https://notion.so/item-2",
        dueDate: null,
        statusLabel: "待办",
        alreadyImported: true,
      },
    ]);
  });

  it("reads unchecked to_do blocks from a Notion page", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/pages/page-1")) {
        return jsonResponse({ url: "https://notion.so/page-1" });
      }
      return jsonResponse({
        results: [
          {
            id: "blk-1",
            type: "to_do",
            to_do: {
              checked: false,
              rich_text: [{ plain_text: "补全 Notion 单测" }],
            },
          },
          {
            id: "blk-2",
            type: "to_do",
            to_do: {
              checked: true,
              rich_text: [{ plain_text: "已经勾选的事项" }],
            },
          },
          {
            id: "blk-3",
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "普通段落" }] },
          },
        ],
      });
    });

    const client = new NotionApiClient(fetcher);
    const items = await client.fetchPageTodoBlocks(
      "ntn_test_token",
      "page-1",
      "周会纪要",
      new Set(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: "blk-1",
      externalType: "todo_block",
      title: "补全 Notion 单测",
      externalUrl: "https://notion.so/page-1",
      alreadyImported: false,
    });
  });

  it("creates a daily page on first export and updates in place on same-day re-export", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const path = String(url).replace("https://api.notion.com/v1", "");
        calls.push(`${method} ${path}`);

        if (method === "POST" && path === "/pages") {
          return jsonResponse({
            id: "daily-page-1",
            url: "https://notion.so/daily-page-1",
          });
        }
        if (method === "GET" && path === "/pages/daily-page-1") {
          return jsonResponse({
            id: "daily-page-1",
            url: "https://notion.so/daily-page-1",
            archived: false,
          });
        }
        if (
          method === "GET" &&
          path === "/blocks/daily-page-1/children?page_size=100"
        ) {
          return jsonResponse({
            results: [
              {
                id: "manual-note-1",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "手动补充的复盘" }] },
              },
              {
                id: "old-h2",
                type: "heading_2",
                heading_2: { rich_text: [{ plain_text: "今日已完成（1 项）" }] },
              },
              {
                id: "old-blk-1",
                type: "to_do",
                to_do: { rich_text: [{ plain_text: "实现 Notion 集成" }] },
              },
              {
                id: "old-footer",
                type: "paragraph",
                paragraph: {
                  rich_text: [
                    { plain_text: "由 PickUp 于 2026-11-27 同步 · 未结束事项：2 项" },
                  ],
                },
              },
            ],
          });
        }
        if (method === "DELETE" && path.startsWith("/blocks/old-")) {
          return jsonResponse({ archived: true });
        }
        if (method === "PATCH" && path === "/blocks/daily-page-1/children") {
          return jsonResponse({ results: [] });
        }
        return jsonResponse({}, 404);
      },
    );

    const client = new NotionApiClient(fetcher);
    const created = await client.upsertDailyPage("ntn_test_token", {
      parentPageId: "parent-1",
      existingPageId: null,
      dayKey: "2026-11-27",
      completedTasks: [sampleTask("t1", "实现 Notion 集成", "已完成导入")],
      unfinishedCount: 2,
      currentTaskTitle: null,
      includeBreakpoints: true,
    });
    expect(created).toEqual({
      pageId: "daily-page-1",
      pageUrl: "https://notion.so/daily-page-1",
      updated: false,
    });

    const updated = await client.upsertDailyPage("ntn_test_token", {
      parentPageId: "parent-1",
      existingPageId: "daily-page-1",
      dayKey: "2026-11-27",
      completedTasks: [sampleTask("t1", "实现 Notion 集成")],
      unfinishedCount: 1,
      currentTaskTitle: null,
      includeBreakpoints: false,
    });
    expect(updated).toEqual({
      pageId: "daily-page-1",
      pageUrl: "https://notion.so/daily-page-1",
      updated: true,
    });
    expect(calls).toEqual([
      "POST /pages",
      "GET /pages/daily-page-1",
      "GET /blocks/daily-page-1/children?page_size=100",
      "PATCH /blocks/daily-page-1/children",
      "DELETE /blocks/old-h2",
      "DELETE /blocks/old-blk-1",
      "DELETE /blocks/old-footer",
    ]);
  });

  it("chunks daily exports with more than 80 completed tasks across multiple block appends", async () => {
    const patchBatches: number[] = [];
    let postBlocks = 0;
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const path = String(url).replace("https://api.notion.com/v1", "");
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        if (method === "POST" && path === "/pages") {
          postBlocks = Array.isArray(parsed.children)
            ? parsed.children.length
            : 0;
          return jsonResponse({ id: "daily-big", url: "https://notion.so/big" });
        }
        if (method === "PATCH" && path === "/blocks/daily-big/children") {
          patchBatches.push(
            Array.isArray(parsed.children) ? parsed.children.length : 0,
          );
          return jsonResponse({ results: [] });
        }
        return jsonResponse({}, 404);
      },
    );
    const client = new NotionApiClient(fetcher);
    const tasks = Array.from({ length: 110 }, (_, idx) =>
      sampleTask(`t-${idx}`, `已完成任务 ${idx + 1}`),
    );
    await client.upsertDailyPage("ntn_test_token", {
      parentPageId: "parent-1",
      existingPageId: null,
      dayKey: "2026-11-27",
      completedTasks: tasks,
      unfinishedCount: 0,
      currentTaskTitle: null,
      includeBreakpoints: false,
    });
    expect(postBlocks).toBe(95);
    expect(patchBatches).toEqual([18]);
  });

  it("ignores unrelated checkboxes and resolves database completion option names on write-back", async () => {
    const patches: unknown[] = [];
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const path = String(url).replace("https://api.notion.com/v1", "");
        if (method === "POST" && path === "/databases/db-1/query") {
          return jsonResponse({
            results: [
              {
                id: "item-urgent",
                url: "https://notion.so/item-urgent",
                properties: {
                  Urgent: { type: "checkbox", checkbox: true },
                  Status: { type: "status", status: { name: "In progress" } },
                  Name: {
                    type: "title",
                    title: [{ plain_text: "紧急但未完成的任务" }],
                  },
                },
              },
            ],
          });
        }
        if (method === "GET" && path === "/pages/item-urgent") {
          return jsonResponse({
            parent: { type: "database_id", database_id: "db-1" },
            properties: {
              Urgent: { type: "checkbox", checkbox: true },
              Status: { type: "status", status: { name: "In progress" } },
            },
          });
        }
        if (method === "GET" && path === "/databases/db-1") {
          return jsonResponse({
            properties: {
              Status: {
                type: "status",
                status: {
                  options: [
                    { id: "o1", name: "In progress" },
                    { id: "o2", name: "Completed" },
                  ],
                  groups: [{ name: "Complete", option_ids: ["o2"] }],
                },
              },
            },
          });
        }
        if (method === "PATCH" && path === "/pages/item-urgent") {
          patches.push(JSON.parse(String(init?.body ?? "{}")));
          return jsonResponse({ id: "item-urgent" });
        }
        return jsonResponse({}, 404);
      },
    );

    const client = new NotionApiClient(fetcher);
    const items = await client.queryDatabaseItems(
      "ntn_test_token",
      "db-1",
      "任务库",
      new Set(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("紧急但未完成的任务");

    const synced = await client.markExternalDone(
      "ntn_test_token",
      "item-urgent",
      "database_item",
    );
    expect(synced).toBe(true);
    expect(patches).toEqual([
      { properties: { Status: { status: { name: "Completed" } } } },
    ]);
  });

  it("maps 401 unauthorized responses to a clear non-retryable error", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ message: "API token is invalid." }, 401),
    );
    const client = new NotionApiClient(fetcher);
    await expect(client.getBotUser("bad_token")).rejects.toMatchObject({
      code: "SYNC_ERROR",
      retryable: false,
    });
  });

  it("validates notionInputSchema bounds", () => {
    expect(notionInputSchema.safeParse({ action: "getConfig" }).success).toBe(
      true,
    );
    expect(
      notionInputSchema.safeParse({ action: "importItems", items: [] }).success,
    ).toBe(false);
    expect(
      notionInputSchema.safeParse({
        action: "exportDailyReview",
        includeBreakpoints: true,
      }).success,
    ).toBe(true);
  });
});

describe("createNotionService (SQLite persistence & deduplication)", () => {
  it("persists local config outside sync_outbox, deduplicates imports, exports idempotently, and writes back when enabled", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateSchema(db);
    const queries = createQueries(db);
    const commands = createCommands(db);

    const mockApi = {
      getBotUser: vi.fn(),
      searchTargets: vi.fn(),
      queryDatabaseItems: vi.fn(),
      fetchPageTodoBlocks: vi.fn(),
      upsertDailyPage: vi
        .fn()
        .mockResolvedValueOnce({
          pageId: "daily-1",
          pageUrl: "https://notion.so/daily-1",
          updated: false,
        })
        .mockResolvedValueOnce({
          pageId: "daily-1",
          pageUrl: "https://notion.so/daily-1",
          updated: true,
        }),
      markExternalDone: vi.fn().mockResolvedValue(true),
    } as unknown as NotionApiClient;

    const service = createNotionService(db, {
      createTask: (input) => commands.createTask(input).value,
      dailyReview: queries.dailyReview,
      api: mockApi,
    });

    const saved = await service.handle({
      input: {
        action: "saveConfig",
        workspaceName: "Liu Workspace",
        dailyParentId: "parent-1",
        dailyParentTitle: "PickUp 每日归档",
        importSourceId: "db-1",
        importSourceTitle: "个人待办",
        importSourceType: "database",
        autoWriteback: false,
      },
      encryptedToken: "local:v1:c2VjcmV0",
      tokenHint: "ntn_••••1234",
    });
    expect(saved.action).toBe("saveConfig");
    if (saved.action === "saveConfig") {
      expect(saved.config.connected).toBe(true);
      expect(saved.config.tokenHint).toBe("ntn_••••1234");
    }

    const outboxAfterConfig = db
      .prepare("SELECT COUNT(*) AS count FROM sync_outbox")
      .get() as { count: number };
    expect(outboxAfterConfig.count).toBe(0);

    const firstImport = await service.handle({
      input: {
        action: "importItems",
        items: [
          {
            externalId: "ext-1",
            externalType: "database_item",
            title: "整理周报",
            sourceTitle: "个人待办",
            externalUrl: "https://notion.so/ext-1",
            dueDate: "2026-11-27",
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
            externalId: "ext-1",
            externalType: "database_item",
            title: "整理周报",
            sourceTitle: "个人待办",
            externalUrl: "https://notion.so/ext-1",
            dueDate: "2026-11-27",
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
      provider: "notion",
      externalId: "ext-1",
      dueDate: "2026-11-27",
    });

    const taskId = snapshot.unfinished[0].id;
    const wbDisabled = await service.handle({
      input: { action: "writeBackTask", taskId },
      plainToken: "ntn_secret",
    });
    expect(wbDisabled).toEqual({
      action: "writeBackTask",
      synced: false,
      skippedReason: "disabled",
    });

    await service.handle({
      input: { action: "saveConfig", autoWriteback: true },
    });
    const wbEnabled = await service.handle({
      input: { action: "writeBackTask", taskId },
      plainToken: "ntn_secret",
    });
    expect(wbEnabled).toEqual({ action: "writeBackTask", synced: true });
    expect(mockApi.markExternalDone).toHaveBeenCalledWith(
      "ntn_secret",
      "ext-1",
      "database_item",
    );

    const dayRange = {
      dayKey: "2026-11-27",
      startUtc: 0,
      endUtc: Date.now() + 60_000,
    };
    const firstExport = await service.handle({
      input: { action: "exportDailyReview", includeBreakpoints: true },
      plainToken: "ntn_secret",
      dayRange,
    });
    expect(firstExport).toMatchObject({
      action: "exportDailyReview",
      updated: false,
      record: { dayKey: "2026-11-27", pageId: "daily-1" },
    });

    const secondExport = await service.handle({
      input: { action: "exportDailyReview", includeBreakpoints: true },
      plainToken: "ntn_secret",
      dayRange,
    });
    expect(secondExport).toMatchObject({
      action: "exportDailyReview",
      updated: true,
      record: { dayKey: "2026-11-27", pageId: "daily-1" },
    });

    db.close();
  });
});
