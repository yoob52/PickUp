import { useState } from "react";
import type { TaskSummary } from "../../../shared/contracts";
import { invokeCommand, newCommandId, taskRef } from "../lib/command";
import { useWorkspace } from "../state/workspace";
import { NoticeBar } from "../ui/primitives";
import { useToast } from "../ui/Toast";
import { CaptureForm } from "../features/CaptureForm";
import { SwitchFlow } from "../features/SwitchFlow";

export function CaptureApp() {
  const { snapshot, phase, error, notice, refresh } = useWorkspace();
  const notify = useToast();
  const [switchTo, setSwitchTo] = useState<TaskSummary | null>(null);

  async function onCreated(taskId: string, intent: "later" | "now") {
    const refreshed = await refresh();
    if (intent === "later") {
      notify(refreshed ? "已收下，保存为待处理。" : "已保存，但界面未刷新。");
      return;
    }
    const latest = await window.pickup.getWorkspaceSnapshot();
    if (!latest.ok) {
      notify(latest.message, "error");
      return;
    }
    const created = latest.value.unfinished.find((item) => item.id === taskId);
    const current = latest.value.currentTask;
    if (!created) return;
    const commandId = newCommandId();
    const start = await invokeCommand(commandId, () =>
      window.pickup.startTask({
        commandId,
        task: taskRef(created),
      }),
    );
    if (start.ok) {
      await refresh();
      notify("已开始新事项。");
      return;
    }
    if (start.code === "NEED_SWITCH" && current) {
      setSwitchTo(created);
      return;
    }
    notify(start.message, "error");
  }

  if (phase === "unavailable") {
    return (
      <main className="capture-window fatal-screen">
        <h1>本地数据不可用</h1>
        <p>{error?.message}</p>
      </main>
    );
  }

  return (
    <main className="capture-window">
      <div className="modal-eyebrow">Quick capture / F01</div>
      <h1>记下新一件事。</h1>
      {notice ? <NoticeBar tone="error">{notice}</NoticeBar> : null}
      <CaptureForm
        onCreated={onCreated}
        onCancel={() => notify("未创建任务。草稿仍会保留。")}
        onNotice={notify}
      />
      {switchTo && snapshot.currentTask ? (
        <SwitchFlow
          mode="switch"
          from={snapshot.currentTask}
          to={switchTo}
          onClose={() => setSwitchTo(null)}
          onDone={async () => {
            setSwitchTo(null);
            await refresh();
          }}
          onNotice={notify}
        />
      ) : null}
    </main>
  );
}
