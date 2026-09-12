import { useEffect, useRef, useState } from "react";
import { Check, Pause } from "lucide-react";
import { msUntilNextLocalDay } from "../../../shared/local-date";
import type {
  BreakpointDraft,
  DailyReview,
  TaskRef,
  TaskSummary,
} from "../../../shared/contracts";
import { TASK_STATUS_LABEL } from "../../../shared/task";
import {
  createPending,
  emptyBreakpoint,
  invokeCommand,
  optionalBreakpoint,
  taskRef,
} from "../lib/command";
import { nextStepText } from "../lib/format";
import { Button, Field, StatusDot } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  onClose: () => void;
  onOpenTask: (task: TaskSummary) => void;
  onRefresh: () => Promise<boolean>;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function DailyReviewDialog({
  onClose,
  onOpenTask,
  onRefresh,
  onNotice,
}: Props) {
  const [review, setReview] = useState<DailyReview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<BreakpointDraft>(emptyBreakpoint);
  const seenCurrent = useRef<TaskRef | null>(null);
  const seq = useRef(0);
  const midnightTimer = useRef(0);
  const pendingNext =
    useRef(
      createPending<{
        commandId: string;
        taskId: string | null;
        expectedNextUpVersion: number;
      }>(),
    );
  const pendingFinish =
    useRef(
      createPending<{
        commandId: string;
        outcome: "keep" | "pause";
        currentTask: TaskRef | null;
        breakpoint?: BreakpointDraft;
      }>(),
    );

  async function load() {
    const current = ++seq.current;
    const result = await window.pickup.getDailyReview();
    if (current !== seq.current) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReview(result.value);
    setError("");
    window.clearTimeout(midnightTimer.current);
    midnightTimer.current = window.setTimeout(
      () => void load(),
      Math.min(msUntilNextLocalDay(Date.now()), 2_000_000_000),
    );
    if (!seenCurrent.current) {
      seenCurrent.current = result.value.currentTask
        ? taskRef(result.value.currentTask)
        : null;
    } else {
      const latest = result.value.currentTask
        ? taskRef(result.value.currentTask)
        : null;
      const previous = seenCurrent.current;
      if (
        (previous?.taskId ?? null) !== (latest?.taskId ?? null) ||
        previous?.expectedVersion !== latest?.expectedVersion
      ) {
        setError(
          "收尾期间当前任务已变化。已保留你填写的断点，请确认后再结束。",
        );
        seenCurrent.current = latest;
      }
    }
  }

  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const unsubDay = window.pickup.onDayInvalidated(() => void load());
    return () => {
      seq.current += 1;
      window.clearTimeout(midnightTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      unsubDay();
    };
  }, []);

  async function loadMoreCompleted() {
    if (!review || !review.completedToday.hasMore || busy) return;
    const current = ++seq.current;
    const result = await window.pickup.getDailyReview({
      completedOffset:
        review.completedToday.offset + review.completedToday.limit,
      completedLimit: review.completedToday.limit,
    });
    if (current !== seq.current) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.value.dayKey !== review.dayKey) {
      setReview(result.value);
      return;
    }
    setReview({
      ...result.value,
      completedToday: {
        ...result.value.completedToday,
        items: [
          ...review.completedToday.items,
          ...result.value.completedToday.items,
        ],
      },
    });
  }

  async function chooseNext(taskId: string | null) {
    if (!review || busy) return;
    setBusy(true);
    const input = pendingNext.current.take(
      (commandId) => ({
        commandId,
        taskId,
        expectedNextUpVersion: review.nextUpVersion,
      }),
      (current) =>
        current.taskId === taskId &&
        current.expectedNextUpVersion === review.nextUpVersion,
    );
    try {
      const result = await invokeCommand(input.commandId, () =>
        window.pickup.setNextUp(input),
      );
      if (!result.ok) {
        setError(result.message);
        if (result.code === "STATE_CONFLICT") {
          pendingNext.current.clear();
          await load();
        }
        return;
      }
      pendingNext.current.clear();
      await load();
      await onRefresh();
      onNotice(
        taskId
          ? "已记下下次开工的第一件事。打开应用不会自动开始。"
          : "已清除下次开工选择。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function finish(outcome: "keep" | "pause") {
    if (busy) return;
    setBusy(true);
    const currentTask = seenCurrent.current;
    const breakpoint =
      outcome === "pause" ? optionalBreakpoint(draft) : undefined;
    const input = pendingFinish.current.take(
      (commandId) => ({
        commandId,
        outcome,
        currentTask,
        breakpoint,
      }),
      (current) =>
        current.outcome === outcome &&
        current.currentTask?.taskId === currentTask?.taskId &&
        current.currentTask?.expectedVersion === currentTask?.expectedVersion &&
        JSON.stringify(current.breakpoint) === JSON.stringify(breakpoint),
    );
    try {
      const result = await invokeCommand(input.commandId, () =>
        window.pickup.finishDailyReview(input),
      );
      if (!result.ok) {
        setError(result.message);
        onNotice(result.message, "error");
        if (result.code === "STATE_CONFLICT") {
          pendingFinish.current.clear();
          await load();
        }
        return;
      }
      pendingFinish.current.clear();
      await onRefresh();
      onNotice(
        outcome === "pause"
          ? "收尾完成。当前任务已暂停。"
          : "收尾完成。当前状态已保留。",
      );
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const current = review?.currentTask ?? null;
  const unfinished = review?.unfinished ?? [];
  const completed = review?.completedToday;

  return (
    <Modal eyebrow="今日收尾" title="把今天收好。" onClose={onClose}>
      <p className="helper" style={{ marginTop: 0 }}>
        未结束的事情都会留在这里。选一件作为下一次开工的第一件事，选择本身不会开始任务。
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {!review ? (
        <p className="helper">正在读取今天的收尾…</p>
      ) : (
        <>
          {current ? (
            <div className="endday-note">
              当前仍在进行：{current.title}。结束收尾时请明确选择“暂停并结束”
              或“保留当前状态”。
            </div>
          ) : (
            <div className="endday-note">当前没有进行中的任务。</div>
          )}
          <Field
            id="review-completed"
            label={`当天完成 ${completed?.total ?? 0}`}
          >
            <div className="endday-list" id="review-completed">
              {completed && completed.items.length === 0 ? (
                <div className="empty">今天还没有完成的事项。</div>
              ) : (
                completed?.items.map((task) => (
                  <ReviewRow
                    key={task.id}
                    task={task}
                    selected={false}
                    onOpen={() => onOpenTask(task)}
                  />
                ))
              )}
              {completed?.hasMore ? (
                <button
                  type="button"
                  className="expand-link"
                  onClick={() => void loadMoreCompleted()}
                >
                  显示更多（{completed.items.length} / {completed.total}）
                </button>
              ) : null}
            </div>
          </Field>
          <Field id="review-unfinished" label="下一次开工第一件事">
            <div className="endday-list" id="review-unfinished">
              {unfinished.length === 0 ? (
                <div className="empty">今天没有需要交接的事项。</div>
              ) : (
                unfinished.map((task) => (
                  <ReviewRow
                    key={task.id}
                    task={task}
                    selected={review.nextUp?.taskId === task.id}
                    current={task.id === current?.id}
                    onOpen={() => onOpenTask(task)}
                    onChoose={() =>
                      void chooseNext(
                        review.nextUp?.taskId === task.id ? null : task.id,
                      )
                    }
                  />
                ))
              )}
            </div>
          </Field>
          {current ? (
            <Field id="review-breakpoint" label="给当前任务补一句断点（可选）">
              <textarea
                id="review-breakpoint"
                value={draft.nextStep}
                disabled={busy}
                placeholder="暂停并结束时才会写入。保留当前状态不会使用这段文字。"
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    nextStep: event.target.value,
                  }))
                }
              />
            </Field>
          ) : null}
        </>
      )}
      <div className="modal-actions">
        <Button kind="secondary" onClick={onClose}>
          稍后收尾
        </Button>
        {current ? (
          <Button
            kind="secondary"
            icon={<Pause size={15} />}
            disabled={busy}
            onClick={() => void finish("pause")}
          >
            暂停并结束
          </Button>
        ) : null}
        <Button
          icon={<Check size={15} />}
          disabled={busy}
          onClick={() => void finish("keep")}
        >
          保留当前状态
        </Button>
      </div>
    </Modal>
  );
}

function ReviewRow({
  task,
  selected,
  current,
  onOpen,
  onChoose,
}: {
  task: TaskSummary;
  selected: boolean;
  current?: boolean;
  onOpen: () => void;
  onChoose?: () => void;
}) {
  return (
    <div className={selected ? "endday-item selected" : "endday-item"}>
      <StatusDot status={task.status} />
      <button type="button" className="endday-main" onClick={onOpen}>
        <div className="endday-title">
          {task.title}
          {current ? "（当前）" : ""}
        </div>
        <div className="endday-sub">
          {TASK_STATUS_LABEL[task.status]}
          {nextStepText(task) ? ` / ${nextStepText(task)}` : ""}
        </div>
      </button>
      {onChoose && task.status !== "done" && task.status !== "cancelled" ? (
        <button type="button" className="choose-button" onClick={onChoose}>
          {selected ? "已选择" : "选为第一件事"}
        </button>
      ) : null}
    </div>
  );
}
