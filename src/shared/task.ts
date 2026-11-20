import type { TaskSummary, WorkspaceSnapshot } from "./contracts";

/** 任务状态；界面中文名称与 PRD 7.2 对应。 */
export type TaskStatus =
  "todo" | "doing" | "paused" | "waiting" | "done" | "cancelled";

export const TASK_STATUSES = [
  "todo",
  "doing",
  "paused",
  "waiting",
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];

export const UNFINISHED_STATUSES = [
  "todo",
  "doing",
  "paused",
  "waiting",
] as const satisfies readonly TaskStatus[];

export const ENDED_STATUSES = [
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待处理",
  doing: "进行中",
  paused: "已暂停",
  waiting: "等待中",
  done: "已完成",
  cancelled: "已取消",
};

/** PRD 7.3 状态转换表；这里是唯一的转换规则来源，worker 按此校验。 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["doing", "waiting", "done", "cancelled"],
  doing: ["paused", "waiting", "done", "cancelled"],
  paused: ["doing", "waiting", "done", "cancelled"],
  waiting: ["todo", "doing", "done", "cancelled"],
  done: ["todo"],
  cancelled: ["todo"],
};

export function isEndedStatus(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

export function isUnfinishedStatus(status: TaskStatus): boolean {
  return !isEndedStatus(status);
}

/** 可以进入 doing 的状态：todo / paused / waiting。 */
export function isStartableStatus(status: TaskStatus): boolean {
  return status === "todo" || status === "paused" || status === "waiting";
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** 已到回看时间的等待事项，按回看时间从早到晚、id 升序。 */
export function dueCheckBacks(
  tasks: readonly TaskSummary[],
  now: number,
): TaskSummary[] {
  return tasks
    .filter(
      (task) =>
        task.status === "waiting" &&
        task.checkBackAt !== null &&
        task.checkBackAt <= now,
    )
    .sort(
      (a, b) =>
        (a.checkBackAt ?? 0) - (b.checkBackAt ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** 下一个尚未到达的回看时间；没有则为 null。 */
export function nextCheckBackAt(
  tasks: readonly TaskSummary[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const task of tasks) {
    if (task.status !== "waiting" || task.checkBackAt === null) continue;
    if (task.checkBackAt <= now) continue;
    if (next === null || task.checkBackAt < next) next = task.checkBackAt;
  }
  return next;
}

export type StatusCounts = Record<TaskStatus, number> & {
  unfinished: number;
};

export function emptyCounts(): StatusCounts {
  return {
    todo: 0,
    doing: 0,
    paused: 0,
    waiting: 0,
    done: 0,
    cancelled: 0,
    unfinished: 0,
  };
}

export function emptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return {
    revision: 0,
    currentTask: null,
    counts: emptyCounts(),
    unfinished: [],
    resume: null,
    nextUp: null,
    nextUpVersion: 0,
  };
}
