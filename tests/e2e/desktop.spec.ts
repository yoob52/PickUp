import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import {
  captureTask,
  launch,
  launchEnvironment,
  tempData,
  windowByKind,
} from "./helpers";

test("独立 capture 窗口与桌面状态桥接可用", async () => {
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  try {
    const main = await windowByKind(application, "main");
    await expect(main.getByRole("heading", { name: /别让工作/ })).toBeVisible();
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
