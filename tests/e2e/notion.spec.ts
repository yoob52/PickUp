import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PickupAPI } from "../../src/shared/contracts";
import { launch, launchEnvironment, windowByKind } from "./helpers";

declare global {
  interface Window {
    pickup: PickupAPI;
  }
}

test("opt-in integrations stay hidden by default and enable generic Notion + Obsidian flows", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "pickup-e2e-integrations-"));
  const vaultDir = join(directory, "vault");
  await mkdir(join(vaultDir, "Projects"), { recursive: true });
  await writeFile(
    join(vaultDir, "Projects", "tasks.md"),
    "# Tasks\n- [ ] 来自 Obsidian 的端到端任务 📅 2026-11-30\n",
    "utf8",
  );

  const env = launchEnvironment(directory);
  const app = await launch(env);
  try {
    const page = await windowByKind(app, "main");

    // 1. Default state: all integrations off -> main UI & Daily Review stay completely clean
    await expect(page.getByRole("button", { name: "导入" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Notion 导入" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "今日收尾" }).click();
    await expect(page.getByText("写入笔记")).toHaveCount(0);
    await page.getByRole("button", { name: "稍后收尾" }).click();

    // 2. Open Settings -> Integrations, enable Obsidian & Notion
    await page.getByRole("button", { name: "打开设置" }).click();
    await expect(page.getByRole("heading", { name: "集成" })).toBeVisible();
    await page.getByRole("button", { name: "启用 Obsidian 集成" }).click();
    await page.getByRole("button", { name: "启用 Notion 集成" }).click();

    await page.evaluate(async (vaultPath) => {
      await window.pickup.obsidian({
        action: "saveConfig",
        enabled: true,
        vaultPath,
        dailyFolder: "Daily",
        dailyFilenameFormat: "YYYY-MM-DD",
        todoSourcePath: "Projects",
        todoTag: "",
        autoWriteback: true,
      });
    }, vaultDir);

    await page.getByRole("button", { name: "完成", exact: true }).click();

    // 3. Main screen now shows a single generic "导入" button
    await expect(page.getByRole("button", { name: "导入" })).toBeVisible();
    await page.getByRole("button", { name: "导入" }).click();
    await expect(
      page.getByRole("heading", { name: "把外部待办拉进工作台。" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Obsidian" }).click();
    await expect(
      page.getByText("来自 Obsidian 的端到端任务").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "导入已选 1 项到待处理" }).click();

    // 4. Also verify Notion dedup import & both provider badges
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
      page.getByText("来自 Obsidian 的端到端任务").first(),
    ).toBeVisible();
    await expect(
      page.getByText("Obsidian", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("来自 Notion 的端到端验证任务").first(),
    ).toBeVisible();
    await expect(
      page.getByText("Notion", { exact: true }).first(),
    ).toBeVisible();

    // 5. Daily Review now shows unified "写入笔记" with both Notion & Obsidian
    await page.getByRole("button", { name: "今日收尾" }).click();
    await expect(page.getByText("写入笔记")).toBeVisible();
    await page.getByRole("button", { name: "写入 Obsidian" }).click();
    await expect(
      page.getByRole("button", { name: "更新 Obsidian" }),
    ).toBeVisible();

    const status = await page.evaluate(async () =>
      window.pickup.obsidian({ action: "getDailyExportStatus" }),
    );
    expect(status.ok).toBe(true);
    if (status.ok && status.value.action === "getDailyExportStatus") {
      const exportedMd = await readFile(
        join(vaultDir, status.value.targetPath),
        "utf8",
      );
      expect(exportedMd).toContain("<!-- pickup:daily:start:");
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
