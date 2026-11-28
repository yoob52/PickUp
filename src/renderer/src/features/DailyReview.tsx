import { useEffect, useRef, useState } from "react";
import { Check, FileText, Pause, Upload } from "lucide-react";
import { msUntilNextLocalDay } from "../../../shared/local-date";
import type {
  NotionConfig,
  NotionDailyExportRecord,
} from "../../../shared/notion-contracts";
import type {
  ObsidianConfig,
  ObsidianDailyExportRecord,
} from "../../../shared/obsidian-contracts";
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
import { formatDateTime, nextStepText } from "../lib/format";
import { Button, Field, StatusDot } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { ToastActionTarget } from "../ui/Toast";

type Props = {
  onClose: () => void;
  onOpenTask: (task: TaskSummary) => void;
  onRefresh: () => Promise<boolean>;
  onNotice: (text: string, tone?: "ok" | "error") => void;
  onOpenSettings?: () => void;
};

export function DailyReviewDialog({
  onClose,
  onOpenTask,
  onRefresh,
  onNotice,
  onOpenSettings,
}: Props) {
  const [review, setReview] = useState<DailyReview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<BreakpointDraft>(emptyBreakpoint);
  const [notionConfig, setNotionConfig] = useState<NotionConfig | null>(null);
  const [exportRecord, setExportRecord] =
    useState<NotionDailyExportRecord | null>(null);
  const [obsidianConfig, setObsidianConfig] = useState<ObsidianConfig | null>(
    null,
  );
  const [obsidianTargetPath, setObsidianTargetPath] = useState("");
  const [obsidianExportRecord, setObsidianExportRecord] =
    useState<ObsidianDailyExportRecord | null>(null);
  const [includeBreakpoints, setIncludeBreakpoints] = useState(true);
  const [exportingNotion, setExportingNotion] = useState(false);
  const [exportingObsidian, setExportingObsidian] = useState(false);
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
    if (window.pickup.host === "desktop") {
      void Promise.all([
        window.pickup.notion({ action: "getDailyExportStatus" }),
        window.pickup.obsidian({ action: "getDailyExportStatus" }),
      ]).then(([notionRes, obsidianRes]) => {
        if (notionRes.ok && notionRes.value.action === "getDailyExportStatus") {
          setNotionConfig(notionRes.value.config);
          setExportRecord(notionRes.value.record);
        }
        if (
          obsidianRes.ok &&
          obsidianRes.value.action === "getDailyExportStatus"
        ) {
          setObsidianConfig(obsidianRes.value.config);
          setObsidianTargetPath(obsidianRes.value.targetPath);
          setObsidianExportRecord(obsidianRes.value.record);
        }
      });
    }
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

  async function exportToNotion() {
    if (exportingNotion) return;
    setExportingNotion(true);
    setError("");
    try {
      const res = await window.pickup.notion({
        action: "exportDailyReview",
        includeBreakpoints,
      });
      if (!res.ok || res.value.action !== "exportDailyReview") {
        const msg = !res.ok ? res.message : "写入 Notion 失败。";
        setError(msg);
        onNotice(msg, "error");
        return;
      }
      setExportRecord(res.value.record);
      onNotice(
        res.value.updated
          ? `已更新今日 Notion 日报（${res.value.record.dayKey} 每日总结）。`
          : `已写入 Notion 每日一页（${res.value.record.dayKey} 每日总结）。`,
      );
    } finally {
      setExportingNotion(false);
    }
  }

  async function exportToObsidian() {
    if (exportingObsidian) return;
    setExportingObsidian(true);
    setError("");
    try {
      const res = await window.pickup.obsidian({
        action: "exportDailyReview",
        includeBreakpoints,
      });
      if (!res.ok || res.value.action !== "exportDailyReview") {
        const msg = !res.ok ? res.message : "写入 Obsidian 失败。";
        setError(msg);
        onNotice(msg, "error");
        return;
      }
      setObsidianExportRecord(res.value.record);
      setObsidianTargetPath(res.value.record.targetPath);
      onNotice(
        res.value.updated
          ? `已更新今日 Obsidian 笔记（${res.value.record.targetPath}）。`
          : `已写入 Obsidian 每日笔记（${res.value.record.targetPath}）。`,
      );
    } finally {
      setExportingObsidian(false);
    }
  }

  const current = review?.currentTask ?? null;
  const unfinished = review?.unfinished ?? [];
  const completed = review?.completedToday;

  return (
    <Modal eyebrow="今日收尾" title="把今天收好。" onClose={onClose}>
      <ToastActionTarget />
      <p className="helper" style={{ marginTop: 0 }}>
        未结束的事情都会留在这里。选一件作为下一次开工的第一件事，选择本身不会开始任务；等待中的事项需先转为待处理。
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
          {window.pickup.host === "desktop" &&
          (notionConfig?.enabled || obsidianConfig?.enabled) ? (
            <div className="notion-export-card">
              <div className="notion-export-head">
                <div className="notion-export-title">
                  <FileText size={16} aria-hidden="true" />
                  <span>写入笔记</span>
                </div>
                <label className="notion-export-check">
                  <input
                    type="checkbox"
                    checked={includeBreakpoints}
                    disabled={exportingNotion || exportingObsidian}
                    onChange={(event) =>
                      setIncludeBreakpoints(event.target.checked)
                    }
                  />
                  <span>附带任务断点摘要</span>
                </label>
              </div>

              {notionConfig?.enabled ? (
                <div className="export-provider-row">
                  <div className="export-provider-info">
                    <div className="export-provider-name">
                      <strong>Notion</strong>
                      {notionConfig.hasToken && notionConfig.dailyParentId ? (
                        <span className="notion-badge synced-pill">
                          {notionConfig.dailyParentTitle || "已绑定父页面"}
                        </span>
                      ) : (
                        <span className="notion-badge">未配置父页面</span>
                      )}
                    </div>
                    <p className="notion-export-desc">
                      {notionConfig.hasToken && notionConfig.dailyParentId
                        ? `${review.dayKey} 每日总结 · ${completed?.total ?? 0} 项已完成${exportRecord ? `（上次 ${formatDateTime(exportRecord.exportedAt)}）` : ""}`
                        : "在设置中连接 Notion 并选择日报父页面后可一键写入。"}
                    </p>
                  </div>
                  {notionConfig.hasToken && notionConfig.dailyParentId ? (
                    <Button
                      kind="secondary"
                      icon={<Upload size={14} />}
                      disabled={exportingNotion || busy}
                      onClick={() => void exportToNotion()}
                    >
                      {exportingNotion
                        ? "正在写入…"
                        : exportRecord
                          ? "更新 Notion"
                          : "写入 Notion"}
                    </Button>
                  ) : onOpenSettings ? (
                    <Button
                      kind="secondary"
                      onClick={() => {
                        onClose();
                        onOpenSettings();
                      }}
                    >
                      去配置
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {obsidianConfig?.enabled ? (
                <div className="export-provider-row">
                  <div className="export-provider-info">
                    <div className="export-provider-name">
                      <strong>Obsidian</strong>
                      {obsidianConfig.configured ? (
                        <span className="notion-badge synced-pill">
                          {obsidianTargetPath || `${review.dayKey}.md`}
                        </span>
                      ) : (
                        <span className="notion-badge">未选择 Vault</span>
                      )}
                    </div>
                    <p className="notion-export-desc">
                      {obsidianConfig.configured
                        ? `写入本机 Markdown · ${completed?.total ?? 0} 项已完成${obsidianExportRecord ? `（上次 ${formatDateTime(obsidianExportRecord.exportedAt)}）` : "，保留原有笔记"}`
                        : "在设置中绑定本机 Obsidian Vault 目录后可一键写入。"}
                    </p>
                  </div>
                  {obsidianConfig.configured ? (
                    <Button
                      kind="secondary"
                      icon={<Upload size={14} />}
                      disabled={exportingObsidian || busy}
                      onClick={() => void exportToObsidian()}
                    >
                      {exportingObsidian
                        ? "正在写入…"
                        : obsidianExportRecord
                          ? "更新 Obsidian"
                          : "写入 Obsidian"}
                    </Button>
                  ) : onOpenSettings ? (
                    <Button
                      kind="secondary"
                      onClick={() => {
                        onClose();
                        onOpenSettings();
                      }}
                    >
                      去配置
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
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
          {task.checkBackAt !== null
            ? ` / ${formatDateTime(task.checkBackAt)} 回看`
            : nextStepText(task)
              ? ` / ${nextStepText(task)}`
              : ""}
        </div>
      </button>
      {onChoose &&
      task.status !== "done" &&
      task.status !== "cancelled" &&
      task.status !== "waiting" ? (
        <button type="button" className="choose-button" onClick={onChoose}>
          {selected ? "已选择" : "选为第一件事"}
        </button>
      ) : null}
    </div>
  );
}
