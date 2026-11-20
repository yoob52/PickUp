import { expect, test } from "@playwright/test";

test("shared renderer creates and starts a task and retains it after reload without isolation headers", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.headers()["cross-origin-opener-policy"]).toBeUndefined();
  expect(response?.headers()["cross-origin-embedder-policy"]).toBeUndefined();
  await page
    .getByRole("button", { name: "记一件事", exact: true })
    .first()
    .tap();
  await expect(
    page.getByRole("heading", { name: "记下新一件事。" }),
  ).toBeVisible();
  await page.getByLabel("标题", { exact: true }).fill("浏览器持久接续验证");
  await page.getByRole("button", { name: "现在处理", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.pickup.getWorkspaceSnapshot();
        return result.ok ? result.value.currentTask?.title : result.code;
      }),
    )
    .toBe("浏览器持久接续验证");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "浏览器持久接续验证", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "浏览器持久接续验证", exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(async () => {
    const result = await window.pickup.getWorkspaceSnapshot();
    if (!result.ok) throw new Error(result.message);
    return {
      title: result.value.currentTask?.title,
      status: result.value.currentTask?.status,
      count: result.value.counts.unfinished,
    };
  });
  expect(state).toEqual({
    title: "浏览器持久接续验证",
    status: "doing",
    count: 1,
  });
  await page.screenshot({
    path: "test-results/mobile-persisted.png",
    fullPage: true,
  });
});

test("unavailable OPFS produces an explicit failure, not an empty in-memory workspace", async ({
  page,
}) => {
  await page.route("**/worker-*.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `Object.defineProperty(navigator, 'storage', {value: undefined});\n${await response.text()}`,
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "本地数据不可用" }),
  ).toBeVisible();
  const result = await page.evaluate(() =>
    window.pickup.getWorkspaceSnapshot(),
  );
  expect(result).toMatchObject({ ok: false, code: "DB_UNAVAILABLE" });
  if (!result.ok) expect(result.message).toContain("OPFS");
});

test("another tab cannot silently open a separate database", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.pickup.getWorkspaceSnapshot()).ok,
      ),
    )
    .toBe(true);
  const other = await context.newPage();
  await other.goto("/");
  await expect(
    other.getByRole("heading", { name: "本地数据不可用" }),
  ).toBeVisible();
  expect(
    await other.evaluate(() => window.pickup.getWorkspaceSnapshot()),
  ).toMatchObject({ ok: false, code: "DB_UNAVAILABLE" });
  await other.close();
  expect(
    await page.evaluate(() => window.pickup.getWorkspaceSnapshot()),
  ).toMatchObject({ ok: true });
});
