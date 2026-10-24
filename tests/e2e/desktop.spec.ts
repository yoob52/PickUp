import { test, expect } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import {
  captureTask,
  launch,
  launchEnvironment,
  tempData,
  windowByKind,
} from "./helpers";

test("圆形入口点击展开、整球拖动，四角展开后锚点保持原位", async () => {
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  try {
    const widget = await windowByKind(application, "widget");
    const nativeWidget = await application.browserWindow(widget);
    const orb = widget.getByRole("button", { name: "展开桌面入口" });
    const initial = await nativeWidget.evaluate((win) => win.getBounds());
    expect(initial.width).toBe(64);
    expect(initial.height).toBe(64);
    const prefs = await widget.evaluate(() => window.pickup.getPreferences());
    await widget.mouse.move(30, 30);
    await widget.waitForTimeout(450);
    await expect(widget.locator(".is-orb")).toBeVisible();
    await orb.focus();
    await expect(widget.locator(".is-orb")).toBeVisible();
    await widget.keyboard.press("Enter");
    await expect(widget.locator(".is-expanded")).toBeVisible();
    await widget.mouse.move(-10, -10);
    await widget.waitForTimeout(450);
    await expect(widget.locator(".is-expanded")).toBeVisible();
    await widget.keyboard.press("Escape");
    await expect(orb).toBeVisible();

    // Real pointer capture must keep dragging while the native window moves.
    await widget.mouse.move(30, 30);
    await widget.mouse.down();
    await widget.mouse.move(90, 75);
    await expect
      .poll(
        async () => (await nativeWidget.evaluate((win) => win.getBounds())).x,
      )
      .not.toBe(initial.x);
    await widget.mouse.up();
    await expect(widget.locator(".is-orb")).toBeVisible();

    const area = await application.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().workArea,
    );
    const corners = [
      { x: area.x, y: area.y },
      { x: area.x + area.width - 64, y: area.y },
      { x: area.x, y: area.y + area.height - 64 },
      { x: area.x + area.width - 64, y: area.y + area.height - 64 },
    ];
    await mkdir("docs/verification/widget", { recursive: true });
    for (const [index, corner] of corners.entries()) {
      const moved = await widget.evaluate(
        (position) => window.pickup.moveWidget(position),
        corner,
      );
      expect(moved.ok && moved.value).toBe(true);
      await expect
        .poll(() => nativeWidget.evaluate((win) => win.getBounds()))
        .toEqual({ ...corner, width: 64, height: 64 });
      await widget.mouse.move(30, 30);
      await widget.waitForTimeout(100);
      await expect(widget.locator(".is-orb")).toBeVisible();
      await orb.click();
      await expect(widget.locator(".is-expanded")).toBeVisible();
      await expect(
        widget.getByRole("button", { name: "记一件事" }),
      ).toBeVisible();
      const card = await nativeWidget.evaluate((win) => win.getBounds());
      expect(card.x).toBe(
        index % 2 ? area.x + area.width - card.width : corner.x,
      );
      expect(card.y).toBe(
        index >= 2 ? area.y + area.height - card.height : corner.y,
      );
      await widget.screenshot({
        path: `docs/verification/widget/corner-${index}.png`,
        omitBackground: true,
      });
      await widget.getByRole("button", { name: "收起桌面入口" }).click();
      await expect(orb).toBeVisible();
      expect(await nativeWidget.evaluate((win) => win.getBounds())).toEqual({
        ...corner,
        width: 64,
        height: 64,
      });
    }
    await widget.screenshot({
      path: "docs/verification/widget/orb.png",
      omitBackground: true,
    });
    expect(await widget.evaluate(() => window.pickup.getPreferences())).toEqual(
      prefs,
    );
    const invalid = await widget.evaluate(() =>
      window.pickup.moveWidget({ x: NaN, y: 0 }),
    );
    expect(invalid.ok).toBe(false);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("独立 capture 窗口与桌面状态桥接可用", async () => {
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  try {
    const main = await windowByKind(application, "main");
    await expect(
      main.getByRole("navigation", { name: "主导航" }),
    ).toBeVisible();
    const desktop = await main.evaluate(async () => {
      const shown = await window.pickup.showCapture();
      const state = await window.pickup.getDesktopState();
      return {
        shown: shown.ok && shown.value.action === "showCapture",
        registered: state.ok ? state.value.acceleratorRegistered : false,
        methods: Object.keys(window.pickup).includes("quit"),
      };
    });
    expect(desktop.shown).toBe(true);
    expect(desktop.methods).toBe(true);
    const capture = await windowByKind(application, "capture");
    await expect(capture.getByLabel("标题", { exact: true })).toBeFocused();
    await captureTask(application, main, "桌面入口记下的事");
    await expect(
      main.getByText("桌面入口记下的事", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
