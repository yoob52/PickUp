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
afterEach(cleanup);
it("retains input on failed save and reuses command ID on retry", async () => {
  const createTask = vi.fn().mockResolvedValue({
    ok: false,
    code: "STORAGE_ERROR",
    message: "模拟保存失败",
  });
  window.pickup = {
    snapshot: vi.fn().mockResolvedValue({
      ok: true,
      value: { revision: 0, tasks: [] },
      revision: 0,
    }),
    createTask,
    onStateChanged: () => () => {},
  };
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
