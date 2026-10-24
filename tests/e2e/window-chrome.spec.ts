import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, launchEnvironment, tempData, windowByKind } from "./helpers";

test("同色原生窗口按钮、菜单移除和窗口生命周期", async () => {
  test.setTimeout(60_000);
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  try {
    const main = await windowByKind(application, "main");
    await main.evaluate(() => window.pickup.showMain());
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => !win.webContents.getURL().includes("window="))!
        .show();
    });
    for (const kind of ["main", "capture"] as const) {
      const page = await windowByKind(application, kind);
      const chrome = await page.evaluate(() => {
        const overlay = (
          navigator as Navigator & {
            windowControlsOverlay: {
              visible: boolean;
              getTitlebarAreaRect(): DOMRect;
            };
          }
        ).windowControlsOverlay;
        const header = document.querySelector("header")!;
        return {
          overlay: overlay.visible,
          width: overlay.getTitlebarAreaRect().width,
          viewport: innerWidth,
          height: header.getBoundingClientRect().height,
          drag: getComputedStyle(header).getPropertyValue("-webkit-app-region"),
          right: parseFloat(getComputedStyle(header).paddingRight),
        };
      });
      expect(chrome.overlay).toBe(true);
      expect(chrome.width).toBeLessThan(chrome.viewport);
      expect(chrome.height).toBe(kind === "main" ? 72 : 40);
      expect(chrome.drag).toBe("drag");
      expect(chrome.right).toBeGreaterThanOrEqual(
        chrome.viewport - chrome.width,
      );
    }
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((win) => !win.isMenuBarVisible()),
      ),
    ).toBe(true);
    const nativeScreenshot = await application.evaluate(
      async ({ BrowserWindow, desktopCapturer }) => {
        const win = BrowserWindow.getAllWindows().find(
          (win) => !win.webContents.getURL().includes("window="),
        )!;
        const sources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: 1600, height: 1200 },
        });
        const source = sources.find(
          (source) => source.id === win.getMediaSourceId(),
        );
        if (!source || source.thumbnail.isEmpty())
          throw new Error("Missing native window screenshot");
        return source.thumbnail.toPNG().toString("base64");
      },
    );
    const out = join("docs", "verification", "window-chrome");
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, "native-main.png"),
      Buffer.from(nativeScreenshot, "base64"),
    );
    await main.getByRole("button", { name: "打开设置" }).click();
    await expect(main.getByRole("dialog")).toBeVisible();
    await main.keyboard.press("Escape");
    await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (win) => !win.webContents.getURL().includes("window="),
      )!;
      win.maximize();
    });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((win) => win.isMaximized()),
        ),
      )
      .toBe(true);
    await expect(main.getByRole("button", { name: "打开设置" })).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (win) => !win.webContents.getURL().includes("window="),
      )!;
      win.unmaximize();
      win.minimize();
    });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((win) => win.isMinimized()),
        ),
      )
      .toBe(true);
    await main.evaluate(() => window.pickup.showMain());
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => !win.webContents.getURL().includes("window="))!
        .close();
    });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((win) => !win.webContents.getURL().includes("window="))!
            .isVisible(),
        ),
      )
      .toBe(false);
    await main.evaluate(() => window.pickup.showMain());
    // Test mode keeps main windows hidden; explicitly show it for pointer input.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => !win.webContents.getURL().includes("window="))!
        .show();
    });
    await main
      .getByRole("button", { name: "记一件事", exact: true })
      .first()
      .click();
    const capture = await windowByKind(application, "capture");
    await capture
      .getByLabel("标题", { exact: true })
      .fill("窗口关闭后保留的草稿");
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes("window=capture"))!
        .close();
    });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((win) => win.webContents.getURL().includes("window=capture"))!
            .isVisible(),
        ),
      )
      .toBe(false);
    await main.evaluate(() => window.pickup.showCapture());
    await expect(capture.getByLabel("标题", { exact: true })).toHaveValue(
      "窗口关闭后保留的草稿",
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
