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
import type { PickupAPI } from "../src/shared/contracts";
import { emptyWorkspaceSnapshot } from "../src/shared/task";

afterEach(cleanup);

/** 测试替身：只实现被测组件实际调用的方法，其余保持未使用。 */
function createApi(overrides: Partial<PickupAPI>): PickupAPI {
  const unused = () => Promise.reject(new Error("unexpected bridge call"));
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
    getDraft: unused,
    saveDraft: unused,
    clearDraft: unused,
    getPreferences: unused,
    updatePreference: unused,
    onStateChanged: () => () => {},
    ...overrides,
  } as PickupAPI;
}

it("retains input on failed save and reuses command ID on retry", async () => {
  const createTask = vi.fn().mockResolvedValue({
    ok: false,
    code: "STORAGE_ERROR",
    message: "模拟保存失败",
    retryable: true,
  });
  window.pickup = createApi({
    getWorkspaceSnapshot: vi.fn().mockResolvedValue({
      ok: true,
      value: emptyWorkspaceSnapshot(),
      revision: 0,
    }),
    createTask,
  });
  render(<App />);
  await screen.findByText("已连接本地数据库");
  fireEvent.change(screen.getByLabelText("标题"), {
    target: { value: "保留我的输入" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存为待处理" }));
  await screen.findByText("模拟保存失败");
  expect(screen.getByLabelText("标题")).toHaveValue("保留我的输入");
  fireEvent.click(screen.getByRole("button", { name: "保存为待处理" }));
  await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
  expect(createTask.mock.calls[0][0].commandId).toBe(
    createTask.mock.calls[1][0].commandId,
  );
});
