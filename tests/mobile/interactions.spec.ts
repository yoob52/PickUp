import { expect, test, type Page } from "@playwright/test";

async function noOverflow(page: Page) {
  await page.locator(".modal").evaluateAll(async (modals) => {
    await Promise.all(
      modals.flatMap((modal) =>
        modal.getAnimations().map((animation) => animation.finished),
      ),
    );
  });
  expect(
    await page.evaluate(() => {
      const targets = [
        document.documentElement,
        ...document.querySelectorAll<HTMLElement>(".main, .modal"),
      ];
      return targets.every((node) => node.scrollWidth <= node.clientWidth + 1);
    }),
  ).toBe(true);
  const smallTargets = await page
    .locator("button:visible")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width < 44 || rect.height < 44;
        })
        .map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
    );
  expect(smallTargets).toEqual([]);
}

test("phone capture, detail/back, pause and complete stay in-app without desktop APIs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "现在准备做什么？" }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "窗口控制" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开设置" })).toHaveCount(0);
  await expect(
    page.locator(".topbar, .sidebar, .window-controls, .side-nav"),
  ).toHaveCount(0);
  await expect(page.locator(".mobile-header button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "打开同步" })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "手机导航" });
  await expect(navigation).toBeInViewport({ ratio: 1 });
  expect(
    await navigation.evaluate(
      (node) => node.getBoundingClientRect().top > innerHeight - 100,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".mobile-header")
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBeLessThan(60);
  await noOverflow(page);
  await navigation.getByRole("button", { name: "记一件事", exact: true }).tap();
  await page.getByRole("button", { name: "现在处理", exact: true }).tap();
  await expect(page.getByText("请填写任务标题", { exact: true })).toBeVisible();
  const title =
    "整理这次交接中尚未完成的工作并记录下一步需要继续处理的中文长标题";
  await page.getByLabel("标题", { exact: true }).fill(title);
  await page.getByRole("button", { name: "展开备注" }).tap();
  await page
    .getByLabel("备注", { exact: true })
    .fill("先确认所有材料都已经保存。".repeat(12));
  await noOverflow(page);
  await page.getByRole("button", { name: "现在处理", exact: true }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  for (const width of [360, 412, 393]) {
    await page.setViewportSize({ width, height: 851 });
    await noOverflow(page);
  }
  await noOverflow(page);
  await page.getByRole("button", { name: "查看当前任务详情" }).tap();
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
  await noOverflow(page);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "今日收尾", exact: true }).tap();
  await page.getByRole("button", { name: new RegExp(title) }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(2);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    page.getByRole("dialog", { name: "把今天收好。" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "暂停并留线索", exact: true }).tap();
  await page
    .getByLabel("下一步", { exact: true })
    .fill("回到这里继续校对中文材料。".repeat(10));
  await noOverflow(page);
  await page.getByRole("button", { name: "保存并暂停", exact: true }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.locator(".task-row").filter({ hasText: title });
  await row.getByRole("button", { name: "开始或继续" }).tap();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).tap();
  await expect(
    page.getByRole("heading", { name: "现在准备做什么？" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "记一件事", exact: true })
    .first()
    .tap();
  await page.getByLabel("标题", { exact: true }).fill("稍后处理的另一件事");
  await page.getByRole("button", { name: "稍后处理", exact: true }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".task-title").filter({ hasText: "稍后处理的另一件事" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "记一件事", exact: true })
    .first()
    .tap();
  await page.getByLabel("标题", { exact: true }).fill("返回时保存为草稿");
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "记一件事", exact: true })
    .first()
    .tap();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "返回时保存为草稿",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await noOverflow(page);
  expect(errors).toEqual([]);
  await expect(page.getByText(/当前浏览器不支持桌面/)).toHaveCount(0);
});

test("phone capture keeps failed input", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "记一件事", exact: true })
    .first()
    .tap();
  await page.getByLabel("标题", { exact: true }).fill("保存失败仍保留输入");
  await page.evaluate(() => {
    const original = window.pickup;
    window.pickup = {
      ...original,
      createTask: async () => ({
        ok: false,
        code: "STATE_CONFLICT",
        message: "模拟保存冲突，输入仍保留。",
        retryable: true,
      }),
    };
  });
  await page.getByRole("button", { name: "稍后处理", exact: true }).tap();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "保存失败仍保留输入",
  );
  await expect(
    page.getByText("模拟保存冲突，输入仍保留。", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await page.evaluate(() => {
    window.pickup = {
      ...window.pickup,
      saveDraft: async () => ({
        ok: false,
        code: "DB_UNAVAILABLE",
        message: "草稿保存失败，不能关闭。",
        retryable: true,
      }),
    };
  });
  await page.goBack();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "草稿保存失败，不能关闭。",
  );
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "保存失败仍保留输入",
  );
});
