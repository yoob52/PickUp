import {
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function launchEnvironment(directory: string): Record<string, string> {
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

export function launch(env: Record<string, string>) {
  return _electron.launch({
    args: process.env.PICKUP_PACKAGED_EXE ? [] : ["."],
    executablePath: process.env.PICKUP_PACKAGED_EXE,
    env,
  });
}

export async function tempData(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pickup-e2e-"));
}

export async function windowByKind(
  application: ElectronApplication,
  kind: "main" | "capture" | "widget",
  timeoutMs = 8_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      const marker = await page
        .evaluate(() => document.documentElement.dataset.window ?? "")
        .catch(() => "");
      const url = page.url();
      if (marker === kind) return page;
      if (kind !== "main" && url.includes(`window=${kind}`)) return page;
      if (
        kind === "main" &&
        !url.includes("window=capture") &&
        !url.includes("window=widget") &&
        marker !== "capture" &&
        marker !== "widget"
      )
        return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`找不到 ${kind} 窗口`);
}

export async function captureTask(
  application: ElectronApplication,
  main: Page,
  title: string,
  intent: "later" | "now" = "later",
): Promise<Page> {
  await main.getByRole("button", { name: "记一件事" }).first().click();
  const capture = await windowByKind(application, "capture");
  const field = capture.getByLabel("标题", { exact: true });
  await field.fill(title);
  await capture
    .getByRole("button", {
      name: intent === "later" ? "稍后处理" : "现在处理",
    })
    .click();
  return capture;
}
