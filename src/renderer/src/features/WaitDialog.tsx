import { useState } from "react";
import { Clock3 } from "lucide-react";
import {
  WAIT_REASON_MAX_LENGTH,
  type TaskSummary,
} from "../../../shared/contracts";
import { createPending, invokeCommand, taskRef } from "../lib/command";
import { Button, Field } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  task: TaskSummary;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function WaitDialog({ task, onClose, onDone, onNotice }: Props) {
  const [reason, setReason] = useState(task.waitReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useState(() =>
    createPending<{
      commandId: string;
      task: ReturnType<typeof taskRef>;
      reason: string;
    }>(),
  )[0];

  async function save() {
    if (busy) return;
    setBusy(true);
    const input = pending.take(
      (commandId) => ({
        commandId,
        task: taskRef(task),
        reason,
      }),
      (current) =>
        current.task.expectedVersion === task.version &&
        current.reason === reason,
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
      onNotice("已标记等待，不会主动打扰你。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal eyebrow="Waiting / F05" title="等什么？" onClose={onClose}>
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
