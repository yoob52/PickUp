import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import { startSyncRelay } from "../sync-relay";
import {
  launch,
  launchEnvironment,
  tempData,
  windowByKind,
} from "../e2e/helpers";

test("phone paste pairing converges with the real desktop store and Android-style back closes sync", async ({
  page,
}) => {
  const relay = await startSyncRelay(["http://127.0.0.1:4174"]);
  const directory = await tempData();
  const desktop = await launch(launchEnvironment(directory));
  try {
    const main = await windowByKind(desktop, "main");
    const url = relay.url.replace("127.0.0.1", "localhost");
    const enabled = await main.evaluate(
      async ({ url, token }) =>
        window.pickup.enableSync({ serverUrl: url, registrationToken: token }),
      { url, token: relay.token },
    );
    expect(enabled.ok).toBe(true);
    const payload = await main.evaluate(() =>
      window.pickup.getPairingPayload(),
    );
    if (!payload.ok) throw new Error(payload.message);
    await page.goto("/");
    await page.getByRole("button", { name: "打开同步" }).tap();
    const sheet = page.getByRole("dialog", { name: "同步", exact: true });
    await expect(
      sheet.getByRole("button", { name: "扫码配对", exact: true }),
    ).toBeVisible();
    await sheet.getByLabel("粘贴配对码").fill("bad");
    await sheet.getByRole("button", { name: "配对并同步" }).tap();
    await expect(sheet.getByRole("alert")).toContainText("配对信息无效");
    await sheet.getByLabel("粘贴配对码").fill(payload.value);
    await sheet.getByRole("button", { name: "配对并同步" }).tap();
    await expect(sheet.getByRole("status")).toContainText("已同步");
    await page.goBack();
    await expect(sheet).toHaveCount(0);
    const created = await page.evaluate(() =>
      window.pickup.createTask({
        commandId: crypto.randomUUID(),
        title: "手机接着记录",
        note: "",
      }),
    );
    expect(created.ok).toBe(true);
    expect((await page.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    expect((await main.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    const desktopTasks = await main.evaluate(() =>
      window.pickup.listTasks({ statuses: ["todo"], offset: 0, limit: 50 }),
    );
    expect(JSON.stringify(desktopTasks)).toContain("手机接着记录");
    expect(
      (
        await main.evaluate(() =>
          window.pickup.createTask({
            commandId: crypto.randomUUID(),
            title: "电脑交给手机",
            note: "下一步",
          }),
        )
      ).ok,
    ).toBe(true);
    expect((await main.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    expect((await page.evaluate(() => window.pickup.syncNow())).ok).toBe(true);
    const phoneTasks = await page.evaluate(() =>
      window.pickup.listTasks({ statuses: ["todo"], offset: 0, limit: 50 }),
    );
    expect(JSON.stringify(phoneTasks)).toContain("电脑交给手机");
    await page.getByRole("button", { name: "打开同步" }).tap();
    await sheet.getByRole("button", { name: "停止同步" }).tap();
    await expect(sheet.getByLabel("粘贴配对码")).toBeVisible();
    expect(
      (
        await page.evaluate(() =>
          window.pickup.listTasks({ statuses: ["todo"], offset: 0, limit: 50 }),
        )
      ).ok,
    ).toBe(true);
  } finally {
    await desktop.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});
