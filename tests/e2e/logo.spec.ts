import { test, expect, type Locator } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import { launch, launchEnvironment, tempData, windowByKind } from "./helpers";

test("主窗口与桌面入口加载同一品牌原图，展开收起保持可用", async () => {
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  const original = await readFile("docs/logo.png");
  async function expectLogo(locator: Locator) {
    await expect(locator).toBeVisible();
    await expect
      .poll(() => locator.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1024);
    const bytes = await locator.evaluate(async (img: HTMLImageElement) => {
      const response = await fetch(img.src);
      if (!response.ok) throw new Error(`Logo request: ${response.status}`);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    });
    expect(Buffer.from(bytes).equals(original)).toBe(true);
    await expect(locator).toHaveAttribute("draggable", "false");
  }
  try {
    const main = await windowByKind(application, "main");
    const widget = await windowByKind(application, "widget");
    await expectLogo(main.locator(".brand-mark"));
    await expectLogo(widget.locator(".widget-logo"));
    await widget.getByRole("button", { name: "展开桌面入口" }).click();
    await expectLogo(widget.locator(".widget-kicker img"));
    await widget.getByRole("button", { name: "收起桌面入口" }).click();
    await expectLogo(widget.locator(".widget-logo"));
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
