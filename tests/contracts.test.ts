import { describe, expect, it } from "vitest";
import {
  BREAKPOINT_FIELD_MAX_LENGTH,
  DEFAULT_PREFERENCES,
  TITLE_MAX_LENGTH,
  cancelTaskSchema,
  clearDraftSchema,
  createTaskSchema,
  dailyReviewSchema,
  finishDailyReviewSchema,
  getDailyReviewQuerySchema,
  listTasksSchema,
  markWaitingSchema,
  preferencesSchema,
  saveBreakpointSchema,
  saveDraftSchema,
  setNextUpSchema,
  startTaskSchema,
  switchTaskSchema,
  taskDetailSchema,
  updatePreferenceSchema,
  updateTaskSchema,
} from "../src/shared/contracts";

const id = "00000000-0000-4000-8000-000000000001";
const task = { taskId: id, expectedVersion: 1 };

describe("创建输入边界", () => {
  it("拒绝空白标题与多余字段", () => {
    const base = { commandId: id, title: "   ", note: "" };
    expect(createTaskSchema.safeParse(base).success).toBe(false);
    expect(
      createTaskSchema.safeParse({ ...base, title: "task", status: "doing" })
        .success,
    ).toBe(false);
  });

  it("规范化标题并保留备注原文", () => {
    const parsed = createTaskSchema.parse({
      commandId: id,
      title: "  中文事项  ",
      note: "line1\nline2",
    });
    expect(parsed.title).toBe("中文事项");
    expect(parsed.note).toBe("line1\nline2");
  });

  it("要求合法的 commandId 与长度上限", () => {
    expect(
      createTaskSchema.safeParse({
        commandId: "not-a-uuid",
        title: "x",
        note: "",
      }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({
        commandId: id,
        title: "x".repeat(TITLE_MAX_LENGTH + 1),
        note: "",
      }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({
        commandId: id,
        title: "x",
        note: "y".repeat(10_001),
      }).success,
    ).toBe(false);
  });

  it("备注可省略，draftVersion 必须是非负整数", () => {
    expect(
      createTaskSchema.parse({ commandId: id, title: "x", note: "" })
        .draftVersion,
    ).toBeUndefined();
    expect(
      createTaskSchema.safeParse({
        commandId: id,
        title: "x",
        note: "",
        draftVersion: -1,
      }).success,
    ).toBe(false);
  });
});

describe("命令输入边界", () => {
  it("任务引用必须带 expectedVersion", () => {
    expect(
      startTaskSchema.safeParse({ commandId: id, task: { taskId: id } })
        .success,
    ).toBe(false);
    expect(
      startTaskSchema.safeParse({
        commandId: id,
        task: { taskId: id, expectedVersion: 0 },
      }).success,
    ).toBe(false);
    expect(startTaskSchema.safeParse({ commandId: id, task }).success).toBe(
      true,
    );
  });

  it("切换允许相同来源与目标、允许省略断点", () => {
    const parsed = switchTaskSchema.parse({
      commandId: id,
      from: task,
      to: task,
    });
    expect(parsed.breakpoint).toBeUndefined();
    expect(
      switchTaskSchema.safeParse({ commandId: id, from: task, to: task })
        .success,
    ).toBe(true);
  });

  it("断点字段有长度上限且必须是字符串", () => {
    expect(
      saveBreakpointSchema.safeParse({
        commandId: id,
        task,
        breakpoint: { progress: "a", nextStep: "b", referenceText: "c" },
      }).success,
    ).toBe(true);
    expect(
      saveBreakpointSchema.safeParse({
        commandId: id,
        task,
        breakpoint: {
          progress: "a",
          nextStep: "b",
          referenceText: "c".repeat(BREAKPOINT_FIELD_MAX_LENGTH + 1),
        },
      }).success,
    ).toBe(false);
  });

  it("编辑任务允许省略备注", () => {
    const parsed = updateTaskSchema.parse({
      commandId: id,
      taskId: id,
      expectedVersion: 2,
      title: "改名",
    });
    expect(parsed.note).toBeUndefined();
  });

  it("等待、完成、取消、重新打开的输入形状受控", () => {
    expect(
      markWaitingSchema.parse({ commandId: id, task, reason: "" }).reason,
    ).toBe("");
    expect(completeLike(cancelTaskSchema)).toBe(true);
    expect(
      finishDailyReviewSchema.safeParse({
        commandId: id,
        outcome: "restart",
        currentTask: null,
      }).success,
    ).toBe(false);
    expect(
      finishDailyReviewSchema.parse({
        commandId: id,
        outcome: "keep",
        currentTask: null,
      }).currentTask,
    ).toBeNull();
  });

  it("下次开工允许清空，但版本检查是必填", () => {
    expect(
      setNextUpSchema.safeParse({
        commandId: id,
        taskId: null,
        expectedNextUpVersion: 0,
      }).success,
    ).toBe(true);
    expect(
      setNextUpSchema.safeParse({ commandId: id, taskId: null }).success,
    ).toBe(false);
  });
});

describe("查询输入边界", () => {
  it("分页参数有明确范围与默认值", () => {
    const parsed = listTasksSchema.parse({ statuses: ["todo"] });
    expect(parsed.offset).toBe(0);
    expect(parsed.limit).toBe(50);
    expect(
      listTasksSchema.safeParse({ statuses: ["todo"], offset: 0, limit: 101 })
        .success,
    ).toBe(false);
    expect(
      listTasksSchema.safeParse({ statuses: ["todo"], offset: -1, limit: 50 })
        .success,
    ).toBe(false);
    expect(listTasksSchema.safeParse({ statuses: [] }).success).toBe(false);
    expect(
      listTasksSchema.safeParse({ statuses: ["doing", "paused"] }).success,
    ).toBe(true);
  });

  it("详情分页有默认值", () => {
    const parsed = taskDetailSchema.parse({ taskId: id });
    expect(parsed.breakpointLimit).toBe(10);
    expect(parsed.transitionLimit).toBe(20);
  });

  it("收尾查询的本地日期区间必须显式且格式正确", () => {
    expect(
      dailyReviewSchema.safeParse({
        dayKey: "2026-9-1",
        startUtc: 0,
        endUtc: 1,
        completedLimit: 100,
      }).success,
    ).toBe(false);
    const parsed = dailyReviewSchema.safeParse({
      dayKey: "2026-09-01",
      startUtc: 0,
      endUtc: 1,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.completedLimit).toBe(100);
  });

  it("收尾分页不能指定日期，只接受完成清单偏移", () => {
    const parsed = getDailyReviewQuerySchema.parse({});
    expect(parsed.completedOffset).toBe(0);
    expect(parsed.completedLimit).toBe(50);
    expect(
      getDailyReviewQuerySchema.safeParse({
        completedOffset: 50,
        dayKey: "2026-09-12",
      }).success,
    ).toBe(false);
  });
});

describe("草稿与偏好边界", () => {
  it("草稿保存需要版本，清空也需要版本", () => {
    expect(
      saveDraftSchema.safeParse({
        title: "a",
        note: "",
        expectedDraftVersion: 0,
      }).success,
    ).toBe(true);
    expect(saveDraftSchema.safeParse({ title: "a", note: "" }).success).toBe(
      false,
    );
    expect(
      clearDraftSchema.safeParse({ expectedDraftVersion: 0 }).success,
    ).toBe(true);
  });

  it("偏好补丁至少一个字段且拒绝未知字段", () => {
    expect(
      updatePreferenceSchema.safeParse({ patch: {}, expectedVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      updatePreferenceSchema.safeParse({
        patch: { unknownField: true },
        expectedVersion: 0,
      }).success,
    ).toBe(false);
    expect(
      updatePreferenceSchema.safeParse({
        patch: { widgetPinned: true },
        expectedVersion: 0,
      }).success,
    ).toBe(true);
  });

  it("默认偏好符合架构约定", () => {
    expect(preferencesSchema.parse(DEFAULT_PREFERENCES)).toEqual({
      widgetEnabled: true,
      widgetPinned: false,
      widgetCollapsed: false,
      widgetBounds: null,
      launchAtLogin: false,
      accelerator: "Control+Alt+N",
    });
    expect(
      preferencesSchema.safeParse({
        ...DEFAULT_PREFERENCES,
        widgetBounds: { x: 0, y: 0, width: 10, height: 10 },
      }).success,
    ).toBe(false);
  });
});

function completeLike(schema: typeof cancelTaskSchema): boolean {
  return schema.safeParse({ commandId: id, task }).success;
}
