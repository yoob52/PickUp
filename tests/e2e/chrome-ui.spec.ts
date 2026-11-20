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

test("铬白工作台保留侧栏、窄窗口导航和长任务操作", async () => {
  test.setTimeout(90_000);
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  const out = join("docs", "verification", "chrome-ui");
  await mkdir(out, { recursive: true });
  try {
    const page = await windowByKind(application, "main");
    await expect(
      page.getByRole("heading", { name: "现在准备做什么？" }),
    ).toBeVisible();
    const nav = page.getByRole("navigation", { name: "主导航" });
    const workbench = nav.getByRole("button", { name: "工作台" });
    const filters = page.getByRole("tablist", { name: "任务筛选" });
    const waiting = filters.getByRole("tab", { name: "等待", exact: true });
    await expect(nav.getByRole("button")).toHaveCount(2);
    await expect(workbench).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "今日收尾" })).toBeVisible();
    await page.screenshot({ path: join(out, "empty.png"), fullPage: true });
    const title =
      "跟进交付接口与客户端重试配置，核对中断后的上下文和下一步。".repeat(4);
    await captureTask(application, page, title, "now");
    await expect(page.locator(".current-card h2")).toHaveText(title);
    await page
      .locator(".current-card")
      .getByRole("button", { name: "暂停并留线索" })
      .click();
    await page
      .getByLabel("下一步")
      .fill("对照日志确认超时位置，继续检查重试策略。");
    await page.getByRole("button", { name: "保存并暂停" }).click();
    await expect(page.locator(".recommend-title")).toHaveText(title);
    await page.getByRole("button", { name: "继续这件事" }).click();
    await expect(page.locator(".current-card h2")).toHaveText(title);
    for (const width of [1440, 900, 600, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("main.main").evaluate((el) => el.scrollTo(0, 0));
      await expect(nav).toBeVisible();
      const sidebar = await page.locator(".sidebar").boundingBox();
      const main = await page.locator("main.main").boundingBox();
      expect(sidebar).not.toBeNull();
      expect(main).not.toBeNull();
      expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(main!.x + 1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width === 1440) {
        const current = await page.locator(".current-card").boundingBox();
        const recovery = await page.locator(".recovery-panel").boundingBox();
        expect(current!.x + current!.width).toBeLessThan(recovery!.x);
        expect(Math.abs(current!.y - recovery!.y)).toBeLessThan(1);
      }
      await page.screenshot({
        path: join(out, `long-${width}.png`),
        fullPage: true,
      });
      const topbar = await page.locator(".topbar").boundingBox();
      await page.locator("main.main").hover();
      await page.mouse.wheel(0, 1200);
      await expect
        .poll(() => page.locator("main.main").evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      expect(await page.locator(".topbar").boundingBox()).toEqual(topbar);
      expect(await page.locator(".sidebar").boundingBox()).toEqual(sidebar);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.screenshot({ path: join(out, `scrolled-${width}.png`) });
      await waiting.click();
      await expect(waiting).toHaveAttribute("aria-selected", "true");
      await workbench.click();
      await expect
        .poll(() => page.locator("main.main").evaluate((el) => el.scrollTop))
        .toBe(0);
      await expect(waiting).toHaveAttribute("aria-selected", "true");
      expect(await page.locator(".topbar").boundingBox()).toEqual(topbar);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }
    await page.setViewportSize({ width: 1120, height: 780 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "打开设置" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: join(out, "settings.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开设置" })).toBeFocused();
    await page.locator("main.main").evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({ path: join(out, "main.png"), fullPage: true });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
