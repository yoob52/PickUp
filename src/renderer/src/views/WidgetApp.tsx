import {
  Check,
  ChevronsDownUp,
  Maximize2,
  Pin,
  Plus,
  Repeat,
  X,
} from "lucide-react";
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

  async function patchPreference(
    patch: Parameters<typeof window.pickup.updatePreference>[0]["patch"],
    success: string,
  ) {
    const currentPrefs = await window.pickup.getPreferences();
    if (!currentPrefs.ok) {
      notify(currentPrefs.message, "error");
      return;
    }
    const result = await window.pickup.updatePreference({
      patch,
      expectedVersion: currentPrefs.value.version,
    });
    if (!result.ok) {
      notify(result.message, "error");
      return;
    }
    notify(success);
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
      <div className="widget-toolbar">
        <div className="widget-kicker">接着 PickUp</div>
        <div className="widget-tools">
          <IconButton
            label="收起或展开"
            onClick={() =>
              void window.pickup.getPreferences().then((prefs) => {
                if (!prefs.ok) return;
                void patchPreference(
                  { widgetCollapsed: !prefs.value.values.widgetCollapsed },
                  prefs.value.values.widgetCollapsed
                    ? "已展开入口。"
                    : "已收起入口。",
                );
              })
            }
          >
            <ChevronsDownUp size={14} />
          </IconButton>
          <IconButton
            label="切换置顶"
            onClick={() =>
              void window.pickup.getPreferences().then((prefs) => {
                if (!prefs.ok) return;
                void patchPreference(
                  { widgetPinned: !prefs.value.values.widgetPinned },
                  prefs.value.values.widgetPinned
                    ? "已取消置顶。"
                    : "入口已置顶。",
                );
              })
            }
          >
            <Pin size={14} />
          </IconButton>
          <IconButton
            label="隐藏桌面入口"
            onClick={() => void window.pickup.hideWidget()}
          >
            <X size={14} />
          </IconButton>
        </div>
      </div>
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
          onClick={() => void window.pickup.showCapture()}
        >
          记一件事
        </Button>
        <Button
          kind="secondary"
          icon={<Repeat size={14} />}
          onClick={() => void window.pickup.showMain()}
        >
          切换
        </Button>
        {current ? (
          <Button
            kind="secondary"
            icon={<Check size={14} />}
            onClick={() => void complete()}
          >
            完成
          </Button>
        ) : null}
        <IconButton
          label="打开主窗口"
          onClick={() => void window.pickup.showMain()}
        >
          <Maximize2 size={16} />
        </IconButton>
      </div>
    </main>
  );
}
