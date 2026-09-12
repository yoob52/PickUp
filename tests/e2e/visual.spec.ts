import { test, expect, _electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function launchEnvironment(directory: string): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PICKUP_E2E: "1",
    PICKUP_TEST_DATA: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

test("保存主窗口、快速记录与当前任务的视觉记录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pickup-e2e-visual-"));
  const out = join("docs", "verification");
  await mkdir(out, { recursive: true });
  const application = await _electron.launch({
    args: process.env.PICKUP_PACKAGED_EXE ? [] : ["."],
    executablePath: process.env.PICKUP_PACKAGED_EXE,
    env: launchEnvironment(directory),
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText("现在准备做什么？")).toBeVisible();
    await page.screenshot({
      path: join(out, "01-main-empty.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "记一件事" }).first().click();
    await expect(page.getByLabel("标题", { exact: true })).toBeFocused();
    await page.screenshot({
      path: join(out, "02-capture.png"),
      fullPage: true,
    });
    await page.getByLabel("标题", { exact: true }).fill("排查接口超时");
    await page.getByRole("button", { name: "稍后处理" }).click();
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
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
