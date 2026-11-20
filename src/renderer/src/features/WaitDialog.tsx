import { useState } from "react";
import { Clock3 } from "lucide-react";
import {
  WAIT_REASON_MAX_LENGTH,
  type TaskSummary,
} from "../../../shared/contracts";
import { createPending, invokeCommand, taskRef } from "../lib/command";
import {
  formatDateTime,
  fromDateTimeInput,
  toDateTimeInput,
} from "../lib/format";
import { Button, Field } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  task: TaskSummary;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

const HOUR = 60 * 60 * 1000;

function inOneHour(): number {
  const next = new Date(Date.now() + HOUR);
  next.setSeconds(0, 0);
  return next.getTime();
}

function tomorrowMorning(): number {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next.getTime();
}

export function WaitDialog({ task, onClose, onDone, onNotice }: Props) {
  const [reason, setReason] = useState(task.waitReason);
  const [checkBack, setCheckBack] = useState(
    task.checkBackAt === null ? "" : toDateTimeInput(task.checkBackAt),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [timeError, setTimeError] = useState("");
  const pending = useState(() =>
    createPending<{
      commandId: string;
      task: ReturnType<typeof taskRef>;
      reason: string;
      checkBackAt: number | null;
    }>(),
  )[0];

  function pickTime(ms: number | null) {
    setCheckBack(ms === null ? "" : toDateTimeInput(ms));
    setTimeError("");
  }

  async function save() {
    if (busy) return;
    const checkBackAt = fromDateTimeInput(checkBack);
    const unchanged = checkBackAt !== null && checkBackAt === task.checkBackAt;
    if (checkBackAt !== null && checkBackAt <= Date.now() && !unchanged) {
      setTimeError("回看时间需要晚于现在。");
      return;
    }
    setBusy(true);
    const input = pending.take(
      (commandId) => ({
        commandId,
        task: taskRef(task),
        reason,
        checkBackAt,
      }),
      (current) =>
        current.task.expectedVersion === task.version &&
        current.reason === reason &&
        current.checkBackAt === checkBackAt,
    );
    try {
      const result = await invokeCommand(input.commandId, () =>
        window.pickup.markWaiting(input),
      );
      if (!result.ok) {
        setError(result.message);
        onNotice(result.message, "error");
        return;
      }
      pending.clear();
      await onDone();
      onNotice(
        checkBackAt === null
          ? "已标记等待，不会主动打扰你。"
          : `已标记等待，${formatDateTime(checkBackAt)} 会回到恢复区域。`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal eyebrow="等待" title="等什么？" onClose={onClose}>
      <Field id="wait-reason" label="等待原因" error={error}>
        <textarea
          id="wait-reason"
          maxLength={WAIT_REASON_MAX_LENGTH}
          value={reason}
          disabled={busy}
          placeholder="例如：等待确认交互稿"
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <Field
        id="wait-check-back"
        label="何时回看（可选）"
        error={timeError}
        hint="到时间后它会回到恢复区域，不会弹窗，也不会自动开始。"
      >
        <input
          id="wait-check-back"
          type="datetime-local"
          value={checkBack}
          disabled={busy}
          onChange={(event) => {
            setCheckBack(event.target.value);
            setTimeError("");
          }}
        />
        <div
          className="check-back-presets"
          role="group"
          aria-label="快捷回看时间"
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => pickTime(inOneHour())}
          >
            1 小时后
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => pickTime(tomorrowMorning())}
          >
            明天 9:00
          </button>
          {checkBack ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => pickTime(null)}
            >
              不设回看
            </button>
          ) : null}
        </div>
      </Field>
      <div className="modal-actions">
        <Button kind="secondary" onClick={onClose}>
          返回
        </Button>
        <Button
          icon={<Clock3 size={15} />}
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? "正在保存…" : "标记等待"}
        </Button>
      </div>
    </Modal>
  );
}
