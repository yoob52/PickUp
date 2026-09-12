import { Check, Maximize2, Pause, Plus } from "lucide-react";
import { invokeCommand, newCommandId, taskRef } from "../lib/command";
import { nextStepText } from "../lib/format";
import { useWorkspace } from "../state/workspace";
import { Button, IconButton, NoticeBar } from "../ui/primitives";
import { useToast } from "../ui/Toast";

export function WidgetApp() {
  const { snapshot, phase, error, notice, refresh } = useWorkspace();
  const notify = useToast();
  const current = snapshot.currentTask;

  async function complete() {
    if (!current) return;
    const commandId = newCommandId();
    const result = await invokeCommand(commandId, () =>
      window.pickup.completeTask({
        commandId,
        task: taskRef(current),
      }),
    );
    if (!result.ok) {
      notify(result.message, "error");
      return;
    }
    await refresh();
    notify("已完成。请到主窗口查看恢复建议。");
  }

  async function pause() {
    if (!current) return;
    const commandId = newCommandId();
    const result = await invokeCommand(commandId, () =>
      window.pickup.pauseTask({
        commandId,
        task: taskRef(current),
      }),
    );
    if (!result.ok) {
      notify(result.message, "error");
      return;
    }
    await refresh();
    notify("已暂停。");
  }

  if (phase === "unavailable") {
    return (
      <main className="widget-window fatal-screen">
        <p>{error?.message}</p>
      </main>
    );
  }

  return (
    <main className="widget-window">
      <div className="widget-kicker">接着 PickUp</div>
      {notice ? <NoticeBar tone="error">{notice}</NoticeBar> : null}
      <h1>{current ? current.title : "现在准备做什么？"}</h1>
      <p className="widget-next">
        {current
          ? nextStepText(current) || "还没有保存断点"
          : "主窗口里选择一件事，或先记下一件新事。"}
      </p>
      <p className="widget-counts">
        已暂停 {snapshot.counts.paused} · 待处理 {snapshot.counts.todo}
      </p>
      <div className="widget-actions">
        <Button
          kind="primary"
          icon={<Plus size={14} />}
          onClick={() =>
            notify(
              "独立快速记录窗口尚未由桌面集成创建。请在主窗口使用“记一件事”。",
              "error",
            )
          }
        >
          记一件事
        </Button>
        {current ? (
          <>
            <Button
              kind="secondary"
              icon={<Pause size={14} />}
              onClick={() => void pause()}
            >
              暂停
            </Button>
            <Button
              kind="secondary"
              icon={<Check size={14} />}
              onClick={() => void complete()}
            >
              完成
            </Button>
          </>
        ) : null}
        <IconButton
          label="打开主窗口"
          onClick={() =>
            notify(
              "主窗口唤起接口尚未接入。请从已打开的应用窗口继续。",
              "error",
            )
          }
        >
          <Maximize2 size={16} />
        </IconButton>
      </div>
    </main>
  );
}
