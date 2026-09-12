import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/src/App";
import { CaptureApp } from "../src/renderer/src/views/CaptureApp";
import { WorkspaceProvider } from "../src/renderer/src/state/workspace";
import { ToastProvider } from "../src/renderer/src/ui/Toast";
import type {
  PickupAPI,
  Result,
  TaskSummary,
  WorkspaceSnapshot,
} from "../src/shared/contracts";
import { emptyWorkspaceSnapshot } from "../src/shared/task";

afterEach(cleanup);

function unused(): Promise<never> {
  return Promise.reject(new Error("unexpected bridge call"));
}

function ok<T>(value: T, revision = 1): Result<T> {
  return { ok: true, value, revision };
}

function task(
  partial: Partial<TaskSummary> & Pick<TaskSummary, "id" | "title">,
): TaskSummary {
  return {
    note: "",
    status: "todo",
    waitReason: "",
    createdAt: 1,
    updatedAt: 1,
    statusChangedAt: 1,
    statusRevision: 1,
    endedAt: null,
    version: 1,
    breakpointCount: 0,
    latestBreakpoint: null,
    ...partial,
  };
}

function createApi(overrides: Partial<PickupAPI> = {}): PickupAPI {
  return {
    getWorkspaceSnapshot: unused,
    listTasks: unused,
    getTaskDetail: unused,
    getDailyReview: unused,
    getCommandResult: unused,
    createTask: unused,
    updateTask: unused,
    startTask: unused,
    switchTask: unused,
    pauseTask: unused,
    markWaiting: unused,
    resolveWaiting: unused,
    completeTask: unused,
    cancelTask: unused,
    reopenTask: unused,
    saveBreakpoint: unused,
    setNextUp: unused,
    finishDailyReview: unused,
    getDraft: vi
      .fn()
      .mockResolvedValue(ok({ title: "", note: "", version: 0 }, 0)),
    saveDraft: vi
      .fn()
      .mockResolvedValue(
        ok(
          { type: "saveDraft", draft: { title: "", note: "", version: 1 } },
          0,
        ),
      ),
    clearDraft: unused,
    getPreferences: unused,
    updatePreference: unused,
    showMain: vi
      .fn()
      .mockResolvedValue(ok({ type: "window", action: "showMain" }, 0)),
    showCapture: vi
      .fn()
      .mockResolvedValue(ok({ type: "window", action: "showCapture" }, 0)),
    hideCapture: vi
      .fn()
      .mockResolvedValue(ok({ type: "window", action: "hideCapture" }, 0)),
    hideWidget: unused,
    quit: unused,
    getDesktopState: vi.fn().mockResolvedValue(
      ok(
        {
          accelerator: "Control+Alt+N",
          acceleratorRegistered: true,
          launchAtLogin: false,
          launchAtLoginApplied: true,
          widgetVisible: false,
        },
        0,
      ),
    ),
    onStateChanged: () => () => {},
    onDayInvalidated: () => () => {},
    onCaptureShown: () => () => {},
    onPrepareClose: () => () => {},
    ...overrides,
  } as PickupAPI;
}

function renderCapture() {
  return render(
    <WorkspaceProvider>
      <ToastProvider>
        <CaptureApp />
      </ToastProvider>
    </WorkspaceProvider>,
  );
}

async function openCapture() {
  return screen.findByLabelText("标题");
}

it("shows a database error instead of an empty workspace", async () => {
  window.pickup = createApi({
    getWorkspaceSnapshot: vi.fn().mockResolvedValue({
      ok: false,
      code: "DB_UNAVAILABLE",
      message: "数据库无法打开：磁盘不可写。",
      retryable: true,
    }),
  });
  render(<App />);
  expect(await screen.findByText("本地数据不可用")).toBeInTheDocument();
  expect(screen.getByText("数据库无法打开：磁盘不可写。")).toBeInTheDocument();
  expect(screen.queryByText("现在准备做什么？")).not.toBeInTheDocument();
});

it("retains input on failed save and reuses command ID on retry", async () => {
  const createTask = vi.fn().mockResolvedValue({
    ok: false,
    code: "STORAGE_ERROR",
    message: "模拟保存失败",
    retryable: true,
  });
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
    createTask,
  });
  renderCapture();
  await openCapture();
  fireEvent.change(screen.getByLabelText("标题"), {
    target: { value: "保留我的输入" },
  });
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  await screen.findByText("模拟保存失败");
  expect(screen.getByLabelText("标题")).toHaveValue("保留我的输入");
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
  expect(createTask.mock.calls[0][0].commandId).toBe(
    createTask.mock.calls[1][0].commandId,
  );
  expect(createTask.mock.calls[0][0].title).toBe("保留我的输入");
});

it("does not submit a blank title", async () => {
  const createTask = vi.fn();
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
    createTask,
  });
  renderCapture();
  await openCapture();
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  expect(await screen.findByText("请填写任务标题")).toBeInTheDocument();
  expect(createTask).not.toHaveBeenCalled();
});

it("restores draft text when opening capture", async () => {
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
    getDraft: vi
      .fn()
      .mockResolvedValue(
        ok({ title: "半截想法", note: "还没写完", version: 2 }, 0),
      ),
  });
  renderCapture();
  expect(await screen.findByLabelText("标题")).toHaveValue("半截想法");
  expect(screen.getByLabelText("备注")).toHaveValue("还没写完");
});

it("opens switch flow when starting another task while one is current", async () => {
  const current = task({
    id: "11111111-1111-1111-1111-111111111111",
    title: "排查接口超时",
    status: "doing",
    version: 2,
  });
  const next = task({
    id: "22222222-2222-2222-2222-222222222222",
    title: "处理线上故障",
    status: "todo",
  });
  const snapshot: WorkspaceSnapshot = {
    ...emptyWorkspaceSnapshot(),
    revision: 4,
    currentTask: current,
    unfinished: [current, next],
    counts: {
      todo: 1,
      doing: 1,
      paused: 0,
      waiting: 0,
      done: 0,
      cancelled: 0,
      unfinished: 2,
    },
  };
  window.pickup = createApi({
    getWorkspaceSnapshot: vi.fn().mockResolvedValue(ok(snapshot, 4)),
    startTask: vi.fn().mockResolvedValue({
      ok: false,
      code: "NEED_SWITCH",
      message: "已有进行中的任务，请先切换。",
      retryable: true,
    }),
  });
  render(<App />);
  expect(await screen.findAllByText("排查接口超时")).not.toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "开始或继续" }));
  expect(await screen.findByText("先保存，再继续。")).toBeInTheDocument();
  expect(screen.getByText("下一件事")).toBeInTheDocument();
  expect(screen.getAllByText("处理线上故障").length).toBeGreaterThan(0);
});

it("moves focus into the capture window and hides it with Escape", async () => {
  const hideCapture = vi
    .fn()
    .mockResolvedValue(ok({ type: "window", action: "hideCapture" }, 0));
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
    hideCapture,
  });
  renderCapture();
  const title = await screen.findByLabelText("标题");
  await waitFor(() => expect(title).toHaveFocus());
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(hideCapture).toHaveBeenCalled());
});

it("keeps the same create command when outcome is unknown", async () => {
  let draftVersion = 0;
  const createTask = vi.fn().mockResolvedValue({
    ok: false,
    code: "OUTCOME_UNKNOWN",
    message: "保存结果待确认，请保留内容并重试。",
    retryable: true,
  });
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
    saveDraft: vi.fn().mockImplementation(async (input) => {
      draftVersion += 1;
      return ok(
        {
          type: "saveDraft",
          draft: {
            title: input.title,
            note: input.note,
            version: draftVersion,
          },
        },
        0,
      );
    }),
    getCommandResult: vi.fn().mockResolvedValue(ok({ status: "unknown" }, 0)),
    createTask,
  });
  renderCapture();
  await openCapture();
  fireEvent.change(screen.getByLabelText("标题"), {
    target: { value: "待确认的事项" },
  });
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  await screen.findByText("保存结果待确认，请保留内容并重试。");
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  await waitFor(() => expect(createTask.mock.calls.length).toBeGreaterThan(1));
  const ids = createTask.mock.calls.map((call) => call[0].commandId);
  expect(new Set(ids).size).toBe(1);
  expect(createTask.mock.calls[0][0].draftVersion).toBe(
    createTask.mock.calls.at(-1)?.[0].draftVersion,
  );
});

it("keeps capture open when draft save fails on close", async () => {
  const hideCapture = vi
    .fn()
    .mockResolvedValue(ok({ type: "window", action: "hideCapture" }, 0));
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
    hideCapture,
    saveDraft: vi.fn().mockResolvedValue({
      ok: false,
      code: "STORAGE_ERROR",
      message: "草稿未保存",
      retryable: true,
    }),
  });
  renderCapture();
  const title = await screen.findByLabelText("标题");
  fireEvent.change(title, { target: { value: "不能丢掉" } });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(await screen.findByText("草稿未保存")).toBeInTheDocument();
  expect(hideCapture).not.toHaveBeenCalled();
  expect(screen.getByLabelText("标题")).toHaveValue("不能丢掉");
});

it("flushes capture draft when the host asks to prepare close", async () => {
  let handler: (() => Promise<boolean>) | undefined;
  const saveDraft = vi
    .fn()
    .mockResolvedValue(
      ok({ type: "saveDraft", draft: { title: "x", note: "", version: 2 } }, 0),
    );
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
    saveDraft,
    onPrepareClose: (fn) => {
      handler = fn;
      return () => {};
    },
  });
  renderCapture();
  fireEvent.change(await screen.findByLabelText("标题"), {
    target: { value: "关闭窗口前的未提交草稿" },
  });
  expect(handler).toBeTypeOf("function");
  await expect(handler!()).resolves.toBe(true);
  expect(saveDraft).toHaveBeenCalled();
  expect(saveDraft.mock.calls.at(-1)?.[0].title).toBe("关闭窗口前的未提交草稿");
});

it("does not call the workspace empty when waiting tasks remain", async () => {
  const waiting = task({
    id: "33333333-3333-3333-3333-333333333333",
    title: "等接口发布",
    status: "waiting",
  });
  window.pickup = createApi({
    getWorkspaceSnapshot: vi.fn().mockResolvedValue(
      ok(
        {
          ...emptyWorkspaceSnapshot(),
          unfinished: [waiting],
          counts: {
            todo: 0,
            doing: 0,
            paused: 0,
            waiting: 1,
            done: 0,
            cancelled: 0,
            unfinished: 1,
          },
        },
        1,
      ),
    ),
  });
  render(<App />);
  expect(
    await screen.findByText(/等待中的事项不会自动开始/),
  ).toBeInTheDocument();
  expect(screen.queryByText("当前工作区是空的")).not.toBeInTheDocument();
});

it("keeps unfinished review breakpoint after inspecting a task", async () => {
  const current = task({
    id: "11111111-1111-1111-1111-111111111111",
    title: "排查接口超时",
    status: "doing",
  });
  const other = task({
    id: "22222222-2222-2222-2222-222222222222",
    title: "处理线上故障",
    status: "paused",
  });
  window.pickup = createApi({
    getWorkspaceSnapshot: vi.fn().mockResolvedValue(
      ok(
        {
          ...emptyWorkspaceSnapshot(),
          currentTask: current,
          unfinished: [current, other],
          counts: {
            todo: 0,
            doing: 1,
            paused: 1,
            waiting: 0,
            done: 0,
            cancelled: 0,
            unfinished: 2,
          },
        },
        2,
      ),
    ),
    getDailyReview: vi.fn().mockResolvedValue(
      ok(
        {
          dayKey: "2026-09-12",
          startUtc: 1,
          endUtc: 2,
          currentTask: current,
          completedToday: {
            items: [],
            total: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
          },
          unfinished: [current, other],
          counts: {
            todo: 0,
            doing: 1,
            paused: 1,
            waiting: 0,
            done: 0,
            cancelled: 0,
            unfinished: 2,
          },
          nextUp: null,
          nextUpVersion: 0,
        },
        2,
      ),
    ),
    getTaskDetail: vi.fn().mockResolvedValue(
      ok(
        {
          task: other,
          breakpoints: {
            items: [],
            total: 0,
            offset: 0,
            limit: 10,
            hasMore: false,
          },
          transitions: {
            items: [],
            total: 0,
            offset: 0,
            limit: 20,
            hasMore: false,
          },
        },
        2,
      ),
    ),
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "今日收尾" }));
  const reviewDialog = await screen.findByRole("dialog", {
    name: "把今天收好。",
  });
  const breakpoint = within(reviewDialog).getByRole("textbox", {
    name: "给当前任务补一句断点（可选）",
  });
  fireEvent.change(breakpoint, {
    target: { value: "审核草稿：下一步检查日志" },
  });
  fireEvent.click(
    within(reviewDialog).getByRole("button", { name: /处理线上故障/ }),
  );
  const detailDialog = await screen.findByRole("dialog", {
    name: "处理线上故障",
  });
  fireEvent.click(within(detailDialog).getByRole("button", { name: "关闭" }));
  expect(
    screen.getByRole("dialog", { name: "把今天收好。" }),
  ).toBeInTheDocument();
  expect(
    within(reviewDialog).getByRole("textbox", {
      name: "给当前任务补一句断点（可选）",
    }),
  ).toHaveValue("审核草稿：下一步检查日志");
});
