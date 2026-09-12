import { useEffect, useRef, useState } from "react";
import { ArchiveX, Check, Clock3, Pencil, Play, RotateCcw } from "lucide-react";
import type { TaskDetail as TaskDetailDto } from "../../../shared/contracts";
import {
  NOTE_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  type TaskSummary,
} from "../../../shared/contracts";
import { TASK_STATUS_LABEL } from "../../../shared/task";
import { createPending, invokeCommand, taskRef } from "../lib/command";
import { formatDateTime } from "../lib/format";
import { Button, Field, StatusDot } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  taskId: string;
  onClose: () => void;
  onStart: (task: TaskSummary) => void;
  onWait: (task: TaskSummary) => void;
  onComplete: (task: TaskSummary) => void;
  onRefresh: () => Promise<boolean>;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function TaskDetailDialog({
  taskId,
  onClose,
  onStart,
  onWait,
  onComplete,
  onRefresh,
  onNotice,
}: Props) {
  const [detail, setDetail] = useState<TaskDetailDto | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const pendingUpdate =
    useRef(
      createPending<{
        commandId: string;
        taskId: string;
        expectedVersion: number;
        title: string;
        note: string;
      }>(),
    );
  const pendingAction = useRef(createPending<{ commandId: string }>());

  async function load(offset = 0, more = false) {
    const current = ++seq.current;
    const result = await window.pickup.getTaskDetail({
      taskId,
      breakpointOffset: more
        ? (detail?.breakpoints.offset ?? 0) + (detail?.breakpoints.limit ?? 10)
        : offset,
      breakpointLimit: 10,
      transitionOffset: 0,
      transitionLimit: 20,
    });
    if (current !== seq.current) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError("");
    setDetail((prev) => {
      if (!more || !prev) return result.value;
      return {
        ...result.value,
        breakpoints: {
          ...result.value.breakpoints,
          items: [...prev.breakpoints.items, ...result.value.breakpoints.items],
          offset: result.value.breakpoints.offset,
        },
      };
    });
    setTitle(result.value.task.title);
    setNote(result.value.task.note);
  }

  useEffect(() => {
    void load();
    return () => {
      seq.current += 1;
    };
  }, [taskId]);

  async function saveEdit() {
    if (!detail || busy) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError("请填写任务标题");
      return;
    }
    setBusy(true);
    const input = pendingUpdate.current.take(
      (commandId) => ({
        commandId,
        taskId: detail.task.id,
        expectedVersion: detail.task.version,
        title: trimmed,
        note,
      }),
      (current) =>
        current.expectedVersion === detail.task.version &&
        current.title === trimmed &&
        current.note === note,
    );
    try {
      const result = await invokeCommand(input.commandId, () =>
        window.pickup.updateTask(input),
      );
      if (!result.ok) {
        setError(result.message);
        onNotice(result.message, "error");
        if (result.code === "STATE_CONFLICT") await load();
        return;
      }
      pendingUpdate.current.clear();
      setEditing(false);
      const refreshed = await onRefresh();
      await load();
      onNotice(
        refreshed ? "任务内容已更新，状态保持不变。" : "已保存，但界面未刷新。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runStatus(
    kind: "cancel" | "reopen" | "resolve",
    task: TaskSummary,
  ) {
    if (busy) return;
    setBusy(true);
    const input = pendingAction.current.take(
      (commandId) => ({ commandId }),
      () => true,
    );
    const payload = {
      commandId: input.commandId,
      task: taskRef(task),
    };
    try {
      const result =
        kind === "cancel"
          ? await invokeCommand(input.commandId, () =>
              window.pickup.cancelTask(payload),
            )
          : kind === "reopen"
            ? await invokeCommand(input.commandId, () =>
                window.pickup.reopenTask(payload),
              )
            : await invokeCommand(input.commandId, () =>
                window.pickup.resolveWaiting(payload),
              );
      if (!result.ok) {
        setError(result.message);
        onNotice(result.message, "error");
        if (result.code === "STATE_CONFLICT") await load();
        pendingAction.current.clear();
        return;
      }
      pendingAction.current.clear();
      await onRefresh();
      onNotice(
        kind === "cancel"
          ? "已取消这件事。需要时可从已结束重新打开。"
          : kind === "reopen"
            ? "已重新打开，断点历史仍然保留。"
            : "等待条件已记下满足，任务回到待处理。",
      );
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const task = detail?.task;

  return (
    <Modal
      wide
      eyebrow="Task detail / context"
      title={task?.title ?? "任务详情"}
      onClose={onClose}
    >
      {task ? (
        <div className="detail-status">
          <StatusDot status={task.status} />
          {TASK_STATUS_LABEL[task.status]}
        </div>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {!detail ? (
        <p className="helper">正在读取详情…</p>
      ) : (
        <div className="detail-grid">
          <div>
            <section className="detail-section">
              <div className="detail-section-head">
                <h4>{editing ? "编辑内容" : "备注"}</h4>
                {task &&
                task.status !== "done" &&
                task.status !== "cancelled" ? (
                  <button
                    type="button"
                    className="expand-link"
                    onClick={() => setEditing((value) => !value)}
                  >
                    <Pencil size={13} />
                    {editing ? "返回" : "编辑"}
                  </button>
                ) : null}
              </div>
              {editing ? (
                <>
                  <Field id="edit-title" label="标题">
                    <input
                      id="edit-title"
                      maxLength={TITLE_MAX_LENGTH}
                      value={title}
                      disabled={busy}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </Field>
                  <Field id="edit-note" label="备注">
                    <textarea
                      id="edit-note"
                      maxLength={NOTE_MAX_LENGTH}
                      value={note}
                      disabled={busy}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </Field>
                  <Button onClick={() => void saveEdit()} disabled={busy}>
                    保存修改
                  </Button>
                </>
              ) : (
                <p className="detail-copy">{task?.note || "还没有备注。"}</p>
              )}
            </section>
            <section className="detail-section">
              <h4>最新断点</h4>
              {task?.latestBreakpoint ? (
                <p className="detail-copy">
                  {task.latestBreakpoint.nextStep ||
                    task.latestBreakpoint.progress}
                </p>
              ) : (
                <p className="detail-copy">尚未留下断点。</p>
              )}
            </section>
            <section className="detail-section">
              <h4>断点历史</h4>
              {detail.breakpoints.items.length === 0 ? (
                <p className="detail-copy">
                  尚未留下断点。下一次暂停时，一句话就够。
                </p>
              ) : (
                detail.breakpoints.items.map((item) => (
                  <div className="breakpoint-item" key={item.seq}>
                    <div className="breakpoint-time">
                      {formatDateTime(item.savedAt)}
                    </div>
                    <div className="breakpoint-text">
                      {item.nextStep || item.progress}
                      {item.referenceText ? (
                        <>
                          <br />
                          <span className="muted">{item.referenceText}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
              {detail.breakpoints.hasMore ? (
                <button
                  type="button"
                  className="expand-link"
                  onClick={() => void load(0, true)}
                >
                  加载更早的断点（{detail.breakpoints.items.length} /{" "}
                  {detail.breakpoints.total}）
                </button>
              ) : null}
            </section>
            <section className="detail-section">
              <h4>状态历史</h4>
              {detail.transitions.items.map((item) => (
                <p className="helper" key={item.seq}>
                  {item.fromStatus
                    ? TASK_STATUS_LABEL[item.fromStatus]
                    : "新建"}{" "}
                  → {TASK_STATUS_LABEL[item.toStatus]} ·{" "}
                  {formatDateTime(item.changedAt)}
                </p>
              ))}
              {detail.transitions.hasMore ? (
                <p className="helper">
                  仅显示最近 {detail.transitions.items.length} /{" "}
                  {detail.transitions.total} 条状态变化。
                </p>
              ) : null}
            </section>
          </div>
          <aside className="detail-side">
            <label>Created</label>
            <div className="side-stat">
              {task ? formatDateTime(task.createdAt) : ""}
            </div>
            <p>
              {task?.endedAt
                ? `${formatDateTime(task.endedAt)} 结束`
                : "仍在工作区里"}
            </p>
            {task?.waitReason ? (
              <div className="detail-section">
                <h4>等待原因</h4>
                <p className="detail-copy">{task.waitReason}</p>
              </div>
            ) : null}
            <div className="detail-actions">
              {task && task.status !== "done" && task.status !== "cancelled" ? (
                <>
                  {task.status !== "doing" ? (
                    <Button
                      icon={<Play size={15} />}
                      onClick={() => onStart(task)}
                    >
                      继续处理
                    </Button>
                  ) : (
                    <Button kind="secondary" disabled>
                      正在处理
                    </Button>
                  )}
                  {task.status === "waiting" ? (
                    <Button
                      kind="secondary"
                      onClick={() => void runStatus("resolve", task)}
                    >
                      条件已满足
                    </Button>
                  ) : (
                    <Button
                      kind="secondary"
                      icon={<Clock3 size={15} />}
                      onClick={() => onWait(task)}
                    >
                      标记等待
                    </Button>
                  )}
                  <Button
                    kind="secondary"
                    icon={<Check size={15} />}
                    onClick={() => onComplete(task)}
                  >
                    完成
                  </Button>
                  <Button
                    kind="danger"
                    icon={<ArchiveX size={15} />}
                    onClick={() => void runStatus("cancel", task)}
                  >
                    取消这件事
                  </Button>
                </>
              ) : task ? (
                <Button
                  icon={<RotateCcw size={15} />}
                  onClick={() => void runStatus("reopen", task)}
                >
                  重新打开
                </Button>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </Modal>
  );
}
