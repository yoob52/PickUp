import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("secure renderer creates a persisted task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pickup-e2e-"));
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
  const application = await _electron.launch({
    args: process.env.PICKUP_PACKAGED_EXE ? [] : ["."],
    executablePath: process.env.PICKUP_PACKAGED_EXE,
    env,
  });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("heading", { name: "从记下这一件开始。" }),
    ).toBeVisible();
    await page.getByLabel("标题", { exact: true }).fill("验证真实桌面保存");
    await page.getByRole("button", { name: "保存为待处理" }).click();
    await expect(
      page.getByText("验证真实桌面保存", { exact: true }),
    ).toBeVisible();
    const isolation = await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      bridge: typeof (window as unknown as { pickup: { createTask: unknown } })
        .pickup.createTask,
    }));
    expect(isolation).toEqual({ node: "undefined", bridge: "function" });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
