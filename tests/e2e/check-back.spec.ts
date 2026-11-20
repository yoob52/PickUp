import { test, expect } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  captureTask,
  launch,
  launchEnvironment,
  tempData,
  windowByKind,
} from "./helpers";

test("等待事项设置何时回看并在到点后回到恢复区域", async () => {
  test.setTimeout(90_000);
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  const out = join("docs", "verification", "check-back");
  await mkdir(out, { recursive: true });
  try {
    const page = await windowByKind(application, "main");
    await page.setViewportSize({ width: 1280, height: 860 });

    await captureTask(application, page, "等设计确认交互稿");
    await page
      .locator(".task-row")
      .getByText("等设计确认交互稿", { exact: true })
      .click();
    await page.getByRole("button", { name: "标记等待" }).click();
    const dialog = page.getByRole("dialog", { name: "等什么？" });
    await dialog.getByLabel("等待原因").fill("等设计确认交互稿");
    await dialog.getByRole("button", { name: "明天 9:00" }).click();
    await expect(dialog.getByLabel("何时回看（可选）")).toHaveValue(/T09:00$/);
    await page.screenshot({ path: join(out, "set-check-back.png") });
    await dialog.getByRole("button", { name: "标记等待" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/09:00 回看/).first()).toBeVisible();
    await expect(page.getByRole("group", { name: "到点回看" })).toHaveCount(0);

    await captureTask(application, page, "等供应商报价");
    await expect(
      page.getByText("等供应商报价", { exact: true }).first(),
    ).toBeVisible();
    const marked = await page.evaluate(async () => {
      const snapshot = await window.pickup.getWorkspaceSnapshot();
      if (!snapshot.ok) return false;
      const task = snapshot.value.unfinished.find(
        (item) => item.title === "等供应商报价",
      );
      if (!task) return false;
      const result = await window.pickup.markWaiting({
        commandId: crypto.randomUUID(),
        task: { taskId: task.id, expectedVersion: task.version },
        reason: "等供应商发来报价单",
        checkBackAt: Date.now() + 2_000,
      });
      return result.ok;
    });
    expect(marked).toBe(true);

    const card = page.getByRole("group", { name: "到点回看" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("等供应商报价")).toBeVisible();
    await expect(card.getByText("在等：等供应商发来报价单")).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, "resurfaced.png") });

    await page.getByRole("button", { name: "今日收尾" }).click();
    const review = page.getByRole("dialog", { name: "把今天收好。" });
    await expect(review).toBeVisible();
    await expect(
      review.getByRole("button", { name: "选为第一件事" }),
    ).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
