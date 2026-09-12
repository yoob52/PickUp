import { test, expect } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { launch, launchEnvironment, tempData, windowByKind } from "./helpers";

test("保存主窗口、快速记录与当前任务的视觉记录", async () => {
  test.setTimeout(90_000);
  const directory = await tempData();
  const out = join("docs", "verification");
  await mkdir(out, { recursive: true });
  const application = await launch(launchEnvironment(directory));
  try {
    const page = await windowByKind(application, "main");
    await expect(page.getByText("现在准备做什么？")).toBeVisible();
    await page.screenshot({
      path: join(out, "01-main-empty.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "记一件事" }).first().click();
    const capture = await windowByKind(application, "capture");
    await expect(capture.getByLabel("标题", { exact: true })).toBeFocused();
    await capture.screenshot({
      path: join(out, "02-capture.png"),
      fullPage: true,
    });
    await capture.getByLabel("标题", { exact: true }).fill("排查接口超时");
    await capture.getByRole("button", { name: "稍后处理" }).click();
    await expect(
      page.getByText("排查接口超时", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "开始或继续" }).click();
    await expect(
      page
        .locator(".current-card")
        .getByRole("heading", { name: "排查接口超时" }),
    ).toBeVisible();
    await page.screenshot({
      path: join(out, "03-current-task.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "查看当前任务详情" }).click();
    const detail = page.getByRole("dialog", { name: "排查接口超时" });
    await expect(
      detail.getByRole("button", { name: "标记等待" }),
    ).toBeVisible();
    await page.screenshot({
      path: join(out, "07-detail-contrast.png"),
      fullPage: true,
    });
    await detail.getByRole("button", { name: "关闭" }).click();

    await page.getByRole("button", { name: "打开设置" }).click();
    await expect(
      page.getByRole("heading", { name: "让入口安静。" }),
    ).toBeVisible();
    await page.screenshot({
      path: join(out, "05-settings.png"),
      fullPage: true,
    });
    await page.getByRole("dialog").getByRole("button", { name: "完成" }).click();

    await page.setViewportSize({ width: 600, height: 540 });
    await expect(page.getByRole("button", { name: "今日收尾" })).toBeVisible();
    await page.screenshot({
      path: join(out, "04-small-window.png"),
      fullPage: true,
    });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
