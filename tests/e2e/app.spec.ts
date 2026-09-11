import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PickupAPI } from "../../src/shared/contracts";

declare global {
  interface Window {
    pickup: PickupAPI;
  }
}

const EXPECTED_BRIDGE_METHODS = [
  "cancelTask",
  "clearDraft",
  "completeTask",
  "createTask",
  "finishDailyReview",
  "getCommandResult",
  "getDailyReview",
  "getDraft",
  "getPreferences",
  "getTaskDetail",
  "getWorkspaceSnapshot",
  "listTasks",
  "markWaiting",
  "onStateChanged",
  "pauseTask",
  "reopenTask",
  "resolveWaiting",
  "saveBreakpoint",
  "saveDraft",
  "setNextUp",
  "startTask",
  "switchTask",
  "updatePreference",
  "updateTask",
];

function launchEnvironment(directory: string): Record<string, string> {
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

function launch(env: Record<string, string>) {
  return _electron.launch({
    args: process.env.PICKUP_PACKAGED_EXE ? [] : ["."],
    executablePath: process.env.PICKUP_PACKAGED_EXE,
    env,
  });
}

test("secure renderer creates a persisted task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pickup-e2e-"));
  const application = await launch(launchEnvironment(directory));
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("heading", { name: "从记下这一件开始。" }),
    ).toBeVisible();
    await page.getByLabel("标题", { exact: true }).fill("验证真实桌面保存");
    await page.getByRole("button", { name: "保存为待处理" }).click();
    await expect(
      page.getByText("验证真实桌面保存", { exact: true }),
    ).toBeVisible();
    const isolation = await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      bridge: typeof (window as unknown as { pickup: { createTask: unknown } })
        .pickup.createTask,
      keys: Object.keys(window.pickup).length,
    }));
    expect(isolation).toEqual({
      node: "undefined",
      bridge: "function",
      keys: EXPECTED_BRIDGE_METHODS.length,
    });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("桥接的完整业务链路在重启后保持一致", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pickup-e2e-flow-"));
  const env = launchEnvironment(directory);
  const application = await launch(env);
  let flow: Awaited<ReturnType<typeof runFlow>>;
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(
      () => typeof window.pickup?.getWorkspaceSnapshot === "function",
    );
    flow = await page.evaluate(runFlow);
  } finally {
    await application.close();
  }

  try {
    expect(flow.bridgeMethods).toEqual(EXPECTED_BRIDGE_METHODS);
    expect(flow.notesPreserved).toBe("看客户端重试配置");
    expect(flow.firstCreateOk).toBe(true);
    expect(flow.secondCreateOk).toBe(true);
    expect(flow.startStarted).toBe(true);
    expect(flow.switched).toBe(true);
    expect(flow.breakpointSeq).not.toBeNull();
    expect(flow.revisions.length).toBeGreaterThan(3);
    expect(flow.revisions).toEqual([...flow.revisions].sort((a, b) => a - b));

    // 保存并切换后：原任务暂停并保留断点，目标任务成为当前任务
    expect(flow.currentTaskTitle).toBe("处理线上故障");
    expect(flow.pausedTaskTitle).toBe("排查接口超时");
    expect(flow.pausedBreakpoint).toBe("检查下游重试配置");
    expect(flow.doingCount).toBe(1);

    // 完成当前任务后推荐最近暂停的一件；等待任务不参与推荐
    expect(flow.completedWasCurrent).toBe(true);
    expect(flow.afterCompleteCurrentTask).toBeNull();
    expect(flow.afterCompleteResumeTitle).toBe("排查接口超时");
    expect(flow.completedToday).toEqual(["处理线上故障"]);
    expect(flow.waitingExcludedFromResume).toBe(true);

    // 拒绝路径：空标题、过期版本、提交标识复用
    expect(flow.blankTitle).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      retryable: false,
    });
    expect(flow.staleStart).toEqual({
      ok: false,
      code: "STATE_CONFLICT",
      retryable: true,
    });
    expect(flow.reusedCommandId.code).toBe("COMMAND_ID_REUSED");
    expect(flow.reusedCommandId.ok).toBe(false);

    // 草稿与偏好：版本条件写入
    expect(flow.draftTitle).toBe("半截想法");
    expect(flow.draftVersion).toBe(1);
    expect(flow.draftConflict.code).toBe("STATE_CONFLICT");
    expect(flow.clearStaleDraft.code).toBe("STATE_CONFLICT");
    expect(flow.accelerator).toBe("Control+Alt+N");
    expect(flow.widgetPinned).toBe(true);
    expect(flow.preferenceConflict.code).toBe("STATE_CONFLICT");

    // 下次开工选择：只保存引用，不自动开始任务
    expect(flow.nextUpTaskId).toBe(flow.pausedTaskId);
    expect(flow.afterNextUpCurrentTask).toBeNull();
    expect(flow.commandOutcome).toBe("committed");

    // 收尾“保留当前状态”不改变任务
    expect(flow.keepOutcome).toBe("keep");
    expect(flow.keepCurrentTaskUnchanged).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("重启后读取已确认保存的状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pickup-e2e-restart-"));
  const env = launchEnvironment(directory);
  const first = await launch(env);
  let saved: Awaited<ReturnType<typeof runFlow>>;
  try {
    const page = await first.firstWindow();
    await page.waitForFunction(
      () => typeof window.pickup?.getWorkspaceSnapshot === "function",
    );
    saved = await page.evaluate(runFlow);
  } finally {
    await first.close();
  }

  const second = await launch(env);
  try {
    const page = await second.firstWindow();
    await page.waitForFunction(
      () => typeof window.pickup?.getWorkspaceSnapshot === "function",
    );
    const restored = await page.evaluate(async () => {
      const bridge = window.pickup;
      const snapshot = await bridge.getWorkspaceSnapshot();
      const draft = await bridge.getDraft();
      const review = await bridge.getDailyReview();
      const preferences = await bridge.getPreferences();
      if (!snapshot.ok || !draft.ok || !review.ok || !preferences.ok)
        throw new Error("restore failed");
      return {
        currentTask: snapshot.value.currentTask?.title ?? null,
        resumeTitle: snapshot.value.resume?.task.title ?? null,
        resumeBreakpoint:
          snapshot.value.resume?.task.latestBreakpoint?.nextStep ?? null,
        nextUp: snapshot.value.nextUp?.title ?? null,
        counts: snapshot.value.counts,
        unfinishedTitles: snapshot.value.unfinished
          .map((task) => task.title)
          .sort(),
        draftTitle: draft.value.title,
        draftVersion: draft.value.version,
        completedToday: review.value.completedToday.items.map(
          (task) => task.title,
        ),
        widgetPinned: preferences.value.values.widgetPinned,
      };
    });

    expect(restored.currentTask).toBeNull();
    expect(restored.resumeTitle).toBe("排查接口超时");
    expect(restored.resumeBreakpoint).toBe("检查下游重试配置");
    expect(restored.nextUp).toBe("排查接口超时");
    expect(restored.counts).toEqual({
      todo: 0,
      doing: 0,
      paused: 1,
      waiting: 1,
      done: 1,
      cancelled: 0,
      unfinished: 2,
    });
    expect(restored.unfinishedTitles).toEqual(["排查接口超时", "等同事补日志"]);
    expect(restored.draftTitle).toBe("半截想法");
    expect(restored.draftVersion).toBe(1);
    expect(restored.completedToday).toEqual(["处理线上故障"]);
    expect(restored.widgetPinned).toBe(true);
    expect(saved.breakpointSeq).not.toBeNull();
  } finally {
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** 在渲染进程中通过受限桥接执行真实业务链路，只回传可断言的结果。 */
async function runFlow() {
  const bridge = window.pickup;
  const nextId = () => crypto.randomUUID();
  const revisions: number[] = [];
  const unsubscribe = bridge.onStateChanged((revision) =>
    revisions.push(revision),
  );
  const bridgeMethods = Object.keys(bridge).sort();
  const toErrorShape = (
    result: { ok: true } | { ok: false; code: string; retryable: boolean },
  ) =>
    result.ok
      ? { ok: true as const }
      : {
          ok: false as const,
          code: result.code,
          retryable: result.retryable,
        };

  try {
    const createA = nextId();
    const firstCreate = await bridge.createTask({
      commandId: createA,
      title: "  排查接口超时  ",
      note: "看客户端重试配置",
    });
    const secondCreate = await bridge.createTask({
      commandId: nextId(),
      title: "处理线上故障",
      note: "",
    });
    const waitingCreate = await bridge.createTask({
      commandId: nextId(),
      title: "等同事补日志",
      note: "",
    });
    if (!firstCreate.ok || !secondCreate.ok || !waitingCreate.ok)
      throw new Error("create failed");
    const firstTaskId = firstCreate.value.taskId;
    const secondTaskId = secondCreate.value.taskId;
    const waitingTaskId = waitingCreate.value.taskId;

    const snapshotOf = async () => {
      const snapshot = await bridge.getWorkspaceSnapshot();
      if (!snapshot.ok) throw new Error("snapshot failed");
      return snapshot.value;
    };
    const taskOf = async (taskId: string) => {
      const snapshot = await snapshotOf();
      const task = snapshot.unfinished.find((item) => item.id === taskId);
      if (!task) throw new Error("task missing");
      return task;
    };

    const initial = await snapshotOf();
    const notesPreserved = initial.unfinished.find(
      (task) => task.id === firstTaskId,
    )?.note;

    // 空标题：由主进程 schema 拒绝，不进入事务
    const blankTitle = await bridge.createTask({
      commandId: nextId(),
      title: "   ",
      note: "",
    });

    const first = await taskOf(firstTaskId);
    const start = await bridge.startTask({
      commandId: nextId(),
      task: { taskId: first.id, expectedVersion: first.version },
    });
    if (!start.ok) throw new Error("start failed");

    // 过期版本：用旧版本再次开始同一任务
    const staleStart = await bridge.startTask({
      commandId: nextId(),
      task: { taskId: first.id, expectedVersion: first.version },
    });

    const refreshed = await taskOf(firstTaskId);
    const target = await taskOf(secondTaskId);
    const switched = await bridge.switchTask({
      commandId: nextId(),
      from: { taskId: refreshed.id, expectedVersion: refreshed.version },
      to: { taskId: target.id, expectedVersion: target.version },
      breakpoint: {
        progress: "已排除数据库慢查询",
        nextStep: "检查下游重试配置",
        referenceText: "",
      },
    });
    if (!switched.ok) throw new Error("switch failed");

    const afterSwitch = await snapshotOf();
    const paused = afterSwitch.unfinished.find(
      (task) => task.id === firstTaskId,
    );

    // 复用提交标识但内容不同：明确拒绝
    const reusedCommandId = await bridge.createTask({
      commandId: createA,
      title: "复用标识",
      note: "",
    });

    const waiting = await taskOf(waitingTaskId);
    const markWaiting = await bridge.markWaiting({
      commandId: nextId(),
      task: { taskId: waiting.id, expectedVersion: waiting.version },
      reason: "等同事补日志",
    });
    if (!markWaiting.ok) throw new Error("mark waiting failed");

    const current = await taskOf(secondTaskId);
    const completeCommandId = nextId();
    const completed = await bridge.completeTask({
      commandId: completeCommandId,
      task: { taskId: current.id, expectedVersion: current.version },
    });
    if (!completed.ok) throw new Error("complete failed");

    const afterComplete = await snapshotOf();
    const review = await bridge.getDailyReview();
    if (!review.ok) throw new Error("daily review failed");

    // 草稿：版本条件写入与过期拒绝
    const draft = await bridge.saveDraft({
      title: "半截想法",
      note: "",
      expectedDraftVersion: 0,
    });
    if (!draft.ok) throw new Error("draft failed");
    const draftConflict = await bridge.saveDraft({
      title: "过期草稿",
      note: "",
      expectedDraftVersion: 0,
    });
    const clearStaleDraft = await bridge.clearDraft({
      expectedDraftVersion: 0,
    });

    // 偏好：按字段更新并保留其他字段
    const preferences = await bridge.updatePreference({
      patch: { widgetPinned: true },
      expectedVersion: 0,
    });
    if (!preferences.ok) throw new Error("preference failed");
    const preferenceConflict = await bridge.updatePreference({
      patch: { widgetEnabled: false },
      expectedVersion: 0,
    });

    // 下次开工：保存引用但不开始任务
    const nextUpSet = await bridge.setNextUp({
      commandId: nextId(),
      taskId: firstTaskId,
      expectedNextUpVersion: afterComplete.nextUpVersion,
    });
    if (!nextUpSet.ok) throw new Error("set next up failed");
    const afterNextUp = await snapshotOf();
    const commandOutcome = await bridge.getCommandResult({
      commandId: completeCommandId,
    });

    const keepReview = await bridge.finishDailyReview({
      commandId: nextId(),
      outcome: "keep",
      currentTask: null,
    });
    const afterKeep = await snapshotOf();

    return {
      bridgeMethods,
      notesPreserved,
      firstCreateOk: firstCreate.ok,
      secondCreateOk: secondCreate.ok,
      startStarted: start.value.started,
      switched: switched.value.switched,
      breakpointSeq: switched.value.breakpointSeq,
      revisions: revisions.filter((revision) => revision > 0),
      currentTaskTitle: afterSwitch.currentTask?.title ?? null,
      pausedTaskTitle: paused?.title ?? null,
      pausedBreakpoint: paused?.latestBreakpoint?.nextStep ?? null,
      doingCount: afterSwitch.counts.doing,
      completedWasCurrent: completed.value.wasCurrent,
      afterCompleteCurrentTask: afterComplete.currentTask?.title ?? null,
      afterCompleteResumeTitle: afterComplete.resume?.task.title ?? null,
      completedToday: review.value.completedToday.items.map(
        (task) => task.title,
      ),
      waitingExcludedFromResume:
        afterComplete.resume?.task.id !== waitingTaskId,
      blankTitle: toErrorShape(blankTitle),
      staleStart: toErrorShape(staleStart),
      reusedCommandId: toErrorShape(reusedCommandId),
      draftTitle: draft.value.draft.title,
      draftVersion: draft.value.draft.version,
      draftConflict: toErrorShape(draftConflict),
      clearStaleDraft: toErrorShape(clearStaleDraft),
      accelerator: preferences.value.preferences.values.accelerator,
      widgetPinned: preferences.value.preferences.values.widgetPinned,
      preferenceConflict: toErrorShape(preferenceConflict),
      pausedTaskId: firstTaskId,
      nextUpTaskId: afterNextUp.nextUp?.taskId ?? null,
      afterNextUpCurrentTask: afterNextUp.currentTask?.title ?? null,
      commandOutcome: commandOutcome.ok ? commandOutcome.value.status : "error",
      keepOutcome: keepReview.ok ? keepReview.value.outcome : "error",
      keepCurrentTaskUnchanged:
        (afterKeep.currentTask?.title ?? null) ===
        (afterNextUp.currentTask?.title ?? null),
    };
  } finally {
    unsubscribe();
  }
}
