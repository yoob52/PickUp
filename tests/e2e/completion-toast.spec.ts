import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import {
  captureTask,
  launch,
  launchEnvironment,
  tempData,
  windowByKind,
} from "./helpers";

for (const kind of ["main", "widget"] as const) {
  test(`${kind} 完成提示可将当前任务重新打开为待处理`, async () => {
    const directory = await tempData();
    const application = await launch(launchEnvironment(directory));
    try {
      const page = await windowByKind(application, "main");
      const surface = await windowByKind(application, kind);
      await surface.emulateMedia({ reducedMotion: "reduce" });
      const title = "整理更新说明";
      const current = page.locator(".current-card");
      await captureTask(application, page, title, "now");
      await expect(current.getByRole("heading", { name: title })).toBeVisible();

      if (kind === "widget") {
        await surface.getByRole("button", { name: "展开桌面入口" }).click();
        await expect(
          surface.getByRole("heading", { name: title }),
        ).toBeVisible();
      }
      await surface.getByRole("button", { name: "完成", exact: true }).click();
      const reopen = surface.getByRole("button", { name: "重新打开" });
      await expect(
        current.getByRole("heading", { name: "现在准备做什么？" }),
      ).toBeVisible();
      await expect(
        page.locator(".task-row").filter({ hasText: title }),
      ).toHaveCount(0);

      await reopen.click();
      await expect(
        surface.getByText("已重新打开，断点历史仍然保留。"),
      ).toBeVisible();
      await expect(
        page.locator(".task-row").filter({ hasText: title }),
      ).toContainText("待处理");
      await expect(
        current.getByRole("heading", { name: "现在准备做什么？" }),
      ).toBeVisible();
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("从详情完成并重新打开暂停的任务，保留断点且不打断当前任务", async () => {
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  try {
    const page = await windowByKind(application, "main");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const pausedTitle = "审阅更新说明";
    const currentTitle = "核对发布清单";
    const nextStep = "检查兼容性说明";
    const current = page.locator(".current-card");
    await captureTask(application, page, pausedTitle, "now");
    await expect(
      current.getByRole("heading", { name: pausedTitle }),
    ).toBeVisible();

    const capture = await captureTask(application, page, currentTitle, "now");
    await capture.getByLabel("下一步").fill(nextStep);
    await capture.getByRole("button", { name: "保存并切换" }).click();
    await expect(
      current.getByRole("heading", { name: currentTitle }),
    ).toBeVisible();

    const row = page.locator(".task-row").filter({ hasText: pausedTitle });
    await row.getByRole("button", { name: "打开详情" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "完成", exact: true })
      .click();
    await expect(
      page.getByText("已标记完成。当前工作没有被打断。"),
    ).toBeVisible();
    await page.getByRole("button", { name: "重新打开" }).click();

    await expect(row).toContainText("待处理");
    await expect(row).toContainText(nextStep);
    await expect(
      current.getByRole("heading", { name: currentTitle }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("今日收尾的键盘用户可以在对话框内重新打开任务", async () => {
  const directory = await tempData();
  const application = await launch(launchEnvironment(directory));
  try {
    const page = await windowByKind(application, "main");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const title = "检查发布说明";
    await captureTask(application, page, title);

    await page.getByRole("button", { name: "今日收尾", exact: true }).click();
    const review = page.getByRole("dialog", { name: "把今天收好。" });
    await review.getByRole("button", { name: new RegExp(title) }).click();
    const detail = page.getByRole("dialog", { name: title });
    await detail.getByRole("button", { name: "完成", exact: true }).click();
    await expect(detail).toHaveCount(0);
    const reopen = review.getByRole("button", { name: "重新打开" });
    await expect(reopen).toBeVisible();

    await review.getByRole("button", { name: "关闭" }).focus();
    await page.keyboard.press("Tab");
    await expect(reopen).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("已重新打开，断点历史仍然保留。"),
    ).toBeVisible();
    await expect(review).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(
      review.getByRole("button", { name: new RegExp(title) }),
    ).toBeFocused();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
