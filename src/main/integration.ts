import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppErrorCode,
  CommandOutcome,
  CreateTaskInput,
  CreateTaskValue,
  Draft,
  MarkWaitingValue,
  PauseTaskValue,
  SaveBreakpointValue,
  SwitchTaskValue,
  TaskDetail,
  TaskSummary,
  WorkspaceSnapshot,
} from "../shared/contracts";
import { localDayRangeUtc } from "../shared/local-date";
import type {
  WorkerFaultStage,
  WorkerRequest,
} from "../shared/worker-protocol";
import { StoreClient } from "./worker-client";

/* ------------------------------------------------------------------ 工具 */

let observedSqliteVersion = "";

const HOUR = 60 * 60 * 1000;

function commandId(): string {
  return randomUUID();
}

async function open(
  file: string,
  faults?: WorkerFaultStage[],
): Promise<StoreClient> {
  const client = new StoreClient(file, faults ? { faults } : {});
  await client.ready;
  observedSqliteVersion = client.sqliteVersion;
  return client;
}

async function must<T>(
  client: StoreClient,
  request: WorkerRequest,
): Promise<{ value: T; revision: number }> {
  const result = await client.send<T>(request);
  assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return { value: result.value, revision: result.revision };
}

async function expectError(
  client: StoreClient,
  request: WorkerRequest,
  code: AppErrorCode,
) {
  const result = await client.send(request);
  assert(!result.ok, `expected failure, got ${JSON.stringify(result)}`);
  assert.equal(result.code, code, `unexpected error code for ${request.kind}`);
  return result;
}

async function createTask(
  client: StoreClient,
  title: string,
  note = "",
): Promise<string> {
  const { value } = await must<CreateTaskValue>(client, {
    kind: "createTask",
    input: { commandId: commandId(), title, note },
  });
  return value.taskId;
}

async function snapshot(client: StoreClient): Promise<WorkspaceSnapshot> {
  return (
    await must<WorkspaceSnapshot>(client, { kind: "getWorkspaceSnapshot" })
  ).value;
}

async function taskOf(
  client: StoreClient,
  taskId: string,
): Promise<TaskSummary> {
  return (await detailOf(client, taskId)).task;
}

async function detailOf(
  client: StoreClient,
  taskId: string,
): Promise<TaskDetail> {
  const { value } = await must<TaskDetail>(client, {
    kind: "getTaskDetail",
    input: {
      taskId,
      breakpointOffset: 0,
      breakpointLimit: 10,
      transitionOffset: 0,
      transitionLimit: 50,
    },
  });
  return value;
}

async function startTask(client: StoreClient, task: TaskSummary) {
  return client.send({
    kind: "startTask",
    input: { commandId: commandId(), task: ref(task) },
  });
}

async function currentTaskOf(
  client: StoreClient,
  taskId: string,
): Promise<TaskSummary> {
  return taskOf(client, taskId);
}

function ref(task: TaskSummary) {
  return { taskId: task.id, expectedVersion: task.version };
}

function compareCreatedAt(a: TaskSummary, b: TaskSummary): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function compareRecentFirst(
  a: TaskSummary,
  b: TaskSummary,
  timeOf: (task: TaskSummary) => number,
): number {
  return (
    timeOf(b) - timeOf(a) ||
    b.statusRevision - a.statusRevision ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** 有界等待：超时即失败，避免待验证行为缺失时测试自身挂起。 */
async function withDeadline<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout while waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 通过合法命令把新任务推进到指定状态，用于“命令 × 六种状态”行为验证。 */
async function taskInStatus(
  client: StoreClient,
  title: string,
  status: "todo" | "doing" | "paused" | "waiting" | "done" | "cancelled",
): Promise<string> {
  const taskId = await createTask(client, title);
  if (status === "todo") return taskId;
  if (status === "waiting") {
    await must(client, {
      kind: "markWaiting",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskId)),
        reason: "等外部条件",
      },
    });
    return taskId;
  }
  if (status === "done" || status === "cancelled") {
    await must(client, {
      kind: status === "done" ? "completeTask" : "cancelTask",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskId)),
      },
    });
    return taskId;
  }
  const started = await startTask(client, await taskOf(client, taskId));
  assert(started.ok, `start failed: ${JSON.stringify(started)}`);
  if (status === "paused") await pauseTask(client, taskId);
  return taskId;
}

async function pauseTask(client: StoreClient, taskId: string) {
  return must<PauseTaskValue>(client, {
    kind: "pauseTask",
    input: { commandId: commandId(), task: ref(await taskOf(client, taskId)) },
  });
}

/* ----------------------------------------------------------------- 场景 */

async function basicAndIdempotency(dir: string): Promise<void> {
  const client = await open(join(dir, "basic.sqlite"));
  try {
    const initial = await snapshot(client);
    assert.equal(initial.revision, 0);
    assert.equal(initial.unfinished.length, 0);
    assert.equal(initial.currentTask, null);
    assert.equal(initial.resume, null);
    assert.equal(initial.nextUp, null);
    assert.deepEqual(initial.counts, {
      todo: 0,
      doing: 0,
      paused: 0,
      waiting: 0,
      done: 0,
      cancelled: 0,
      unfinished: 0,
    });

    const id = commandId();
    const input: CreateTaskInput = {
      commandId: id,
      title: "  排查接口超时  ",
      note: "  保留空白的备注  ",
    };
    const created = await must<CreateTaskValue>(client, {
      kind: "createTask",
      input,
    });
    assert.equal(created.revision, 1);
    assert.equal(created.value.draftCleared, false);

    const replays = await Promise.all(
      Array.from({ length: 100 }, () =>
        client.send<CreateTaskValue>({ kind: "createTask", input }),
      ),
    );
    for (const replay of replays) {
      assert(replay.ok);
      assert.equal(replay.revision, 1);
      assert.equal(replay.value.taskId, created.value.taskId);
    }

    const afterReplay = await snapshot(client);
    assert.equal(afterReplay.unfinished.length, 1);
    assert.equal(afterReplay.unfinished[0].title, "排查接口超时");
    assert.equal(afterReplay.unfinished[0].note, "  保留空白的备注  ");
    assert.equal(afterReplay.counts.todo, 1);
    assert.equal(afterReplay.counts.unfinished, 1);

    await expectError(
      client,
      { kind: "createTask", input: { ...input, title: "另一件事" } },
      "COMMAND_ID_REUSED",
    );
    await expectError(
      client,
      {
        kind: "getTaskDetail",
        input: {
          taskId: randomUUID(),
          breakpointOffset: 0,
          breakpointLimit: 10,
          transitionOffset: 0,
          transitionLimit: 10,
        },
      },
      "NOT_FOUND",
    );

    const second = await must<CreateTaskValue>(client, {
      kind: "createTask",
      input: { commandId: commandId(), title: "排查接口超时", note: "" },
    });
    assert.notEqual(second.value.taskId, created.value.taskId);
    assert.equal((await snapshot(client)).unfinished.length, 2);

    await expectError(
      client,
      {
        kind: "createTask",
        input: { commandId: commandId(), title: "   ", note: "" },
      },
      "VALIDATION_ERROR",
    );

    const unknown = await must<CommandOutcome>(client, {
      kind: "getCommandResult",
      input: { commandId: commandId() },
    });
    assert.equal(unknown.value.status, "unknown");
    const committed = await must<CommandOutcome>(client, {
      kind: "getCommandResult",
      input: { commandId: id },
    });
    assert(committed.value.status === "committed");
    assert.equal(committed.value.revision, 1);
    assert.equal(committed.value.value.type, "createTask");
  } finally {
    await client.close();
  }
}

async function statusTransitions(dir: string): Promise<void> {
  const client = await open(join(dir, "states.sqlite"));
  try {
    const taskA = await createTask(client, "A 排查接口超时");
    const taskB = await createTask(client, "B 查询昨日订单");
    const taskC = await createTask(client, "C 处理线上故障");
    let state = await snapshot(client);
    assert.equal(state.counts.todo, 3);

    const started = await must<{ started: boolean }>(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    assert.equal(started.value.started, true);
    state = await snapshot(client);
    assert.equal(state.currentTask?.id, taskA);
    assert.equal(state.counts.doing, 1);

    // 已有当前任务：开始另一件必须走切换流程
    await expectError(
      client,
      {
        kind: "startTask",
        input: {
          commandId: commandId(),
          task: ref(await taskOf(client, taskB)),
        },
      },
      "NEED_SWITCH",
    );

    // 自我开始：不产生重复开始，也不改变状态进入时间
    const beforeSelfStart = await currentTaskOf(client, taskA);
    const selfStart = await must<{ started: boolean }>(client, {
      kind: "startTask",
      input: {
        commandId: commandId(),
        task: ref(beforeSelfStart),
      },
    });
    assert.equal(selfStart.value.started, false);
    const afterSelfStart = await currentTaskOf(client, taskA);
    assert.equal(afterSelfStart.status, "doing");
    assert.equal(afterSelfStart.version, beforeSelfStart.version);
    assert.equal(
      afterSelfStart.statusChangedAt,
      beforeSelfStart.statusChangedAt,
    );
    assert.equal(afterSelfStart.statusRevision, beforeSelfStart.statusRevision);

    // 自我切换：不暂停当前任务，也不追加断点
    const selfSwitch = await must<SwitchTaskValue>(client, {
      kind: "switchTask",
      input: {
        commandId: commandId(),
        from: ref(await currentTaskOf(client, taskA)),
        to: ref(await currentTaskOf(client, taskA)),
        breakpoint: { progress: "不应写入", nextStep: "", referenceText: "" },
      },
    });
    assert.equal(selfSwitch.value.switched, false);
    assert.equal(selfSwitch.value.breakpointSeq, null);
    assert.equal((await currentTaskOf(client, taskA)).breakpointCount, 0);
    assert.equal((await currentTaskOf(client, taskA)).status, "doing");

    // 非法转换：暂停非当前任务、把非等待任务放回待处理
    await expectError(
      client,
      {
        kind: "pauseTask",
        input: {
          commandId: commandId(),
          task: ref(await taskOf(client, taskB)),
        },
      },
      "STATE_CONFLICT",
    );
    await expectError(
      client,
      {
        kind: "resolveWaiting",
        input: {
          commandId: commandId(),
          task: ref(await taskOf(client, taskA)),
        },
      },
      "STATE_CONFLICT",
    );

    // 暂停当前任务：允许不选择下一件
    const paused = await must<PauseTaskValue>(client, {
      kind: "pauseTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    assert.equal(paused.value.breakpointSeq, null);
    state = await snapshot(client);
    assert.equal(state.currentTask, null);
    assert.equal(state.resume?.task.id, taskA);
    assert.equal(state.resume?.task.status, "paused");

    await expectError(
      client,
      {
        kind: "pauseTask",
        input: {
          commandId: commandId(),
          task: ref(await taskOf(client, taskA)),
        },
      },
      "STATE_CONFLICT",
    );

    // 标记等待 → 条件满足回到待处理
    const waiting = await must<MarkWaitingValue>(client, {
      kind: "markWaiting",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskA)),
        reason: "等同事反馈日志",
      },
    });
    assert.equal(waiting.value.reasonUpdated, true);
    state = await snapshot(client);
    assert.equal(state.counts.waiting, 1);
    assert.equal((await taskOf(client, taskA)).waitReason, "等同事反馈日志");
    // 等待任务不进入默认恢复推荐
    assert.equal(state.resume, null);

    // 等待中重复标记：理由相同时不产生变更
    const sameReason = await must<{ reasonUpdated: boolean }>(client, {
      kind: "markWaiting",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskA)),
        reason: "等同事反馈日志",
      },
    });
    assert.equal(sameReason.value.reasonUpdated, false);
    assert.equal((await snapshot(client)).revision, state.revision);

    const resolved = await must<{ taskId: string }>(client, {
      kind: "resolveWaiting",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    assert.equal(resolved.value.taskId, taskA);
    const resolvedTask = await taskOf(client, taskA);
    assert.equal(resolvedTask.status, "todo");
    assert.equal(resolvedTask.waitReason, "等同事反馈日志");

    // 已结束状态下的非法命令
    const completed = await must<{ wasCurrent: boolean }>(client, {
      kind: "completeTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    assert.equal(completed.value.wasCurrent, false);
    const doneTask = await taskOf(client, taskA);
    assert.equal(doneTask.status, "done");
    assert.notEqual(doneTask.endedAt, null);
    await expectError(
      client,
      {
        kind: "updateTask",
        input: {
          commandId: commandId(),
          taskId: taskA,
          expectedVersion: doneTask.version,
          title: "改名",
        },
      },
      "STATE_CONFLICT",
    );
    await expectError(
      client,
      {
        kind: "saveBreakpoint",
        input: {
          commandId: commandId(),
          task: ref(doneTask),
          breakpoint: { progress: "x", nextStep: "", referenceText: "" },
        },
      },
      "STATE_CONFLICT",
    );
    await expectError(
      client,
      {
        kind: "markWaiting",
        input: { commandId: commandId(), task: ref(doneTask), reason: "" },
      },
      "STATE_CONFLICT",
    );
    await expectError(
      client,
      {
        kind: "startTask",
        input: { commandId: commandId(), task: ref(doneTask) },
      },
      "STATE_CONFLICT",
    );

    // 重新打开：回到待处理，保留历史，不抢占当前任务
    await must(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskB)) },
    });
    await must(client, {
      kind: "reopenTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    const reopened = await taskOf(client, taskA);
    assert.equal(reopened.status, "todo");
    assert.equal(reopened.endedAt, null);
    assert.equal((await snapshot(client)).currentTask?.id, taskB);
    await expectError(
      client,
      {
        kind: "reopenTask",
        input: { commandId: commandId(), task: ref(reopened) },
      },
      "STATE_CONFLICT",
    );

    // 取消与完成分别统计
    await must(client, {
      kind: "cancelTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskC)) },
    });
    state = await snapshot(client);
    assert.equal(state.counts.cancelled, 1);
    // A 完成后被重新打开，因此不再计入已完成
    assert.equal(state.counts.done, 0);
    assert.equal(state.counts.todo, 1);
    assert.equal(state.counts.doing, 1);
    assert.equal(state.counts.unfinished, 2);
    assert.notEqual((await taskOf(client, taskC)).endedAt, null);

    // 状态历史保留创建与全部转换，最新在前
    const detail = await must<TaskDetail>(client, {
      kind: "getTaskDetail",
      input: {
        taskId: taskA,
        breakpointOffset: 0,
        breakpointLimit: 10,
        transitionOffset: 0,
        transitionLimit: 50,
      },
    });
    assert.deepEqual(
      detail.value.transitions.items.map((item) => item.toStatus),
      ["todo", "done", "todo", "waiting", "paused", "doing", "todo"],
    );
    assert.equal(detail.value.transitions.total, 7);
    assert.equal(detail.value.transitions.hasMore, false);
  } finally {
    await client.close();
  }
}

async function switchRollback(dir: string): Promise<void> {
  const stages: WorkerFaultStage[] = [
    "switch.afterBreakpoint",
    "switch.afterPause",
    "switch.afterStart",
    "switch.beforeReceipt",
  ];
  for (const stage of stages) {
    const client = await open(join(dir, `switch-${stage}.sqlite`), [stage]);
    try {
      const taskA = await createTask(client, "A 排查接口超时");
      const taskB = await createTask(client, "B 处理线上故障");
      await must(client, {
        kind: "startTask",
        input: {
          commandId: commandId(),
          task: ref(await taskOf(client, taskA)),
        },
      });
      const before = await snapshot(client);
      const beforeA = await taskOf(client, taskA);
      const beforeB = await taskOf(client, taskB);
      const id = commandId();
      const input = {
        commandId: id,
        from: ref(beforeA),
        to: ref(beforeB),
        breakpoint: {
          progress: "已排除数据库慢查询",
          nextStep: "检查下游重试配置",
          referenceText: "",
        },
      };
      const failure = await client.send({ kind: "switchTask", input });
      assert(!failure.ok, `fault ${stage} must fail`);
      assert.equal(failure.code, "STORAGE_ERROR");

      const afterA = await taskOf(client, taskA);
      const afterB = await taskOf(client, taskB);
      assert.equal((await snapshot(client)).revision, before.revision, stage);
      assert.equal(afterA.status, "doing", `${stage}: from status`);
      assert.equal(afterB.status, "todo", `${stage}: to status`);
      assert.equal(afterA.breakpointCount, 0, `${stage}: breakpoint`);
      assert.equal(afterA.version, beforeA.version, `${stage}: from version`);
      assert.equal(afterB.version, beforeB.version, `${stage}: to version`);
      assert.equal(afterA.statusChangedAt, beforeA.statusChangedAt, stage);
      assert.equal((await snapshot(client)).counts.doing, 1, stage);

      const outcome = await must<CommandOutcome>(client, {
        kind: "getCommandResult",
        input: { commandId: id },
      });
      assert.equal(outcome.value.status, "unknown", `${stage}: no receipt`);

      // 原请求重试：同一 commandId 与同一规范化 payload 必须成功
      const retried = await must<SwitchTaskValue>(client, {
        kind: "switchTask",
        input,
      });
      assert.equal(retried.value.switched, true);
      assert.notEqual(retried.value.breakpointSeq, null);
      const committed = await snapshot(client);
      assert.equal(committed.revision, before.revision + 1);
      assert.equal((await taskOf(client, taskA)).status, "paused");
      assert.equal((await taskOf(client, taskB)).status, "doing");
      assert.equal((await taskOf(client, taskA)).breakpointCount, 1);
      assert.equal(
        (await taskOf(client, taskA)).statusRevision,
        committed.revision,
      );

      // 重复已提交命令：返回原结果，不重复追加断点
      const replay = await must<SwitchTaskValue>(client, {
        kind: "switchTask",
        input,
      });
      assert.equal(replay.revision, retried.revision);
      assert.equal(replay.value.breakpointSeq, retried.value.breakpointSeq);
      assert.equal((await taskOf(client, taskA)).breakpointCount, 1);
      assert.equal((await snapshot(client)).revision, committed.revision);
    } finally {
      await client.close();
    }
  }

  // 暂停命令同样整笔回滚
  const client = await open(join(dir, "pause-rollback.sqlite"), [
    "pause.afterUpdate",
  ]);
  try {
    const taskA = await createTask(client, "A 暂停回滚");
    await must(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    const before = await snapshot(client);
    const beforeA = await taskOf(client, taskA);
    const failed = await client.send({
      kind: "pauseTask",
      input: {
        commandId: commandId(),
        task: ref(beforeA),
        breakpoint: {
          progress: "",
          nextStep: "检查重试配置",
          referenceText: "",
        },
      },
    });
    assert(!failed.ok);
    assert.equal((await snapshot(client)).revision, before.revision);
    const afterA = await taskOf(client, taskA);
    assert.equal(afterA.status, "doing");
    assert.equal(afterA.breakpointCount, 0);
    assert.equal(afterA.version, beforeA.version);
  } finally {
    await client.close();
  }
}

async function commitLossAndRestart(dir: string): Promise<void> {
  const file = join(dir, "restart.sqlite");
  let taskA = "";
  let taskB = "";
  const id = commandId();
  let input = {
    commandId: id,
    from: { taskId: "", expectedVersion: 1 },
    to: { taskId: "", expectedVersion: 1 },
    breakpoint: {
      progress: "",
      nextStep: "继续检查重试配置",
      referenceText: "",
    },
  };
  let committedRevision = 0;

  const first = await open(file);
  try {
    taskA = await createTask(first, "A 备份恢复", "跨重启保持一致");
    taskB = await createTask(first, "B 故障处理");
    await must(first, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(first, taskA)) },
    });
    input = {
      ...input,
      from: ref(await taskOf(first, taskA)),
      to: ref(await taskOf(first, taskB)),
    };
    const switched = await must<SwitchTaskValue>(first, {
      kind: "switchTask",
      input,
    });
    committedRevision = switched.revision;
  } finally {
    await first.close();
  }

  // 模拟“提交成功但响应丢失”：worker 进程结束后用同一 commandId 原样重试
  const second = await open(file);
  try {
    assert.equal(second.sqliteVersion.length > 0, true);
    const replay = await must<SwitchTaskValue>(second, {
      kind: "switchTask",
      input,
    });
    assert.equal(replay.revision, committedRevision);
    assert.equal(replay.value.switched, true);
    const state = await snapshot(second);
    assert.equal(state.revision, committedRevision);
    assert.equal((await taskOf(second, taskA)).status, "paused");
    assert.equal((await taskOf(second, taskA)).breakpointCount, 1);
    assert.equal((await taskOf(second, taskB)).status, "doing");
    assert.equal(state.currentTask?.id, taskB);

    const outcome = await must<CommandOutcome>(second, {
      kind: "getCommandResult",
      input: { commandId: id },
    });
    assert.equal(outcome.value.status, "committed");
  } finally {
    await second.close();
  }

  const afterClose = await second.send({ kind: "getWorkspaceSnapshot" });
  assert(!afterClose.ok);
  assert.equal(afterClose.code, "DB_UNAVAILABLE");
}

async function concurrencyAndVersions(dir: string): Promise<void> {
  const client = await open(join(dir, "race.sqlite"));
  try {
    const taskA = await createTask(client, "A 排查接口超时");
    const taskB = await createTask(client, "B 处理线上故障");
    const staleA = await taskOf(client, taskA);

    // 两窗口同时开始同一件任务：只有一个提交成功
    const results = await Promise.all([
      startTask(client, staleA),
      startTask(client, staleA),
    ]);
    const succeeded = results.filter((result) => result.ok);
    const conflicted = results.filter((result) => !result.ok);
    assert.equal(succeeded.length, 1);
    assert.equal(conflicted.length, 1);
    const conflict = conflicted[0];
    assert(!conflict.ok);
    assert.equal(conflict.code, "STATE_CONFLICT");
    assert.equal((await snapshot(client)).counts.doing, 1);

    await expectError(
      client,
      {
        kind: "startTask",
        input: {
          commandId: commandId(),
          task: ref(await taskOf(client, taskB)),
        },
      },
      "NEED_SWITCH",
    );

    // 过期版本的切换：整体拒绝且不留下部分修改
    const currentA = await taskOf(client, taskA);
    const before = await snapshot(client);
    await expectError(
      client,
      {
        kind: "switchTask",
        input: {
          commandId: commandId(),
          from: { taskId: currentA.id, expectedVersion: currentA.version - 1 },
          to: ref(await taskOf(client, taskB)),
        },
      },
      "STATE_CONFLICT",
    );
    assert.equal((await snapshot(client)).revision, before.revision);
    assert.equal((await taskOf(client, taskA)).status, "doing");
    assert.equal((await taskOf(client, taskB)).status, "todo");

    // 目标版本过期同样拒绝
    await expectError(
      client,
      {
        kind: "switchTask",
        input: {
          commandId: commandId(),
          from: ref(await taskOf(client, taskA)),
          to: { taskId: taskB, expectedVersion: 99 },
        },
      },
      "STATE_CONFLICT",
    );

    const switched = await must<SwitchTaskValue>(client, {
      kind: "switchTask",
      input: {
        commandId: commandId(),
        from: ref(await taskOf(client, taskA)),
        to: ref(await taskOf(client, taskB)),
      },
    });
    assert.equal(switched.value.switched, true);
    const state = await snapshot(client);
    assert.equal(state.counts.doing, 1);
    assert.equal(state.currentTask?.id, taskB);
    assert.equal(state.resume?.task.id, taskA);
  } finally {
    await client.close();
  }
}

async function nextUpAndEndStates(dir: string): Promise<void> {
  const client = await open(join(dir, "nextup.sqlite"));
  try {
    const taskA = await createTask(client, "A 排查接口超时");
    const taskB = await createTask(client, "B 查询昨日订单");
    const taskC = await createTask(client, "C 处理线上故障");

    const set = await must<{ changed: boolean }>(client, {
      kind: "setNextUp",
      input: {
        commandId: commandId(),
        taskId: taskB,
        expectedNextUpVersion: 0,
      },
    });
    assert.equal(set.value.changed, true);
    let state = await snapshot(client);
    assert.equal(state.nextUp?.taskId, taskB);
    assert.equal(state.nextUpVersion, 1);
    assert.equal(state.currentTask, null);

    const same = await must<{ changed: boolean }>(client, {
      kind: "setNextUp",
      input: {
        commandId: commandId(),
        taskId: taskB,
        expectedNextUpVersion: 1,
      },
    });
    assert.equal(same.value.changed, false);
    assert.equal((await snapshot(client)).nextUpVersion, 1);

    await expectError(
      client,
      {
        kind: "setNextUp",
        input: {
          commandId: commandId(),
          taskId: taskC,
          expectedNextUpVersion: 0,
        },
      },
      "STATE_CONFLICT",
    );

    await must(client, {
      kind: "setNextUp",
      input: {
        commandId: commandId(),
        taskId: taskC,
        expectedNextUpVersion: 1,
      },
    });
    state = await snapshot(client);
    assert.equal(state.nextUp?.taskId, taskC);
    assert.equal(state.nextUpVersion, 2);

    // 完成命中的下次开工事项：同一事务清除引用
    const completed = await must<{
      nextUpCleared: boolean;
      wasCurrent: boolean;
    }>(client, {
      kind: "completeTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskC)) },
    });
    assert.equal(completed.value.nextUpCleared, true);
    assert.equal(completed.value.wasCurrent, false);
    state = await snapshot(client);
    assert.equal(state.nextUp, null);
    assert.equal(state.nextUpVersion, 3);
    await expectError(
      client,
      {
        kind: "setNextUp",
        input: {
          commandId: commandId(),
          taskId: taskC,
          expectedNextUpVersion: 3,
        },
      },
      "STATE_CONFLICT",
    );

    // 取消命中项同样清除引用，重新打开后不自动恢复
    await must(client, {
      kind: "setNextUp",
      input: {
        commandId: commandId(),
        taskId: taskA,
        expectedNextUpVersion: 3,
      },
    });
    await must(client, {
      kind: "cancelTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    state = await snapshot(client);
    assert.equal(state.nextUp, null);
    await must(client, {
      kind: "reopenTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    assert.equal((await snapshot(client)).nextUp, null);
    assert.equal((await taskOf(client, taskA)).status, "todo");

    // 重新打开不抢占当前任务
    await must(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskB)) },
    });
    await must(client, {
      kind: "completeTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    await must(client, {
      kind: "reopenTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    state = await snapshot(client);
    assert.equal(state.currentTask?.id, taskB);
    assert.equal(state.counts.doing, 1);
  } finally {
    await client.close();
  }
}

async function drafts(dir: string): Promise<void> {
  const client = await open(join(dir, "drafts.sqlite"));
  try {
    const empty = await must<Draft>(client, { kind: "getDraft" });
    assert.deepEqual(empty.value, { title: "", note: "", version: 0 });

    const saved = await must<{ draft: Draft }>(client, {
      kind: "saveDraft",
      input: { title: "记住的事", note: "备注", expectedDraftVersion: 0 },
    });
    assert.equal(saved.value.draft.version, 1);

    await expectError(
      client,
      {
        kind: "saveDraft",
        input: { title: "过期覆盖", note: "", expectedDraftVersion: 0 },
      },
      "STATE_CONFLICT",
    );
    assert.equal(
      (await must<Draft>(client, { kind: "getDraft" })).value.title,
      "记住的事",
    );

    const noop = await must<{ draft: Draft }>(client, {
      kind: "saveDraft",
      input: { title: "记住的事", note: "备注", expectedDraftVersion: 1 },
    });
    assert.equal(noop.value.draft.version, 1);

    await must(client, {
      kind: "saveDraft",
      input: { title: "第二次编辑", note: "", expectedDraftVersion: 1 },
    });

    // createTask 按 draftVersion 清理已提交的草稿
    const cleared = await must<CreateTaskValue>(client, {
      kind: "createTask",
      input: {
        commandId: commandId(),
        title: "写入后清空草稿",
        note: "",
        draftVersion: 2,
      },
    });
    assert.equal(cleared.value.draftCleared, true);
    assert.deepEqual((await must<Draft>(client, { kind: "getDraft" })).value, {
      title: "",
      note: "",
      version: 3,
    });

    // 草稿已被更新时，旧提交不清空新输入
    await must(client, {
      kind: "saveDraft",
      input: { title: "新输入", note: "", expectedDraftVersion: 3 },
    });
    const stale = await must<CreateTaskValue>(client, {
      kind: "createTask",
      input: {
        commandId: commandId(),
        title: "不应清空新草稿",
        note: "",
        draftVersion: 3,
      },
    });
    assert.equal(stale.value.draftCleared, false);
    const preserved = await must<Draft>(client, { kind: "getDraft" });
    assert.equal(preserved.value.title, "新输入");
    assert.equal(preserved.value.version, 4);

    await expectError(
      client,
      { kind: "clearDraft", input: { expectedDraftVersion: 3 } },
      "STATE_CONFLICT",
    );
    const clearedDraft = await must<{ draft: Draft }>(client, {
      kind: "clearDraft",
      input: { expectedDraftVersion: 4 },
    });
    assert.deepEqual(clearedDraft.value.draft, {
      title: "",
      note: "",
      version: 5,
    });
    const clearedAgain = await must<{ draft: Draft }>(client, {
      kind: "clearDraft",
      input: { expectedDraftVersion: 5 },
    });
    assert.equal(clearedAgain.value.draft.version, 5);
  } finally {
    await client.close();
  }
}

async function preferences(dir: string): Promise<void> {
  const file = join(dir, "prefs.sqlite");
  const client = await open(file);
  try {
    const initial = await must<{
      values: Record<string, unknown>;
      version: number;
    }>(client, { kind: "getPreferences" });
    assert.deepEqual(initial.value.values, {
      widgetEnabled: true,
      widgetPinned: false,
      widgetCollapsed: false,
      widgetBounds: null,
      launchAtLogin: false,
      accelerator: "Control+Alt+N",
    });
    assert.equal(initial.value.version, 0);

    const pinned = await must<{
      preferences: {
        values: { widgetPinned: boolean; accelerator: string };
        version: number;
      };
    }>(client, {
      kind: "updatePreference",
      input: { patch: { widgetPinned: true }, expectedVersion: 0 },
    });
    assert.equal(pinned.value.preferences.values.widgetPinned, true);
    assert.equal(pinned.value.preferences.values.accelerator, "Control+Alt+N");
    assert.equal(pinned.value.preferences.version, 1);

    // 字段值未变化时不递增版本
    const unchanged = await must<{ preferences: { version: number } }>(client, {
      kind: "updatePreference",
      input: { patch: { widgetPinned: true }, expectedVersion: 1 },
    });
    assert.equal(unchanged.value.preferences.version, 1);

    await expectError(
      client,
      {
        kind: "updatePreference",
        input: { patch: { widgetEnabled: false }, expectedVersion: 0 },
      },
      "STATE_CONFLICT",
    );
    await expectError(
      client,
      { kind: "updatePreference", input: { patch: {}, expectedVersion: 1 } },
      "VALIDATION_ERROR",
    );
    // 未知字段（例如旧版本渲染进程或伪造 payload）必须被拒绝
    const unknownFieldRequest = {
      kind: "updatePreference",
      input: { patch: { unknownField: true }, expectedVersion: 1 },
    } as unknown as WorkerRequest;
    await expectError(client, unknownFieldRequest, "VALIDATION_ERROR");
    await expectError(
      client,
      {
        kind: "updatePreference",
        input: {
          patch: { widgetBounds: { x: 0, y: 0, width: 100, height: 60 } },
          expectedVersion: 1,
        },
      },
      "VALIDATION_ERROR",
    );

    const bounds = await must<{
      preferences: { values: { widgetBounds: unknown }; version: number };
    }>(client, {
      kind: "updatePreference",
      input: {
        patch: { widgetBounds: { x: 10, y: 20, width: 320, height: 120 } },
        expectedVersion: 1,
      },
    });
    assert.deepEqual(bounds.value.preferences.values.widgetBounds, {
      x: 10,
      y: 20,
      width: 320,
      height: 120,
    });
    assert.equal(bounds.value.preferences.version, 2);

    // 偏好写入不改变工作区 revision（不触发业务刷新）
    assert.equal((await snapshot(client)).revision, 0);
  } finally {
    await client.close();
  }

  const reopened = await open(file);
  try {
    const persisted = await must<{
      values: { widgetPinned: boolean };
      version: number;
    }>(reopened, { kind: "getPreferences" });
    assert.equal(persisted.value.values.widgetPinned, true);
    assert.equal(persisted.value.version, 2);
  } finally {
    await reopened.close();
  }
}

async function breakpointsAndOrdering(dir: string): Promise<void> {
  const client = await open(join(dir, "ordering.sqlite"));
  try {
    const taskA = await createTask(client, "A 排查接口超时");
    await must(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });

    // 空白断点不覆盖历史，也不产生任何变更
    const beforeBlank = await snapshot(client);
    const beforeBlankTask = await taskOf(client, taskA);
    const blank = await must<SaveBreakpointValue>(client, {
      kind: "saveBreakpoint",
      input: {
        commandId: commandId(),
        task: ref(beforeBlankTask),
        breakpoint: { progress: "   ", nextStep: " ", referenceText: "" },
      },
    });
    assert.equal(blank.value.saved, false);
    assert.equal(blank.value.breakpointSeq, null);
    const afterBlank = await taskOf(client, taskA);
    assert.equal((await snapshot(client)).revision, beforeBlank.revision);
    assert.equal(afterBlank.version, beforeBlankTask.version);
    assert.equal(afterBlank.breakpointCount, 0);
    assert.equal(afterBlank.updatedAt, beforeBlankTask.updatedAt);

    const saved = await must<SaveBreakpointValue>(client, {
      kind: "saveBreakpoint",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskA)),
        breakpoint: {
          progress: "",
          nextStep: "检查下游重试配置",
          referenceText: "",
        },
      },
    });
    assert.equal(saved.value.saved, true);
    assert.notEqual(saved.value.breakpointSeq, null);
    const withBreakpoint = await taskOf(client, taskA);
    assert.equal(withBreakpoint.latestBreakpoint?.nextStep, "检查下游重试配置");

    // 编辑标题不改变状态进入时间、状态版本与恢复排序
    await must(client, {
      kind: "updateTask",
      input: {
        commandId: commandId(),
        taskId: taskA,
        expectedVersion: withBreakpoint.version,
        title: "A 排查接口超时（改名）",
      },
    });
    const renamed = await taskOf(client, taskA);
    assert.equal(renamed.title, "A 排查接口超时（改名）");
    assert.equal(renamed.note, "");
    assert.equal(renamed.statusChangedAt, withBreakpoint.statusChangedAt);
    assert.equal(renamed.statusRevision, withBreakpoint.statusRevision);
    assert.equal(renamed.version, withBreakpoint.version + 1);
    assert(renamed.updatedAt >= withBreakpoint.updatedAt);

    // 省略备注表示不修改，仅更新标题
    await must(client, {
      kind: "saveBreakpoint",
      input: {
        commandId: commandId(),
        task: ref(renamed),
        breakpoint: {
          progress: "已完成排除",
          nextStep: "",
          referenceText: "日志#12",
        },
      },
    });
    const afterSecond = await taskOf(client, taskA);
    assert.equal(afterSecond.statusChangedAt, withBreakpoint.statusChangedAt);
    assert.equal(afterSecond.breakpointCount, 2);

    // 断点历史分页
    const breakpointPage = await must<TaskDetail>(client, {
      kind: "getTaskDetail",
      input: {
        taskId: taskA,
        breakpointOffset: 0,
        breakpointLimit: 1,
        transitionOffset: 0,
        transitionLimit: 10,
      },
    });
    assert.equal(breakpointPage.value.breakpoints.total, 2);
    assert.equal(breakpointPage.value.breakpoints.items.length, 1);
    assert.equal(breakpointPage.value.breakpoints.hasMore, true);
    assert.equal(
      breakpointPage.value.breakpoints.items[0].seq,
      afterSecond.latestBreakpoint?.seq,
    );

    // 待处理排序：created_at ASC、id ASC
    for (const title of ["D", "E", "F"]) await createTask(client, title);
    const todoPage = await must<{ items: TaskSummary[]; total: number }>(
      client,
      {
        kind: "listTasks",
        input: { statuses: ["todo"], offset: 0, limit: 50 },
      },
    );
    assert.equal(todoPage.value.total, todoPage.value.items.length);
    assert.deepEqual(
      todoPage.value.items.map((task) => task.id),
      [...todoPage.value.items].sort(compareCreatedAt).map((task) => task.id),
    );

    // 暂停排序：status_changed_at DESC、status_revision DESC、id ASC
    await must(client, {
      kind: "pauseTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    const taskD = todoPage.value.items.find((task) => task.title === "D");
    assert(taskD);
    await must(client, {
      kind: "startTask",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskD.id)),
      },
    });
    await must(client, {
      kind: "pauseTask",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskD.id)),
      },
    });
    const pausedPage = await must<{ items: TaskSummary[] }>(client, {
      kind: "listTasks",
      input: { statuses: ["paused"], offset: 0, limit: 50 },
    });
    assert.equal(pausedPage.value.items.length, 2);
    assert.deepEqual(
      pausedPage.value.items.map((task) => task.id),
      [...pausedPage.value.items]
        .sort((a, b) =>
          compareRecentFirst(a, b, (task) => task.statusChangedAt),
        )
        .map((task) => task.id),
    );
    assert.equal(
      (await snapshot(client)).resume?.task.id,
      pausedPage.value.items[0].id,
    );

    // 已结束排序：ended_at DESC
    const endedIds: string[] = [];
    for (const task of todoPage.value.items.slice(0, 2)) endedIds.push(task.id);
    for (const taskId of endedIds)
      await must(client, {
        kind: "completeTask",
        input: {
          commandId: commandId(),
          task: ref(await taskOf(client, taskId)),
        },
      });
    const endedPage = await must<{ items: TaskSummary[] }>(client, {
      kind: "listTasks",
      input: { statuses: ["done", "cancelled"], offset: 0, limit: 50 },
    });
    assert.deepEqual(
      endedPage.value.items.map((task) => task.id),
      [...endedPage.value.items]
        .sort((a, b) => compareRecentFirst(a, b, (task) => task.endedAt ?? 0))
        .map((task) => task.id),
    );

    // 分页稳定且不重叠
    const firstPage = await must<{
      items: TaskSummary[];
      total: number;
      hasMore: boolean;
    }>(client, {
      kind: "listTasks",
      input: { statuses: ["done", "cancelled"], offset: 0, limit: 1 },
    });
    const secondPage = await must<{ items: TaskSummary[] }>(client, {
      kind: "listTasks",
      input: { statuses: ["done", "cancelled"], offset: 1, limit: 1 },
    });
    const repeated = await must<{ items: TaskSummary[] }>(client, {
      kind: "listTasks",
      input: { statuses: ["done", "cancelled"], offset: 0, limit: 1 },
    });
    assert.deepEqual(
      repeated.value.items.map((task) => task.id),
      firstPage.value.items.map((task) => task.id),
    );
    assert.equal(firstPage.value.hasMore, true);
    assert.equal(firstPage.value.total, 2);
    assert.equal(
      firstPage.value.items.some(
        (task) => task.id === secondPage.value.items[0].id,
      ),
      false,
    );
  } finally {
    await client.close();
  }
}

async function dailyReviewAndLocalDates(dir: string): Promise<void> {
  const client = await open(join(dir, "daily.sqlite"));
  try {
    const taskA = await createTask(client, "A 今天完成");
    const taskB = await createTask(client, "B 误完成后重开");
    const taskC = await createTask(client, "C 今天取消");
    const taskD = await createTask(client, "D 等待外部反馈");

    await must(client, {
      kind: "markWaiting",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskD)),
        reason: "等同事反馈",
      },
    });
    await must(client, {
      kind: "completeTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    await must(client, {
      kind: "completeTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskB)) },
    });
    await must(client, {
      kind: "reopenTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskB)) },
    });
    await must(client, {
      kind: "cancelTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskC)) },
    });

    const today = localDayRangeUtc(Date.now());
    const yesterday = localDayRangeUtc(today.startUtc - 12 * 60 * 60 * 1000);
    assert.notEqual(today.dayKey, yesterday.dayKey);

    const before = await snapshot(client);
    const review = await must<{
      dayKey: string;
      currentTask: TaskSummary | null;
      completedToday: { items: TaskSummary[]; total: number };
      unfinished: TaskSummary[];
      counts: { unfinished: number };
    }>(client, {
      kind: "getDailyReview",
      input: {
        dayKey: today.dayKey,
        startUtc: today.startUtc,
        endUtc: today.endUtc,
        completedLimit: 100,
      },
    });
    assert.equal(review.value.dayKey, today.dayKey);
    assert.equal(review.value.completedToday.total, 1);
    assert.deepEqual(
      review.value.completedToday.items.map((task) => task.id),
      [taskA],
    );
    assert.equal(review.value.currentTask, null);
    assert.equal(review.value.counts.unfinished, 2);
    assert.deepEqual(
      review.value.unfinished.map((task) => task.id).sort(),
      [taskB, taskD].sort(),
    );
    assert.equal(
      review.value.unfinished.some((task) => task.id === taskC),
      false,
    );

    // 另一天的收尾视图：当天完成列表重新计算
    const yesterdayReview = await must<{ completedToday: { total: number } }>(
      client,
      {
        kind: "getDailyReview",
        input: {
          dayKey: yesterday.dayKey,
          startUtc: yesterday.startUtc,
          endUtc: yesterday.endUtc,
          completedLimit: 100,
        },
      },
    );
    assert.equal(yesterdayReview.value.completedToday.total, 0);

    // 日期查询不修改任何任务状态
    const after = await snapshot(client);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(
      after.unfinished.map((task) => `${task.id}:${task.status}`),
      before.unfinished.map((task) => `${task.id}:${task.status}`),
    );
    assert.equal((await taskOf(client, taskA)).status, "done");
    assert.equal((await taskOf(client, taskD)).status, "waiting");
    assert.equal((await taskOf(client, taskC)).status, "cancelled");

    // 收尾视图突出当前任务，并覆盖跨日遗留的暂停与等待事项（全部由合法命令构造）
    const taskE = await createTask(client, "E 收尾时的当前任务");
    await must(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskB)) },
    });
    await must<PauseTaskValue>(client, {
      kind: "pauseTask",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, taskB)),
        breakpoint: {
          progress: "暂停前的进展",
          nextStep: "明天接着核对",
          referenceText: "",
        },
      },
    });
    await must(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskE)) },
    });
    const withCurrent = await must<{
      currentTask: TaskSummary | null;
      unfinished: TaskSummary[];
      counts: { doing: number; paused: number; waiting: number };
    }>(client, {
      kind: "getDailyReview",
      input: {
        dayKey: today.dayKey,
        startUtc: today.startUtc,
        endUtc: today.endUtc,
        completedLimit: 100,
      },
    });
    assert.equal(withCurrent.value.currentTask?.id, taskE);
    assert.equal(withCurrent.value.counts.doing, 1);
    assert.equal(withCurrent.value.counts.paused, 1);
    assert.equal(withCurrent.value.counts.waiting, 1);
    const crossDayIds = withCurrent.value.unfinished.map((task) => task.id);
    assert(crossDayIds.includes(taskB), "跨日暂停事项必须出现在收尾列表");
    assert(crossDayIds.includes(taskD), "跨日等待事项必须出现在收尾列表");
    assert.equal(
      withCurrent.value.unfinished.find((task) => task.id === taskB)?.status,
      "paused",
    );
    assert.equal(
      withCurrent.value.unfinished.find((task) => task.id === taskD)?.status,
      "waiting",
    );
    // 暂停时补写的断点仍然保留
    assert.equal(
      (await taskOf(client, taskB)).latestBreakpoint?.nextStep,
      "明天接着核对",
    );
  } finally {
    await client.close();
  }
}

async function dailyReviewFinishing(dir: string): Promise<void> {
  const client = await open(join(dir, "finish.sqlite"));
  try {
    const taskA = await createTask(client, "A 保留当前任务");
    await must(client, {
      kind: "startTask",
      input: { commandId: commandId(), task: ref(await taskOf(client, taskA)) },
    });
    const current = await taskOf(client, taskA);

    // 保留当前状态：不改变任务状态
    const beforeKeep = await snapshot(client);
    const keep = await must<{ outcome: string; pausedTaskId: string | null }>(
      client,
      {
        kind: "finishDailyReview",
        input: {
          commandId: commandId(),
          outcome: "keep",
          currentTask: ref(current),
        },
      },
    );
    assert.equal(keep.value.outcome, "keep");
    assert.equal(keep.value.pausedTaskId, null);
    const afterKeep = await snapshot(client);
    assert.equal(afterKeep.revision, beforeKeep.revision);
    assert.equal(afterKeep.currentTask?.id, taskA);

    // 收尾期间当前任务已被其他窗口修改：拒绝而不是静默覆盖
    await expectError(
      client,
      {
        kind: "finishDailyReview",
        input: {
          commandId: commandId(),
          outcome: "pause",
          currentTask: { taskId: taskA, expectedVersion: current.version - 1 },
        },
      },
      "STATE_CONFLICT",
    );

    // 暂停并结束：断点与状态一次提交
    const pause = await must<{
      outcome: string;
      pausedTaskId: string | null;
      breakpointSeq: number | null;
    }>(client, {
      kind: "finishDailyReview",
      input: {
        commandId: commandId(),
        outcome: "pause",
        currentTask: ref(await taskOf(client, taskA)),
        breakpoint: {
          progress: "已完成当天排查",
          nextStep: "明天继续核对日志",
          referenceText: "",
        },
      },
    });
    assert.equal(pause.value.outcome, "pause");
    assert.equal(pause.value.pausedTaskId, taskA);
    assert.notEqual(pause.value.breakpointSeq, null);
    const afterPause = await snapshot(client);
    assert.equal(afterPause.currentTask, null);
    assert.equal(afterPause.resume?.task.id, taskA);
    assert.equal(
      afterPause.resume?.task.latestBreakpoint?.nextStep,
      "明天继续核对日志",
    );

    // 没有当前任务时结束收尾不报错
    const noCurrent = await must<{ pausedTaskId: string | null }>(client, {
      kind: "finishDailyReview",
      input: { commandId: commandId(), outcome: "pause", currentTask: null },
    });
    assert.equal(noCurrent.value.pausedTaskId, null);
  } finally {
    await client.close();
  }
}

async function recoveryAndVersionGuards(dir: string): Promise<void> {
  // 1. 不是数据库的文件：明确失败并保留原文件
  const garbage = join(dir, "garbage.sqlite");
  const garbageBytes = Buffer.alloc(4096, 0x41);
  await writeFile(garbage, garbageBytes);
  const brokenClient = new StoreClient(garbage);
  await assert.rejects(brokenClient.ready);
  assert(brokenClient.failure, "boot failure must be exposed");
  assert.match(brokenClient.failure.message, /保留|未修改/);
  assert.deepEqual(await readFile(garbage), garbageBytes);
  const rejected = await brokenClient.send({ kind: "getWorkspaceSnapshot" });
  assert(!rejected.ok);
  assert.equal(rejected.code, "DB_UNAVAILABLE");

  // 2. 较新 schema：停止写入，保留数据
  const seeded = join(dir, "seeded.sqlite");
  const seed = await open(seeded);
  await createTask(seed, "较新版本库中的数据");
  await seed.close();
  const seededBytes = await readFile(seeded);
  const newerBytes = Buffer.from(seededBytes);
  newerBytes.writeUInt32BE(99, 60);
  await writeFile(seeded, newerBytes);
  const newerClient = new StoreClient(seeded);
  await assert.rejects(newerClient.ready);
  assert.match(newerClient.failure?.message ?? "", /较新版本/);
  assert.equal((await readFile(seeded)).readUInt32BE(60), 99);

  // 3. 缺少版本信息但已有数据表：不得当作新库初始化
  const incomplete = join(dir, "incomplete.sqlite");
  const incompleteBytes = Buffer.from(seededBytes);
  incompleteBytes.writeUInt32BE(0, 60);
  await writeFile(incomplete, incompleteBytes);
  const incompleteClient = new StoreClient(incomplete);
  await assert.rejects(incompleteClient.ready);
  assert.match(incompleteClient.failure?.message ?? "", /保留|停止初始化/);
  assert.equal((await readFile(incomplete)).readUInt32BE(60), 0);

  // 还原版本号后可正常读取：证明失败路径没有清空或覆盖原库
  const restored = Buffer.from(seededBytes);
  await writeFile(incomplete, restored);
  const recovered = await open(incomplete);
  try {
    const state = await snapshot(recovered);
    assert.equal(state.unfinished.length, 1);
    assert.equal(state.unfinished[0].title, "较新版本库中的数据");
  } finally {
    await recovered.close();
  }

  // 4. 重复打开同一库：不重复迁移、不丢数据
  const stable = join(dir, "stable.sqlite");
  const firstRun = await open(stable);
  const created = await createTask(firstRun, "重复打开不丢数据");
  await firstRun.close();
  const secondRun = await open(stable);
  try {
    const state = await snapshot(secondRun);
    assert.equal(state.unfinished.length, 1);
    assert.equal(state.unfinished[0].id, created);
    assert.equal(secondRun.schemaVersion, 1);
    assert.equal(secondRun.backupPath, null);
    assert.equal((await readFile(stable)).readUInt32BE(60), 1);
  } finally {
    await secondRun.close();
  }
}

/**
 * 收尾期间当前任务被其他调用改变时：必须冲突，且不写断点、不改历史、不递增 revision、
 * 不写成功回执；只有收尾时与提交时都没有当前任务才允许无操作成功。
 */
async function dailyReviewCurrentTaskMismatch(dir: string): Promise<void> {
  const client = await open(join(dir, "finish-mismatch.sqlite"));

  /** 收尾“暂停并结束”请求；currentTask 是收尾页面当时看到的当前任务。 */
  const finishPause = (
    commandIdValue: string,
    currentTask: { taskId: string; expectedVersion: number } | null,
  ): WorkerRequest => ({
    kind: "finishDailyReview",
    input: {
      commandId: commandIdValue,
      outcome: "pause",
      currentTask,
      breakpoint: {
        progress: "",
        nextStep: "收尾时填写的断点",
        referenceText: "",
      },
    },
  });

  /** 冲突请求不得留下任务、历史、revision 或成功回执副作用。 */
  async function expectFinishConflict(
    taskId: string,
    currentTask: { taskId: string; expectedVersion: number } | null,
    label: string,
  ): Promise<void> {
    const finishCommandId = commandId();
    const before = await snapshot(client);
    const beforeTask = await taskOf(client, taskId);
    const beforeTransitions = (await detailOf(client, taskId)).transitions
      .total;
    await expectError(
      client,
      finishPause(finishCommandId, currentTask),
      "STATE_CONFLICT",
    );
    assert.equal(
      (await snapshot(client)).revision,
      before.revision,
      `${label}: 冲突请求不得递增 revision`,
    );
    const afterTask = await taskOf(client, taskId);
    assert.equal(afterTask.status, beforeTask.status, `${label}: 状态不得改变`);
    assert.equal(
      afterTask.version,
      beforeTask.version,
      `${label}: 版本不得改变`,
    );
    assert.equal(
      afterTask.breakpointCount,
      beforeTask.breakpointCount,
      `${label}: 冲突请求不得写入断点`,
    );
    assert.equal(
      (await detailOf(client, taskId)).transitions.total,
      beforeTransitions,
      `${label}: 冲突请求不得追加状态历史`,
    );
    const outcome = await must<CommandOutcome>(client, {
      kind: "getCommandResult",
      input: { commandId: finishCommandId },
    });
    assert.equal(
      outcome.value.status,
      "unknown",
      `${label}: 冲突请求不得写入成功回执`,
    );
  }

  /** 让当前位为空：开始下一件“进行中”夹具前使用。 */
  async function ensureIdle(): Promise<void> {
    const current = (await snapshot(client)).currentTask;
    if (current) await pauseTask(client, current.id);
  }

  try {
    // 1) 另一个调用先暂停当前任务
    const pausedTarget = await taskInStatus(
      client,
      "PA 被其他调用暂停",
      "doing",
    );
    const seenPaused = await taskOf(client, pausedTarget);
    await pauseTask(client, pausedTarget);
    assert.equal((await snapshot(client)).currentTask, null);
    await expectFinishConflict(pausedTarget, ref(seenPaused), "先暂停");
    assert.equal((await taskOf(client, pausedTarget)).status, "paused");

    // 2) 另一个调用先完成当前任务
    const doneTarget = await taskInStatus(client, "CA 被其他调用完成", "doing");
    const seenDone = await taskOf(client, doneTarget);
    await must(client, {
      kind: "completeTask",
      input: { commandId: commandId(), task: ref(seenDone) },
    });
    await expectFinishConflict(doneTarget, ref(seenDone), "先完成");
    assert.equal((await taskOf(client, doneTarget)).status, "done");

    // 3) 另一个调用先标记等待
    const waitingTarget = await taskInStatus(
      client,
      "WA 被其他调用标记等待",
      "doing",
    );
    const seenWaiting = await taskOf(client, waitingTarget);
    await must(client, {
      kind: "markWaiting",
      input: {
        commandId: commandId(),
        task: ref(seenWaiting),
        reason: "等同事回复",
      },
    });
    await expectFinishConflict(waitingTarget, ref(seenWaiting), "先标记等待");
    assert.equal((await taskOf(client, waitingTarget)).status, "waiting");

    // 4) 另一个调用切换到了别的任务：当前任务已不是收尾时看到的那件
    const switchAway = await taskInStatus(client, "SA 被切换走", "doing");
    const switchTarget = await createTask(client, "SB 切换目标");
    const seenSwitch = await taskOf(client, switchAway);
    await must(client, {
      kind: "switchTask",
      input: {
        commandId: commandId(),
        from: ref(seenSwitch),
        to: ref(await taskOf(client, switchTarget)),
      },
    });
    await expectFinishConflict(switchAway, ref(seenSwitch), "先切换当前任务");
    assert.equal((await snapshot(client)).currentTask?.id, switchTarget);
    await ensureIdle();

    // keep 分支同样在领域校验阶段拒绝已变化的当前任务
    const keepTarget = await taskInStatus(client, "KA 收尾期间被暂停", "doing");
    const seenKeep = await taskOf(client, keepTarget);
    await pauseTask(client, keepTarget);
    await expectError(
      client,
      {
        kind: "finishDailyReview",
        input: {
          commandId: commandId(),
          outcome: "keep",
          currentTask: ref(seenKeep),
        },
      },
      "STATE_CONFLICT",
    );

    // 已提交回执优先于当前状态校验：状态后来变化，原请求仍返回原结果且不重复写断点
    const commitTarget = await taskInStatus(
      client,
      "RA 已提交后状态改变",
      "doing",
    );
    const seenCommit = await taskOf(client, commitTarget);
    const commitId = commandId();
    const committed = await must<{ pausedTaskId: string | null }>(
      client,
      finishPause(commitId, ref(seenCommit)),
    );
    assert.equal(committed.value.pausedTaskId, commitTarget);
    const laterTarget = await createTask(client, "RB 之后开始的当前任务");
    await must(client, {
      kind: "startTask",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, laterTarget)),
      },
    });
    const replayed = await must<{ pausedTaskId: string | null }>(
      client,
      finishPause(commitId, ref(seenCommit)),
    );
    assert.equal(replayed.value.pausedTaskId, commitTarget);
    assert.equal(replayed.revision, committed.revision);
    assert.equal((await taskOf(client, commitTarget)).breakpointCount, 1);

    // 5) 收尾时与提交时都没有当前任务：允许无操作成功，断点无处可写且 revision 不变
    const stillDoing = (await snapshot(client)).currentTask;
    if (stillDoing) await pauseTask(client, stillDoing.id);
    assert.equal((await snapshot(client)).currentTask, null);
    const noopId = commandId();
    const beforeNoop = await snapshot(client);
    const noop = await must<{
      outcome: string;
      pausedTaskId: string | null;
      breakpointSeq: number | null;
    }>(client, finishPause(noopId, null));
    assert.equal(noop.value.outcome, "pause");
    assert.equal(noop.value.pausedTaskId, null);
    assert.equal(noop.value.breakpointSeq, null);
    assert.equal((await snapshot(client)).revision, beforeNoop.revision);
    const replayNoop = await must<{ pausedTaskId: string | null }>(
      client,
      finishPause(noopId, null),
    );
    assert.equal(replayNoop.value.pausedTaskId, null);
    assert.equal(replayNoop.revision, noop.revision);
    const noopOutcome = await must<CommandOutcome>(client, {
      kind: "getCommandResult",
      input: { commandId: noopId },
    });
    assert.equal(noopOutcome.value.status, "committed");
    assert.equal(noopOutcome.value.revision, noop.revision);
    assert.equal((await taskOf(client, switchTarget)).breakpointCount, 0);
  } finally {
    await client.close();
  }
}

/**
 * 命令来源前置条件：reopenTask 只接受已完成/已取消，resolveWaiting 只接受等待中。
 * 通用转换表（如 waiting → todo、done → todo）不能替代命令来源校验。
 */
async function commandSourceStatusGuards(dir: string): Promise<void> {
  const client = await open(join(dir, "command-source.sqlite"));
  try {
    const statuses = [
      "todo",
      "doing",
      "paused",
      "waiting",
      "done",
      "cancelled",
    ] as const;
    const legalSource: Record<
      "reopenTask" | "resolveWaiting",
      readonly string[]
    > = {
      reopenTask: ["done", "cancelled"],
      resolveWaiting: ["waiting"],
    };

    for (const status of statuses) {
      for (const kind of ["reopenTask", "resolveWaiting"] as const) {
        const label = `${kind} 的来源状态 ${status}`;
        const taskId = await taskInStatus(client, label, status);
        const commandIdValue = commandId();
        const request: WorkerRequest = {
          kind,
          input: {
            commandId: commandIdValue,
            task: ref(await taskOf(client, taskId)),
          },
        };
        const before = await snapshot(client);
        const beforeTask = await taskOf(client, taskId);
        const beforeTransitions = (await detailOf(client, taskId)).transitions
          .total;
        if (legalSource[kind].includes(status)) {
          const { value } = await must<{ taskId: string }>(client, request);
          assert.equal(value.taskId, taskId);
          const afterTask = await taskOf(client, taskId);
          assert.equal(afterTask.status, "todo");
          assert.equal(afterTask.endedAt, null);
          assert.equal(
            (await detailOf(client, taskId)).transitions.total,
            beforeTransitions + 1,
            `${label}: 合法命令应追加一条状态历史`,
          );
          assert((await snapshot(client)).revision > before.revision);
        } else {
          await expectError(client, request, "STATE_CONFLICT");
          assert.equal(
            (await snapshot(client)).revision,
            before.revision,
            `${label}: 非法来源不得递增 revision`,
          );
          const afterTask = await taskOf(client, taskId);
          assert.equal(afterTask.status, status, `${label}: 状态不得改变`);
          assert.equal(
            afterTask.version,
            beforeTask.version,
            `${label}: 版本不得改变`,
          );
          assert.equal(
            afterTask.endedAt,
            beforeTask.endedAt,
            `${label}: 结束时间不得改变`,
          );
          assert.equal(
            (await detailOf(client, taskId)).transitions.total,
            beforeTransitions,
            `${label}: 非法来源不得追加状态历史`,
          );
          const outcome = await must<CommandOutcome>(client, {
            kind: "getCommandResult",
            input: { commandId: commandIdValue },
          });
          assert.equal(
            outcome.value.status,
            "unknown",
            `${label}: 非法来源不得写回执`,
          );
        }
        // 清理：避免下一次“开始”因已有当前任务而返回 NEED_SWITCH
        const current = await snapshot(client);
        if (current.currentTask?.id === taskId) await pauseTask(client, taskId);
      }
    }

    // 合法重新打开：保留历史、不抢占当前任务
    const currentTaskId = await taskInStatus(
      client,
      "合法重开时的当前任务",
      "doing",
    );
    const doneTaskId = await taskInStatus(
      client,
      "合法重开的已完成事项",
      "done",
    );
    const beforeReopen = await detailOf(client, doneTaskId);
    const reopened = await must<{ taskId: string }>(client, {
      kind: "reopenTask",
      input: {
        commandId: commandId(),
        task: ref(await taskOf(client, doneTaskId)),
      },
    });
    assert.equal(reopened.value.taskId, doneTaskId);
    const afterReopen = await detailOf(client, doneTaskId);
    assert.equal(afterReopen.task.status, "todo");
    assert.equal(afterReopen.task.endedAt, null);
    assert.equal(
      afterReopen.transitions.total,
      beforeReopen.transitions.total + 1,
    );
    assert.deepEqual(
      afterReopen.transitions.items.map((item) => item.toStatus).slice(0, 2),
      ["todo", "done"],
      "重新打开保留已完成的历史",
    );
    const stateAfterReopen = await snapshot(client);
    assert.equal(stateAfterReopen.currentTask?.id, currentTaskId);
    assert.equal(stateAfterReopen.counts.doing, 1);
  } finally {
    await client.close();
  }
}

/** 收尾查询按左闭右开处理边界，且日期计算与查询都不修改任务状态。 */
async function dailyReviewBoundaries(dir: string): Promise<void> {
  const client = await open(join(dir, "review-boundaries.sqlite"));
  try {
    const completedId = await taskInStatus(client, "边界上的完成事项", "done");
    const endedAt = (await taskOf(client, completedId)).endedAt;
    assert.notEqual(endedAt, null, "完成任务必须记录 ended_at");
    const at = endedAt as number;

    const reviewRange = async (
      dayKey: string,
      startUtc: number,
      endUtc: number,
    ) => {
      const { value } = await must<{
        completedToday: { items: TaskSummary[]; total: number };
      }>(client, {
        kind: "getDailyReview",
        input: { dayKey, startUtc, endUtc, completedLimit: 100 },
      });
      return value.completedToday;
    };

    const before = await snapshot(client);

    // 左闭：起点等于完成时刻 → 计入
    assert.equal((await reviewRange("boundary", at, at + 1)).total, 1);
    // 右开：终点等于完成时刻 → 不计入
    assert.equal((await reviewRange("boundary", at - 1, at)).total, 0);
    // 完全在区间之外
    assert.equal((await reviewRange("boundary", at + 1, at + 2)).total, 0);
    // 非 24 小时区间（夏令时当天可能是 23 或 25 小时）同样左闭右开
    assert.equal((await reviewRange("boundary", at - 23 * HOUR, at)).total, 0);
    assert.equal(
      (await reviewRange("boundary", at - 22 * HOUR, at + HOUR)).total,
      1,
    );
    // main 计算的当天区间包含该完成记录
    const today = localDayRangeUtc(Date.now());
    assert(at >= today.startUtc && at < today.endUtc);
    const todayCompleted = await reviewRange(
      today.dayKey,
      today.startUtc,
      today.endUtc,
    );
    assert(todayCompleted.items.some((task) => task.id === completedId));
    assert.equal(todayCompleted.total, 1);

    // 查询与日期计算都不修改任务状态
    const after = await snapshot(client);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(
      after.unfinished.map((task) => `${task.id}:${task.status}`),
      before.unfinished.map((task) => `${task.id}:${task.status}`),
    );
    assert.equal(after.counts.done, before.counts.done);
    assert.equal((await taskOf(client, completedId)).status, "done");
    assert.equal((await taskOf(client, completedId)).endedAt, at);

    /*
     * 平台原生本地日历能力在 Electron 运行时下的行为：本地午夜不存在时，
     * 当天从跳变后的第一个时刻开始，而不是偏移迭代振荡得到的错误候选。
     * 只在本隔离测试进程内设置 TZ，不修改操作系统时区。
     */
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = "America/Santiago";
      const dstDay = localDayRangeUtc(Date.parse("2026-09-06T12:00:00.000Z"));
      assert.equal(dstDay.dayKey, "2026-09-06");
      assert.equal(dstDay.startUtc, Date.parse("2026-09-06T04:00:00.000Z"));
      assert.equal(dstDay.endUtc, Date.parse("2026-09-07T03:00:00.000Z"));
      assert.equal(dstDay.endUtc - dstDay.startUtc, 23 * HOUR);
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  } finally {
    await client.close();
  }
}

/** worker 生命周期：ready 前退出必须结束初始化等待；ready 后退出的语义保持不变。 */
async function workerLifecycle(dir: string): Promise<void> {
  // 1) 没有 fatal/error 事件的启动退出：ready 必须明确失败，等待中的调用必须可处理
  const bootExitFile = join(dir, "worker-boot-exit.sqlite");
  const startupClient = new StoreClient(bootExitFile, {
    faults: ["boot.exitBeforeReady"],
  });
  const pendingDuringStartup = withDeadline(
    startupClient.send({ kind: "getWorkspaceSnapshot" }),
    "启动退出时的等待请求",
  );
  await withDeadline(
    assert.rejects(startupClient.ready, /database worker/),
    "启动退出时的 ready 拒绝",
  );
  const startupResult = await pendingDuringStartup;
  assert(!startupResult.ok);
  assert.equal(startupResult.code, "DB_UNAVAILABLE");
  assert.equal(startupClient.failure?.code, "DB_UNAVAILABLE");
  assert.match(startupClient.failure?.message ?? "", /已退出|重启/);
  const afterStartupExit = await withDeadline(
    startupClient.send({ kind: "getWorkspaceSnapshot" }),
    "启动退出后的后续请求",
  );
  assert(!afterStartupExit.ok);
  assert.equal(afterStartupExit.code, "DB_UNAVAILABLE");
  await startupClient.close();
  // 启动前退出不破坏数据库文件
  const reopenedAfterStartupExit = await open(bootExitFile);
  try {
    assert.equal((await snapshot(reopenedAfterStartupExit)).revision, 0);
  } finally {
    await reopenedAfterStartupExit.close();
  }

  // 2) 初始化失败：等待中的调用同样必须结束并得到明确错误
  const garbage = join(dir, "worker-failure.sqlite");
  await writeFile(garbage, Buffer.alloc(1024, 0x43));
  const brokenClient = new StoreClient(garbage);
  const pendingDuringFailure = withDeadline(
    brokenClient.send({ kind: "getWorkspaceSnapshot" }),
    "初始化失败时的等待请求",
  );
  await withDeadline(
    assert.rejects(brokenClient.ready),
    "初始化失败时的 ready 拒绝",
  );
  const failureResult = await pendingDuringFailure;
  assert(!failureResult.ok);
  assert.equal(failureResult.code, "DB_UNAVAILABLE");
  await brokenClient.close();

  // 3) ready 之后退出：未完成请求 OUTCOME_UNKNOWN，后续请求 DB_UNAVAILABLE，已提交数据保留
  const crashFile = join(dir, "worker-crash.sqlite");
  const seed = await open(crashFile);
  const seededTask = await createTask(seed, "退出前已提交的事项");
  await seed.close();
  const crashClient = new StoreClient(crashFile, {
    faults: ["request.exitBeforeReply"],
  });
  await withDeadline(crashClient.ready, "ready 后退出前的初始化");
  const crashed = await withDeadline(
    crashClient.send({ kind: "getWorkspaceSnapshot" }),
    "退出时未完成的请求",
  );
  assert(!crashed.ok);
  assert.equal(crashed.code, "OUTCOME_UNKNOWN");
  const afterCrash = await withDeadline(
    crashClient.send({ kind: "getWorkspaceSnapshot" }),
    "退出后的后续请求",
  );
  assert(!afterCrash.ok);
  assert.equal(afterCrash.code, "DB_UNAVAILABLE");
  await crashClient.close();
  const recovered = await open(crashFile);
  try {
    const state = await snapshot(recovered);
    assert.equal(state.unfinished.length, 1);
    assert.equal(state.unfinished[0].id, seededTask);
  } finally {
    await recovered.close();
  }

  // 4) 正常关闭：ready 正常结算，关闭后请求明确失败，已提交数据保留
  const normalFile = join(dir, "worker-normal.sqlite");
  const normalClient = await open(normalFile);
  const normalTask = await createTask(normalClient, "正常关闭前的事项");
  assert.equal(normalClient.failure, null);
  await normalClient.close();
  const afterClose = await withDeadline(
    normalClient.send({ kind: "getWorkspaceSnapshot" }),
    "正常关闭后的请求",
  );
  assert(!afterClose.ok);
  assert.equal(afterClose.code, "DB_UNAVAILABLE");
  const reopenedAfterClose = await open(normalFile);
  try {
    const state = await snapshot(reopenedAfterClose);
    assert.equal(state.unfinished[0]?.id, normalTask);
  } finally {
    await reopenedAfterClose.close();
  }
}

/* ----------------------------------------------------------------- 入口 */
export async function runIntegration(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pickup-integration-"));
  const checks: string[] = [];
  const scenarios: [string, (dir: string) => Promise<void>][] = [
    ["新库初始化、创建、幂等回执与同名事项", basicAndIdempotency],
    ["状态转换表与非法转换", statusTransitions],
    ["切换与暂停事务各阶段失败后完整回滚", switchRollback],
    ["提交成功但响应丢失后的原请求重试与重启恢复", commitLossAndRestart],
    ["两窗口竞争、过期版本与自我切换", concurrencyAndVersions],
    ["完成、取消、重新打开与 nextUp 引用", nextUpAndEndStates],
    ["草稿版本冲突与提交时清空", drafts],
    ["偏好按字段更新与版本检查", preferences],
    ["空断点、编辑与稳定排序、分页", breakpointsAndOrdering],
    ["本地日期边界、跨日与状态不变", dailyReviewAndLocalDates],
    ["每日收尾两种结果", dailyReviewFinishing],
    ["收尾期间当前任务变化必须冲突", dailyReviewCurrentTaskMismatch],
    ["命令来源状态校验与六种状态行为", commandSourceStatusGuards],
    ["收尾查询的日期边界与状态不变", dailyReviewBoundaries],
    ["worker 启动退出、初始化失败与关闭语义", workerLifecycle],
    ["启动失败保护与版本守卫", recoveryAndVersionGuards],
  ];
  try {
    for (const [name, run] of scenarios) {
      await run(directory);
      checks.push(name);
    }
    console.log(
      JSON.stringify(
        {
          integration: "passed",
          checks,
          sqliteVersion: observedSqliteVersion,
          runtime: process.versions,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
