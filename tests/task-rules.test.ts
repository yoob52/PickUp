import { describe, expect, it } from "vitest";
import {
  ENDED_STATUSES,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  TASK_TRANSITIONS,
  UNFINISHED_STATUSES,
  canTransition,
  emptyCounts,
  emptyWorkspaceSnapshot,
  isEndedStatus,
  isStartableStatus,
  isUnfinishedStatus,
  type TaskStatus,
} from "../src/shared/task";

describe("状态定义", () => {
  it("覆盖 PRD 的六种状态且都有中文名称", () => {
    expect([...TASK_STATUSES]).toEqual([
      "todo",
      "doing",
      "paused",
      "waiting",
      "done",
      "cancelled",
    ]);
    for (const status of TASK_STATUSES)
      expect(TASK_STATUS_LABEL[status].length).toBeGreaterThan(0);
    expect([...ENDED_STATUSES]).toEqual(["done", "cancelled"]);
    expect([...UNFINISHED_STATUSES]).toEqual([
      "todo",
      "doing",
      "paused",
      "waiting",
    ]);
  });

  it("区分未结束、已结束与可开始状态", () => {
    for (const status of TASK_STATUSES) {
      expect(isEndedStatus(status)).toBe(
        status === "done" || status === "cancelled",
      );
      expect(isUnfinishedStatus(status)).toBe(!isEndedStatus(status));
      expect(isStartableStatus(status)).toBe(
        status === "todo" || status === "paused" || status === "waiting",
      );
    }
  });
});

describe("状态转换表", () => {
  const legal: [TaskStatus, TaskStatus][] = [
    ["todo", "doing"],
    ["todo", "waiting"],
    ["todo", "done"],
    ["todo", "cancelled"],
    ["doing", "paused"],
    ["doing", "waiting"],
    ["doing", "done"],
    ["doing", "cancelled"],
    ["paused", "doing"],
    ["paused", "waiting"],
    ["paused", "done"],
    ["paused", "cancelled"],
    ["waiting", "todo"],
    ["waiting", "doing"],
    ["waiting", "done"],
    ["waiting", "cancelled"],
    ["done", "todo"],
    ["cancelled", "todo"],
  ];

  it("允许 PRD 列出的转换", () => {
    for (const [from, to] of legal) expect(canTransition(from, to)).toBe(true);
  });

  it("拒绝表中不存在的转换", () => {
    const illegal = legal.map(([from, to]) => `${from}->${to}`);
    for (const from of TASK_STATUSES)
      for (const to of TASK_STATUSES)
        if (!illegal.includes(`${from}->${to}`))
          expect(canTransition(from, to)).toBe(false);
  });

  it("暂停任务不能直接回到待处理，只能通过开始或重新打开", () => {
    expect(canTransition("paused", "todo")).toBe(false);
    expect(canTransition("done", "doing")).toBe(false);
    expect(canTransition("cancelled", "doing")).toBe(false);
    expect(TASK_TRANSITIONS.waiting).toContain("todo");
  });
});

describe("空快照", () => {
  it("没有任务时没有当前任务，也不虚构推荐", () => {
    const snapshot = emptyWorkspaceSnapshot();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.currentTask).toBeNull();
    expect(snapshot.resume).toBeNull();
    expect(snapshot.nextUp).toBeNull();
    expect(snapshot.unfinished).toEqual([]);
    expect(snapshot.counts).toEqual(emptyCounts());
    expect(snapshot.nextUpVersion).toBe(0);
  });

  it("每次返回独立对象，避免共享可变状态", () => {
    const first = emptyWorkspaceSnapshot();
    first.counts.todo = 5;
    expect(emptyWorkspaceSnapshot().counts.todo).toBe(0);
  });
});
