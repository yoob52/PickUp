import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import {
  captureTask,
  launch,
  launchEnvironment,
  tempData,
  windowByKind,
} from "./helpers";

test("界面走完记录到收尾并在重启后恢复", async () => {
  test.setTimeout(90_000);
  const directory = await tempData();
  const env = launchEnvironment(directory);
  const first = await launch(env);
  try {
    const page = await windowByKind(first, "main");
    await expect(page.getByRole("heading", { name: /别让工作/ })).toBeVisible();
    await expect(page.getByText("现在准备做什么？")).toBeVisible();

    await captureTask(first, page, "排查接口超时");
    await expect(
      page.getByText("排查接口超时", { exact: true }).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "开始或继续" }).click();
    await expect(
      page
        .locator(".current-card")
        .getByRole("heading", { name: "排查接口超时" }),
    ).toBeVisible();

    const capture = await captureTask(first, page, "处理线上故障", "now");
    await expect(
      capture.getByRole("heading", { name: "先保存，再继续。" }),
    ).toBeVisible();
    await capture.getByLabel("下一步").fill("检查下游重试配置");
    await capture.getByRole("button", { name: "保存并切换" }).click();
    await expect(
      page
        .locator(".current-card")
        .getByRole("heading", { name: "处理线上故障" }),
    ).toBeVisible();

    await page
      .locator(".current-card")
      .getByRole("button", { name: "完成" })
      .click();
    await expect(page.getByText("继续这件事")).toBeVisible();
    await expect(page.getByText("检查下游重试配置").first()).toBeVisible();
    await page.getByRole("button", { name: "继续这件事" }).click();
    await expect(
      page
        .locator(".current-card")
        .getByRole("heading", { name: "排查接口超时" }),
    ).toBeVisible();

    await captureTask(first, page, "等同事补日志");
    const waitingRow = page.getByText("等同事补日志", { exact: true }).first();
    await waitingRow.click();
    await page.getByRole("button", { name: "标记等待" }).click();
    await page.getByLabel("等待原因").fill("等同事补日志");
    await page.getByRole("button", { name: "标记等待" }).click();
    await expect(page.getByText("等待中").first()).toBeVisible();

    await page.getByRole("button", { name: "今日收尾" }).click();
    await expect(
      page.getByRole("heading", { name: "把今天收好。" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "选为第一件事" }).first().click();
    await page.getByRole("button", { name: "保留当前状态" }).click();
    await expect(page.getByText("收尾完成", { exact: false })).toBeVisible();
  } finally {
    await first.close();
  }

  const second = await launch(env);
  try {
    const page = await windowByKind(second, "main");
    await expect(
      page
        .locator(".current-card")
        .getByRole("heading", { name: "排查接口超时" }),
    ).toBeVisible();
    await expect(page.getByText("等同事补日志").first()).toBeVisible();
    await expect(page.getByText("检查下游重试配置").first()).toBeVisible();
  } finally {
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
