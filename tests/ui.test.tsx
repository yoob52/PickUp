import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/src/App";
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
    onStateChanged: () => () => {},
    ...overrides,
  } as PickupAPI;
}

async function openCapture() {
  fireEvent.click(screen.getAllByRole("button", { name: "记一件事" })[0]);
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
  render(<App />);
  await screen.findByText("本地已保存");
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
  render(<App />);
  await screen.findByText("本地已保存");
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
  render(<App />);
  await screen.findByText("本地已保存");
  await openCapture();
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

it("moves focus into the capture dialog and closes it with Escape", async () => {
  window.pickup = createApi({
    getWorkspaceSnapshot: vi
      .fn()
      .mockResolvedValue(ok(emptyWorkspaceSnapshot(), 0)),
  });
  render(<App />);
  await screen.findByText("本地已保存");
  fireEvent.click(screen.getAllByRole("button", { name: "记一件事" })[0]);
  const title = await screen.findByLabelText("标题");
  await waitFor(() => expect(title).toHaveFocus());
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
