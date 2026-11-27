import type {
  NotionExternalType,
  NotionImportCandidate,
  NotionTargetOption,
} from "../shared/notion-contracts";
import type { TaskSummary } from "../shared/contracts";
import { DomainError } from "./errors";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchLike = typeof fetch;

type RichText = { plain_text?: string };

function plainText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return (items as RichText[])
    .map((item) =>
      typeof item?.plain_text === "string" ? item.plain_text : "",
    )
    .join("")
    .trim();
}

function extractPageTitle(page: Record<string, unknown>): string {
  const props = page.properties as
    Record<string, Record<string, unknown>> | undefined;
  if (props && typeof props === "object") {
    for (const value of Object.values(props)) {
      if (value?.type === "title") {
        const text = plainText(value.title);
        if (text) return text;
      }
    }
  }
  const title = plainText(page.title);
  return title || "未命名页面";
}

function extractDatabaseTitle(db: Record<string, unknown>): string {
  return plainText(db.title) || "未命名数据库";
}

function extractDateProperty(
  props: Record<string, Record<string, unknown>>,
): string | null {
  for (const value of Object.values(props)) {
    if (value?.type === "date") {
      const date = value.date as { start?: unknown } | null | undefined;
      if (date && typeof date.start === "string" && date.start.trim()) {
        return date.start.trim();
      }
    }
  }
  return null;
}

function extractStatusInfo(props: Record<string, Record<string, unknown>>): {
  label: string;
  isDone: boolean;
} {
  for (const value of Object.values(props)) {
    if (value?.type === "checkbox") {
      const checked = Boolean(value.checkbox);
      return { label: checked ? "已完成" : "待办", isDone: checked };
    }
    if (value?.type === "status") {
      const status = value.status as { name?: unknown } | null | undefined;
      const name = typeof status?.name === "string" ? status.name.trim() : "";
      const lower = name.toLowerCase();
      const isDone =
        lower === "done" ||
        lower === "completed" ||
        lower === "complete" ||
        name === "已完成" ||
        name === "完成";
      return { label: name || "未分组", isDone };
    }
    if (value?.type === "select") {
      const select = value.select as { name?: unknown } | null | undefined;
      const name = typeof select?.name === "string" ? select.name.trim() : "";
      if (name) {
        const lower = name.toLowerCase();
        const isDone =
          lower === "done" ||
          lower === "completed" ||
          name === "已完成" ||
          name === "完成";
        return { label: name, isDone };
      }
    }
  }
  return { label: "待办", isDone: false };
}

function textBlock(content: string) {
  return [{ type: "text", text: { content: content.slice(0, 1900) } }];
}

function buildDailyBlocks(params: {
  dayKey: string;
  completedTasks: TaskSummary[];
  unfinishedCount: number;
  currentTaskTitle: string | null;
  includeBreakpoints: boolean;
}) {
  const blocks: Record<string, unknown>[] = [
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: textBlock(
          `今日已完成（${params.completedTasks.length} 项）`,
        ),
      },
    },
  ];

  if (params.completedTasks.length === 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: textBlock("今天暂无标记为已完成的事项。"),
      },
    });
  } else {
    for (const task of params.completedTasks.slice(0, 80)) {
      const parts = [task.title];
      if (params.includeBreakpoints && task.latestBreakpoint) {
        const summary =
          task.latestBreakpoint.progress || task.latestBreakpoint.nextStep;
        if (summary) parts.push(`线索：${summary}`);
      }
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: textBlock(parts.join(" — ")),
          checked: true,
        },
      });
    }
  }

  const footerParts = [`未结束事项：${params.unfinishedCount} 项`];
  if (params.currentTaskTitle) {
    footerParts.push(`当前进行中：${params.currentTaskTitle}`);
  }
  blocks.push({
    object: "block",
    type: "divider",
    divider: {},
  });
  blocks.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: textBlock(
        `由 PickUp 于 ${params.dayKey} 同步 · ${footerParts.join(" · ")}`,
      ),
    },
  });

  return blocks.slice(0, 95);
}

export class NotionApiClient {
  private readonly fetcher: FetchLike;

  constructor(fetcher: FetchLike = globalThis.fetch) {
    this.fetcher = fetcher;
  }

  private async request<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!token.trim()) {
      throw DomainError.validation(
        "请先在设置中配置 Notion Integration Token。",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${NOTION_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Notion-Version": NOTION_VERSION,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      let json: Record<string, unknown> = {};
      if (text) {
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json = {};
        }
      }

      if (!response.ok) {
        const apiMessage = typeof json.message === "string" ? json.message : "";
        if (response.status === 401) {
          throw new DomainError(
            "SYNC_ERROR",
            "Notion Token 无效或已失效，请检查后重新配置。",
            false,
          );
        }
        if (response.status === 403) {
          throw new DomainError(
            "SYNC_ERROR",
            "Notion 集成没有访问该页面/数据库的权限，请在 Notion 页面右上角添加对应连接。",
            false,
          );
        }
        if (response.status === 404) {
          throw new DomainError(
            "NOT_FOUND",
            "找不到目标 Notion 页面或数据库，请确认已分享给当前集成。",
            false,
          );
        }
        if (response.status === 429) {
          throw new DomainError(
            "SYNC_ERROR",
            "Notion API 请求过于频繁，请稍后重试。",
            true,
          );
        }
        throw new DomainError(
          "SYNC_ERROR",
          apiMessage
            ? `Notion 请求失败（${response.status}）：${apiMessage}`
            : `Notion 请求失败（HTTP ${response.status}）。`,
          response.status >= 500,
        );
      }

      return json as T;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DomainError(
          "SYNC_ERROR",
          "连接 Notion 超时，请检查网络后重试。",
          true,
        );
      }
      throw new DomainError(
        "SYNC_ERROR",
        "无法连接 Notion 服务，请检查网络设置。",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async getBotUser(
    token: string,
  ): Promise<{ workspaceName: string; botName: string }> {
    const data = await this.request<{
      name?: string;
      bot?: { workspace_name?: string };
    }>(token, "GET", "/users/me");
    return {
      workspaceName: data.bot?.workspace_name?.trim() || "Notion 工作区",
      botName: data.name?.trim() || "PickUp Integration",
    };
  }

  async searchTargets(token: string): Promise<NotionTargetOption[]> {
    const data = await this.request<{ results?: Record<string, unknown>[] }>(
      token,
      "POST",
      "/search",
      {
        page_size: 50,
        sort: { direction: "descending", timestamp: "last_edited_time" },
      },
    );
    const results = Array.isArray(data.results) ? data.results : [];
    const options: NotionTargetOption[] = [];
    for (const item of results) {
      const id = typeof item.id === "string" ? item.id : "";
      if (!id || item.archived === true || item.in_trash === true) continue;
      const url = typeof item.url === "string" ? item.url : "";
      if (item.object === "database") {
        options.push({
          id,
          title: extractDatabaseTitle(item),
          type: "database",
          url,
        });
      } else if (item.object === "page") {
        options.push({
          id,
          title: extractPageTitle(item),
          type: "page",
          url,
        });
      }
    }
    return options;
  }

  async queryDatabaseItems(
    token: string,
    databaseId: string,
    sourceTitle: string,
    importedIds: Set<string>,
  ): Promise<NotionImportCandidate[]> {
    const data = await this.request<{ results?: Record<string, unknown>[] }>(
      token,
      "POST",
      `/databases/${encodeURIComponent(databaseId)}/query`,
      { page_size: 50 },
    );
    const results = Array.isArray(data.results) ? data.results : [];
    const items: NotionImportCandidate[] = [];
    for (const page of results) {
      const id = typeof page.id === "string" ? page.id : "";
      if (!id || page.archived === true || page.in_trash === true) continue;
      const props = (page.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const status = extractStatusInfo(props);
      if (status.isDone) continue;
      const title = extractPageTitle(page);
      if (!title) continue;
      items.push({
        externalId: id,
        externalType: "database_item",
        title: title.slice(0, 300),
        sourceTitle,
        externalUrl: typeof page.url === "string" ? page.url : "",
        dueDate: extractDateProperty(props),
        statusLabel: status.label,
        alreadyImported: importedIds.has(id),
      });
    }
    return items;
  }

  async fetchPageTodoBlocks(
    token: string,
    pageId: string,
    sourceTitle: string,
    importedIds: Set<string>,
  ): Promise<NotionImportCandidate[]> {
    const pageMeta = await this.request<{ url?: string }>(
      token,
      "GET",
      `/pages/${encodeURIComponent(pageId)}`,
    );
    const pageUrl = typeof pageMeta.url === "string" ? pageMeta.url : "";
    const data = await this.request<{ results?: Record<string, unknown>[] }>(
      token,
      "GET",
      `/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
    );
    const results = Array.isArray(data.results) ? data.results : [];
    const items: NotionImportCandidate[] = [];
    for (const block of results) {
      if (block.type !== "to_do" || block.archived === true) continue;
      const id = typeof block.id === "string" ? block.id : "";
      const todo = block.to_do as
        { checked?: boolean; rich_text?: unknown } | undefined;
      if (!id || !todo || todo.checked) continue;
      const text = plainText(todo.rich_text);
      if (!text) continue;
      items.push({
        externalId: id,
        externalType: "todo_block",
        title: text.slice(0, 300),
        sourceTitle,
        externalUrl: pageUrl,
        dueDate: null,
        statusLabel: "未勾选",
        alreadyImported: importedIds.has(id),
      });
    }
    return items;
  }

  async upsertDailyPage(
    token: string,
    params: {
      parentPageId: string;
      existingPageId: string | null;
      dayKey: string;
      completedTasks: TaskSummary[];
      unfinishedCount: number;
      currentTaskTitle: string | null;
      includeBreakpoints: boolean;
    },
  ): Promise<{ pageId: string; pageUrl: string; updated: boolean }> {
    const blocks = buildDailyBlocks(params);

    if (params.existingPageId) {
      try {
        const existing = await this.request<{
          id?: string;
          url?: string;
          archived?: boolean;
          in_trash?: boolean;
        }>(token, "GET", `/pages/${encodeURIComponent(params.existingPageId)}`);
        if (existing.id && !existing.archived && !existing.in_trash) {
          const children = await this.request<{
            results?: { id?: string }[];
          }>(
            token,
            "GET",
            `/blocks/${encodeURIComponent(existing.id)}/children?page_size=100`,
          );
          for (const child of children.results ?? []) {
            if (child.id) {
              await this.request(
                token,
                "DELETE",
                `/blocks/${encodeURIComponent(child.id)}`,
              );
            }
          }
          await this.request(
            token,
            "PATCH",
            `/blocks/${encodeURIComponent(existing.id)}/children`,
            { children: blocks },
          );
          return {
            pageId: existing.id,
            pageUrl: typeof existing.url === "string" ? existing.url : "",
            updated: true,
          };
        }
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "NOT_FOUND")) {
          throw error;
        }
      }
    }

    const created = await this.request<{ id?: string; url?: string }>(
      token,
      "POST",
      "/pages",
      {
        parent: { page_id: params.parentPageId },
        properties: {
          title: {
            title: textBlock(`${params.dayKey} 每日总结`),
          },
        },
        children: blocks,
      },
    );
    if (!created.id) {
      throw new DomainError(
        "SYNC_ERROR",
        "Notion 未返回新建页面的 ID，请稍后重试。",
        true,
      );
    }
    return {
      pageId: created.id,
      pageUrl: typeof created.url === "string" ? created.url : "",
      updated: false,
    };
  }

  async markExternalDone(
    token: string,
    externalId: string,
    externalType: NotionExternalType,
  ): Promise<boolean> {
    if (externalType === "todo_block") {
      await this.request(
        token,
        "PATCH",
        `/blocks/${encodeURIComponent(externalId)}`,
        { to_do: { checked: true } },
      );
      return true;
    }

    const page = await this.request<{
      properties?: Record<string, Record<string, unknown>>;
    }>(token, "GET", `/pages/${encodeURIComponent(externalId)}`);
    const props = page.properties ?? {};
    for (const [key, value] of Object.entries(props)) {
      if (value?.type === "checkbox") {
        await this.request(
          token,
          "PATCH",
          `/pages/${encodeURIComponent(externalId)}`,
          { properties: { [key]: { checkbox: true } } },
        );
        return true;
      }
      if (value?.type === "status") {
        await this.request(
          token,
          "PATCH",
          `/pages/${encodeURIComponent(externalId)}`,
          { properties: { [key]: { status: { name: "Done" } } } },
        );
        return true;
      }
    }
    return false;
  }
}
