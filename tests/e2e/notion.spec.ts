import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PickupAPI } from "../../src/shared/contracts";
import { launch, launchEnvironment, windowByKind } from "./helpers";

declare global {
  interface Window {
    pickup: PickupAPI;
  }
}

test("desktop Notion entry points, import dedup, and daily review card work end-to-end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pickup-e2e-notion-"));
  const env = launchEnvironment(directory);
  const app = await launch(env);
  try {
    const page = await windowByKind(app, "main");
    await expect(
      page.getByRole("button", { name: "Notion 导入" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Notion 导入" }).click();
    await expect(
      page.getByRole("heading", { name: "把待办或日程拉进工作台。" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "前往设置" }).click();
    await expect(
      page.getByRole("heading", { name: /Notion 集成（本机直连）/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "完成" }).click();

    const imported = await page.evaluate(async () => {
      const first = await window.pickup.notion({
        action: "importItems",
        items: [
          {
            externalId: "notion-e2e-1",
            externalType: "database_item",
            title: "来自 Notion 的端到端验证任务",
            sourceTitle: "个人待办",
            externalUrl: "https://notion.so/notion-e2e-1",
            dueDate: "2026-11-27",
          },
        ],
      });
      const dup = await window.pickup.notion({
        action: "importItems",
        items: [
          {
            externalId: "notion-e2e-1",
            externalType: "database_item",
            title: "来自 Notion 的端到端验证任务",
            sourceTitle: "个人待办",
            externalUrl: "https://notion.so/notion-e2e-1",
            dueDate: "2026-11-27",
          },
        ],
      });
      return { first, dup };
    });

    expect(imported.first).toMatchObject({
      ok: true,
      value: { action: "importItems", importedCount: 1, skippedCount: 0 },
    });
    expect(imported.dup).toMatchObject({
      ok: true,
      value: { action: "importItems", importedCount: 0, skippedCount: 1 },
    });

    await expect(
      page.getByText("来自 Notion 的端到端验证任务").first(),
    ).toBeVisible();
    await expect(
      page.getByText("Notion", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("2026-11-27", { exact: true }).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "今日收尾" }).click();
    await expect(page.getByText("写入 Notion 每日一页")).toBeVisible();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
