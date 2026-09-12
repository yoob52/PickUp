import { useState } from "react";
import { ArrowRight, CornerDownLeft, Pause } from "lucide-react";
import {
  BREAKPOINT_FIELD_MAX_LENGTH,
  type BreakpointDraft,
  type TaskSummary,
} from "../../../shared/contracts";
import {
  createPending,
  emptyBreakpoint,
  invokeCommand,
  optionalBreakpoint,
  taskRef,
} from "../lib/command";
import { breakpointLine } from "../lib/format";
import { Button, Field } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Mode = "switch" | "pause";

type Props = {
  mode: Mode;
  from: TaskSummary;
  to: TaskSummary | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function SwitchFlow({
  mode,
  from,
  to,
  onClose,
  onDone,
  onNotice,
}: Props) {
  const [fromTask, setFromTask] = useState(from);
  const [toTask, setToTask] = useState(to);
  const [draft, setDraft] = useState<BreakpointDraft>(emptyBreakpoint);
  const [openMore, setOpenMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingSwitch = useState(() =>
    createPending<{
      commandId: string;
      from: ReturnType<typeof taskRef>;
      to: ReturnType<typeof taskRef>;
      breakpoint?: BreakpointDraft;
    }>(),
  )[0];
  const pendingPause = useState(() =>
    createPending<{
      commandId: string;
      task: ReturnType<typeof taskRef>;
      breakpoint?: BreakpointDraft;
    }>(),
  )[0];

  function patch<K extends keyof BreakpointDraft>(
    key: K,
    value: BreakpointDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
  }

  async function refreshTasks() {
    const snapshot = await window.pickup.getWorkspaceSnapshot();
    if (!snapshot.ok) {
      setError(snapshot.message);
      return;
    }
    const latestFrom =
      snapshot.value.unfinished.find((item) => item.id === fromTask.id) ??
      (snapshot.value.currentTask?.id === fromTask.id
        ? snapshot.value.currentTask
        : null);
    if (latestFrom) setFromTask(latestFrom);
    if (toTask) {
      const latestTo =
        snapshot.value.unfinished.find((item) => item.id === toTask.id) ?? null;
      if (latestTo) setToTask(latestTo);
    }
    setError("任务已更新。已保留断点，请确认后再次提交。");
  }

  async function submit(skip: boolean) {
    if (busy) return;
    setBusy(true);
    const breakpoint = skip ? undefined : optionalBreakpoint(draft);
    try {
      if (mode === "pause") {
        const input = pendingPause.take(
          (commandId) => ({
            commandId,
            task: taskRef(fromTask),
            breakpoint,
          }),
          (current) =>
            current.task.taskId === fromTask.id &&
            current.task.expectedVersion === fromTask.version &&
            JSON.stringify(current.breakpoint) === JSON.stringify(breakpoint),
        );
        const result = await invokeCommand(input.commandId, () =>
          window.pickup.pauseTask(input),
        );
        if (!result.ok) {
          setError(result.message);
          onNotice(result.message, "error");
          if (result.code === "STATE_CONFLICT") {
            pendingPause.clear();
            await refreshTasks();
          }
          return;
        }
        pendingPause.clear();
        await onDone();
        onNotice("已暂停。回来时从这条线索继续。");
        return;
      }
      if (!toTask) {
        setError("没有可切换的目标任务。");
        return;
      }
      const input = pendingSwitch.take(
        (commandId) => ({
          commandId,
          from: taskRef(fromTask),
          to: taskRef(toTask),
          breakpoint,
        }),
        (current) =>
          current.from.expectedVersion === fromTask.version &&
          current.to.expectedVersion === toTask.version &&
          JSON.stringify(current.breakpoint) === JSON.stringify(breakpoint),
      );
      const result = await invokeCommand(input.commandId, () =>
        window.pickup.switchTask(input),
      );
      if (!result.ok) {
        setError(result.message);
        onNotice(result.message, "error");
        if (result.code === "STATE_CONFLICT") {
          pendingSwitch.clear();
          await refreshTasks();
        }
        return;
      }
      pendingSwitch.clear();
      await onDone();
      onNotice(
        result.value.switched
          ? "已保存断点并切换任务。"
          : "这件事已经是当前任务。",
      );
    } finally {
      setBusy(false);
    }
  }

  const previous = breakpointLine(fromTask.latestBreakpoint);

  return (
    <Modal
      eyebrow={mode === "pause" ? "Pause / F03" : "Switch / F03"}
      title={mode === "pause" ? "把线索留在这里。" : "先保存，再继续。"}
      onClose={onClose}
    >
      <div className="switch-context">
        <div className="context-box">
          <span>{mode === "pause" ? "正在暂停" : "当前任务"}</span>
          <strong>{fromTask.title}</strong>
        </div>
        <div className="context-arrow" aria-hidden="true">
          <ArrowRight size={18} />
        </div>
        <div className="context-box">
          <span>{mode === "pause" ? "当前位" : "下一件事"}</span>
          <strong>{toTask ? toTask.title : "暂时空着"}</strong>
        </div>
      </div>
      <Field id="breakpoint-next" label="下一步">
        <textarea
          id="breakpoint-next"
          maxLength={BREAKPOINT_FIELD_MAX_LENGTH}
          value={draft.nextStep}
          disabled={busy}
          placeholder="下一步做什么？一句话也够。"
          onChange={(event) => patch("nextStep", event.target.value)}
        />
      </Field>
      {openMore ? (
        <>
          <Field id="breakpoint-progress" label="已做进展">
            <textarea
              id="breakpoint-progress"
              maxLength={BREAKPOINT_FIELD_MAX_LENGTH}
              value={draft.progress}
              disabled={busy}
              onChange={(event) => patch("progress", event.target.value)}
            />
          </Field>
          <Field id="breakpoint-ref" label="参考文本">
            <textarea
              id="breakpoint-ref"
              maxLength={BREAKPOINT_FIELD_MAX_LENGTH}
              value={draft.referenceText}
              disabled={busy}
              onChange={(event) => patch("referenceText", event.target.value)}
            />
          </Field>
        </>
      ) : (
        <button
          type="button"
          className="expand-link"
          onClick={() => setOpenMore(true)}
        >
          补充进展和参考
        </button>
      )}
      <div className="current-breakpoint">
        <strong>最近一条断点</strong>
        <br />
        {previous || "尚未记录断点。你可以跳过，历史不会被覆盖。"}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-actions">
        <Button kind="secondary" onClick={onClose} disabled={busy}>
          返回
        </Button>
        <Button
          kind="secondary"
          onClick={() => void submit(true)}
          disabled={busy}
        >
          {busy ? "正在切换…" : mode === "pause" ? "跳过并暂停" : "跳过并切换"}
        </Button>
        <Button
          kind="primary"
          icon={
            mode === "pause" ? (
              <Pause size={15} />
            ) : (
              <CornerDownLeft size={15} />
            )
          }
          onClick={() => void submit(false)}
          disabled={busy}
        >
          {busy ? "正在保存…" : mode === "pause" ? "保存并暂停" : "保存并切换"}
        </Button>
      </div>
    </Modal>
  );
}
