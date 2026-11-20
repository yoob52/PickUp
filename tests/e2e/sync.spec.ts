import { test, expect } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { launch, launchEnvironment, tempData, windowByKind } from "./helpers";
import { startSyncRelay } from "../sync-relay";

test("desktop settings enables encrypted sync and displays a private pairing QR", async ({}, info) => {
  const server = await startSyncRelay();
  const directory = await tempData();
  const screenshots = process.env.PICKUP_SCREENSHOT_DIR ?? info.outputDir;
  await mkdir(screenshots, { recursive: true });
  const application = await launch(launchEnvironment(directory));
  try {
    const main = await windowByKind(application, "main");
    await main.evaluate(() => window.pickup.showMain());
    await main.getByRole("button", { name: "打开设置" }).click();
    const settings = main.getByRole("dialog", { name: "让入口安静。" });
    await settings.getByLabel("服务器地址").fill(server.url);
    await settings.getByLabel("注册令牌").fill(server.token);
    await settings
      .getByRole("button", { name: "启用同步", exact: true })
      .click();
    await expect(
      settings.getByRole("button", { name: "立即同步" }),
    ).toBeVisible();
    await settings.getByRole("button", { name: "立即同步" }).click();
    await expect(settings.getByRole("status")).toHaveText("已同步");
    await settings.locator(".sync-settings").scrollIntoViewIfNeeded();
    await settings.evaluate((node) => {
      node.scrollTop = 0;
    });
    await main.screenshot({ path: join(screenshots, "pr8-settings.png") });
    await settings.getByRole("button", { name: "显示配对二维码" }).click();
    const pairing = main.getByRole("dialog", { name: "配对设备", exact: true });
    await expect(pairing.getByAltText("同步配对二维码")).toBeVisible();
    await expect(pairing.getByText(/完整访问权限/)).toBeVisible();
    await pairing.getByRole("button", { name: "复制配对码" }).click();
    await expect(pairing.getByRole("status")).toContainText("配对码已复制");
    expect(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
    ).toMatch(/^pickup-sync:1:/);
    const viewport = await main.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    await expect
      .poll(async () => {
        const bounds = (await pairing.boundingBox())!;
        return (
          Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) +
          Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)
        );
      })
      .toBeLessThan(2);
    await main.screenshot({ path: join(screenshots, "pr8-qr.png") });
    await pairing.getByRole("button", { name: "关闭二维码" }).click();
    await expect(pairing).not.toBeVisible();
    await settings.getByRole("button", { name: "停止同步" }).click();
    await expect(
      settings.getByRole("button", { name: "启用同步", exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
