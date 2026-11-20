import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import { startSyncRelay } from "../sync-relay";
import {
  launch,
  launchEnvironment,
  tempData,
  windowByKind,
} from "../e2e/helpers";

test("phone registers, confirms the desktop QR request, and both encrypted stores converge", async ({
  page,
}) => {
  const relay = await startSyncRelay(["http://127.0.0.1:4174"]),
    directory = await tempData();
  const desktop = await launch(launchEnvironment(directory));
  try {
    const main = await windowByKind(desktop, "main"),
      serverUrl = relay.url.replace("127.0.0.1", "localhost");
    await page.goto("/");
    await page.getByRole("button", { name: "打开同步" }).tap();
    const sheet = page.getByRole("dialog", { name: "同步", exact: true });
    await sheet.getByRole("button", { name: "注册", exact: true }).tap();
    await sheet.getByLabel("邮箱", { exact: true }).fill("phone@example.com");
    await sheet.getByLabel("密码", { exact: true }).fill("a strong password");
    await sheet.getByText("高级", { exact: true }).tap();
    await sheet.getByLabel("账户服务器").fill(serverUrl);
    await sheet.getByRole("button", { name: "注册并加密同步" }).tap();
    await expect(sheet.getByLabel("恢复码（仅此一次）")).toHaveValue(
      /^pickup-recovery:1:/,
    );
    await sheet.getByLabel("我已离线保存恢复码").check();
    await sheet.getByRole("button", { name: "完成保存" }).tap();
    await expect(
      sheet.getByText("phone@example.com", { exact: true }),
    ).toBeVisible();
    await main.evaluate(() => window.pickup.showMain());
    await main.getByRole("button", { name: "打开设置" }).click();
    const settings = main.getByRole("dialog", { name: "让入口安静。" });
    await settings.getByText("高级", { exact: true }).click();
    await settings.getByLabel("账户服务器").fill(serverUrl);
    await settings
      .getByRole("button", { name: "扫码登录", exact: true })
      .click();
    const qr = main.getByRole("dialog", { name: "扫码登录", exact: true });
    await expect(qr.getByAltText("电脑登录二维码")).toBeVisible();
    await qr.getByRole("button", { name: "复制登录码" }).click();
    await expect(
      qr.getByText("登录码已复制，请仅发送到你信任的手机。"),
    ).toBeVisible();
    const request = await desktop.evaluate(({ clipboard }) =>
      clipboard.readText(),
    );
    expect(request).toMatch(/^pickup-login:1:/);
    await main.screenshot({
      path: test.info().outputPath("pr9b-login-copy.png"),
    });
    await sheet.getByText("粘贴电脑登录码", { exact: true }).tap();
    await sheet.getByLabel("电脑登录码", { exact: true }).fill(request);
    await sheet.getByRole("button", { name: "检查登录请求" }).tap();
    await expect(
      sheet.getByRole("region", { name: "确认电脑登录" }),
    ).toContainText("phone@example.com");
    expect((await main.evaluate(() => window.pickup.getSyncStatus())).ok).toBe(
      true,
    );
    await sheet.getByRole("button", { name: "确认登录电脑" }).tap();
    await expect(
      sheet.getByRole("status").filter({ hasText: "已授权电脑登录" }),
    ).toBeVisible();
    await expect(
      settings.getByText("phone@example.com", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await page.evaluate(() =>
          window.pickup.createTask({
            commandId: crypto.randomUUID(),
            title: "账户同步：手机交给电脑",
            note: "",
          }),
        )
      ).ok,
    ).toBe(true);
    expect((await page.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    expect((await main.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    expect(
      JSON.stringify(
        await main.evaluate(() =>
          window.pickup.listTasks({ statuses: ["todo"], offset: 0, limit: 50 }),
        ),
      ),
    ).toContain("账户同步：手机交给电脑");
    expect(
      (
        await main.evaluate(() =>
          window.pickup.createTask({
            commandId: crypto.randomUUID(),
            title: "账户同步：电脑交给手机",
            note: "",
          }),
        )
      ).ok,
    ).toBe(true);
    expect((await main.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    expect((await page.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    expect(
      JSON.stringify(
        await page.evaluate(() =>
          window.pickup.listTasks({ statuses: ["todo"], offset: 0, limit: 50 }),
        ),
      ),
    ).toContain("账户同步：电脑交给手机");
  } finally {
    await desktop.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});
