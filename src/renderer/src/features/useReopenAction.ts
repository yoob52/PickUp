import type { TaskRef } from "../../../shared/contracts";
import { invokeCommand, newCommandId } from "../lib/command";
import { useWorkspace } from "../state/workspace";
import { useToast, type ToastAction } from "../ui/Toast";

export function useReopenAction(onRefreshed?: (refreshed: boolean) => void) {
  const { refresh } = useWorkspace();
  const notify = useToast();

  return function reopenAction(completed: TaskRef): ToastAction {
    // 完成命令只递增一次 version，避免旧提示重新打开后来又结束的任务。
    const task = {
      taskId: completed.taskId,
      expectedVersion: completed.expectedVersion + 1,
    };
    const commandId = newCommandId();
    const action: ToastAction = {
      label: "重新打开",
      async run() {
        const result = await invokeCommand(commandId, () =>
          window.pickup.reopenTask({ commandId, task }),
        );
        if (!result.ok) {
          notify(
            result.message,
            "error",
            result.code !== "STATE_CONFLICT" && result.retryable
              ? action
              : undefined,
          );
          if (result.code === "STATE_CONFLICT") await refresh();
          return;
        }
        const refreshed = await refresh();
        onRefreshed?.(refreshed);
        if (refreshed) notify("已重新打开，断点历史仍然保留。");
        else notify("已重新打开，但界面未刷新。", "error");
      },
    };
    return action;
  };
}
