import { useEffect, useRef, useState } from "react";
import { ListFilter, Plus } from "lucide-react";
import type { Page, TaskSummary } from "../../../shared/contracts";
import { createPending, invokeCommand } from "../lib/command";
import { useWorkspace } from "../state/workspace";
import { Button, NoticeBar } from "../ui/primitives";
import { useToast } from "../ui/Toast";
import { Modal } from "../ui/Modal";
import { AppShell } from "../features/AppShell";
import { CaptureForm } from "../features/CaptureForm";
import { CurrentCard } from "../features/CurrentCard";
import { DailyReviewDialog } from "../features/DailyReview";
import { ResumePanel } from "../features/ResumePanel";
import { SettingsDialog } from "../features/SettingsDialog";
import { SwitchFlow } from "../features/SwitchFlow";
import {
  TaskBoard,
  type ListFilter as BoardFilter,
} from "../features/TaskBoard";
import { TaskDetailDialog } from "../features/TaskDetail";
import { WaitDialog } from "../features/WaitDialog";

type Overlay =
  | { type: "capture" }
  | {
      type: "switch";
      from: TaskSummary;
      to: TaskSummary | null;
      mode: "switch" | "pause";
    }
  | { type: "detail"; taskId: string }
  | { type: "wait"; task: TaskSummary }
  | { type: "review" }
  | { type: "settings" };

export function MainApp() {
  const { snapshot, phase, error, notice, refresh } = useWorkspace();
  const notify = useToast();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [filter, setFilter] = useState<BoardFilter>("unfinished");
  const [ended, setEnded] = useState<Page<TaskSummary> | null>(null);
  const [endedLoading, setEndedLoading] = useState(false);
  const [resumeHighlight, setResumeHighlight] = useState(false);
  const [savedUnsynced, setSavedUnsynced] = useState(false);
  const boardRef = useRef<HTMLElement | null>(null);
  const completePending =
    useRef(
      createPending<{
        commandId: string;
        taskId: string;
        expectedVersion: number;
      }>(),
    );
  const startPending =
    useRef(
      createPending<{
        commandId: string;
        taskId: string;
        expectedVersion: number;
      }>(),
    );

  useEffect(() => {
    if (filter !== "ended") return;
    let active = true;
    setEndedLoading(true);
    void window.pickup
      .listTasks({ statuses: ["done", "cancelled"], offset: 0, limit: 50 })
      .then((result) => {
        if (!active) return;
        setEndedLoading(false);
        if (result.ok) setEnded(result.value);
        else notify(result.message, "error");
      });
    return () => {
      active = false;
    };
  }, [filter, snapshot.revision, notify]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (overlay) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setOverlay({ type: "capture" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  async function afterWrite(okRefresh: boolean, success: string) {
    if (okRefresh) {
      setSavedUnsynced(false);
      notify(success);
      return;
    }
    setSavedUnsynced(true);
    notify("已保存，但界面未刷新。", "error");
  }

  async function startTask(task: TaskSummary) {
    const current = snapshot.currentTask;
    if (current?.id === task.id) {
      notify("这件事已经是当前任务。");
      return;
    }
    const input = startPending.current.take(
      (commandId) => ({
        commandId,
        taskId: task.id,
        expectedVersion: task.version,
      }),
      (value) =>
        value.taskId === task.id && value.expectedVersion === task.version,
    );
    const result = await invokeCommand(input.commandId, () =>
      window.pickup.startTask({
        commandId: input.commandId,
        task: { taskId: input.taskId, expectedVersion: input.expectedVersion },
      }),
    );
    if (result.ok) {
      startPending.current.clear();
      const refreshed = await refresh();
      setResumeHighlight(false);
      await afterWrite(refreshed, `已开始：${task.title}`);
      return;
    }
    if (result.code === "NEED_SWITCH") {
      if (!current) {
        notify(result.message, "error");
        return;
      }
      setOverlay({ type: "switch", mode: "switch", from: current, to: task });
      return;
    }
    notify(result.message, "error");
    if (result.code === "STATE_CONFLICT") {
      startPending.current.clear();
      await refresh();
    }
  }

  async function completeTask(task: TaskSummary) {
    const input = completePending.current.take(
      (commandId) => ({
        commandId,
        taskId: task.id,
        expectedVersion: task.version,
      }),
      (value) =>
        value.taskId === task.id && value.expectedVersion === task.version,
    );
    const result = await invokeCommand(input.commandId, () =>
      window.pickup.completeTask({
        commandId: input.commandId,
        task: { taskId: input.taskId, expectedVersion: input.expectedVersion },
      }),
    );
    if (!result.ok) {
      notify(result.message, "error");
      if (result.code === "STATE_CONFLICT") {
        completePending.current.clear();
        await refresh();
      }
      return;
    }
    completePending.current.clear();
    const refreshed = await refresh();
    if (result.value.wasCurrent) setResumeHighlight(true);
    setOverlay(null);
    await afterWrite(
      refreshed,
      result.value.wasCurrent
        ? "已完成。恢复区域已经为你留出下一步。"
        : "已标记完成。当前工作没有被打断。",
    );
  }

  async function onCreated(taskId: string, intent: "later" | "now") {
    const refreshed = await refresh();
    await afterWrite(refreshed, "已收下这件事，当前工作保持不变。");
    setOverlay(null);
    if (intent !== "now") return;
    const snapshotResult = await window.pickup.getWorkspaceSnapshot();
    if (!snapshotResult.ok) return;
    const created = snapshotResult.value.unfinished.find(
      (item) => item.id === taskId,
    );
    if (created) await startTask(created);
  }

  async function loadMoreEnded() {
    if (!ended || !ended.hasMore) return;
    const result = await window.pickup.listTasks({
      statuses: ["done", "cancelled"],
      offset: ended.offset + ended.limit,
      limit: ended.limit,
    });
    if (!result.ok) {
      notify(result.message, "error");
      return;
    }
    setEnded({
      ...result.value,
      items: [...ended.items, ...result.value.items],
    });
  }

  function focusBoard(next: BoardFilter) {
    setFilter(next);
    boardRef.current?.scrollIntoView({ block: "start" });
  }

  if (phase === "unavailable") {
    return (
      <main className="fatal-screen">
        <p className="eyebrow">DATABASE</p>
        <h1>本地数据不可用</h1>
        <p>{error?.message || "数据库无法打开。"}</p>
        <Button onClick={() => void refresh()}>重新读取</Button>
      </main>
    );
  }

  const connection =
    phase === "loading" ? "正在读取本地数据" : notice ? notice : "本地已保存";

  return (
    <AppShell
      counts={snapshot.counts}
      filter={filter}
      connection={connection}
      onFilter={focusBoard}
      onReview={() => setOverlay({ type: "review" })}
      onSettings={() => setOverlay({ type: "settings" })}
    >
      {notice ? (
        <NoticeBar
          tone="error"
          action={
            <Button kind="ghost" onClick={() => void refresh()}>
              刷新
            </Button>
          }
        >
          {notice}
        </NoticeBar>
      ) : null}
      {savedUnsynced ? (
        <NoticeBar
          tone="ok"
          action={
            <Button
              kind="ghost"
              onClick={() => void refresh().then((ok) => setSavedUnsynced(!ok))}
            >
              刷新界面
            </Button>
          }
        >
          内容已保存。界面刷新失败，不会重复提交。
        </NoticeBar>
      ) : null}
      <div className="main-head">
        <div>
          <div className="eyebrow">The thread keeper / 01</div>
          <h1 className="main-title">
            别让工作
            <br />
            <em>断在半路。</em>
          </h1>
        </div>
        <div className="head-actions">
          <Button
            kind="secondary"
            icon={<ListFilter size={15} />}
            onClick={() => focusBoard("unfinished")}
          >
            查看任务
          </Button>
          <Button
            icon={<Plus size={15} />}
            onClick={() => setOverlay({ type: "capture" })}
          >
            记一件事
          </Button>
        </div>
      </div>
      <section className="dashboard-grid" aria-label="当前工作">
        <CurrentCard
          current={snapshot.currentTask}
          onCapture={() => setOverlay({ type: "capture" })}
          onChoose={() => focusBoard("todo")}
          onPause={() => {
            if (snapshot.currentTask)
              setOverlay({
                type: "switch",
                mode: "pause",
                from: snapshot.currentTask,
                to: null,
              });
          }}
          onComplete={() => {
            if (snapshot.currentTask) void completeTask(snapshot.currentTask);
          }}
          onDetail={() => {
            if (snapshot.currentTask)
              setOverlay({ type: "detail", taskId: snapshot.currentTask.id });
          }}
        />
        <article className="capture-card">
          <div>
            <div className="card-topline">
              <h3>收件入口</h3>
              <span className="card-id">F01 / CAPTURE</span>
            </div>
            <p>先收下，不必现在决定。标题就是一条可以回来的线索。</p>
            <button
              type="button"
              className="capture-trigger"
              onClick={() => setOverlay({ type: "capture" })}
            >
              <span className="capture-placeholder">输入新事项</span>
              <span className="capture-key">N</span>
            </button>
          </div>
          <div className="metrics">
            <div>
              <span className="metric-value">{snapshot.counts.unfinished}</span>
              <span className="metric-label">未结束事项</span>
            </div>
            <div>
              <span className="metric-value">{snapshot.counts.paused}</span>
              <span className="metric-label">已暂停</span>
            </div>
            <div>
              <span className="metric-value">{snapshot.counts.waiting}</span>
              <span className="metric-label">等待中</span>
            </div>
          </div>
        </article>
      </section>
      <section className="lower-grid" aria-label="任务与恢复" ref={boardRef}>
        <TaskBoard
          filter={filter}
          unfinished={snapshot.unfinished}
          ended={ended}
          endedLoading={endedLoading}
          onFilter={setFilter}
          onOpen={(task) => setOverlay({ type: "detail", taskId: task.id })}
          onStart={(task) => void startTask(task)}
          onLoadMore={() => void loadMoreEnded()}
        />
        <ResumePanel
          snapshot={snapshot}
          highlight={resumeHighlight && !snapshot.currentTask}
          onContinue={(task) => void startTask(task)}
          onChooseOther={() => focusBoard("paused")}
          onDefer={() => setResumeHighlight(false)}
          onPickNext={() => setOverlay({ type: "review" })}
          onChangeNext={() => setOverlay({ type: "review" })}
        />
      </section>
      {overlay?.type === "capture" ? (
        <Modal
          eyebrow="Quick capture / F01"
          title="记下新一件事。"
          onClose={() => setOverlay(null)}
        >
          <CaptureForm
            onCreated={onCreated}
            onCancel={() => setOverlay(null)}
            onNotice={notify}
          />
        </Modal>
      ) : null}
      {overlay?.type === "switch" ? (
        <SwitchFlow
          mode={overlay.mode}
          from={overlay.from}
          to={overlay.to}
          onClose={() => setOverlay(null)}
          onDone={async () => {
            const refreshed = await refresh();
            setOverlay(null);
            setResumeHighlight(false);
            if (!refreshed) setSavedUnsynced(true);
          }}
          onNotice={notify}
        />
      ) : null}
      {overlay?.type === "detail" ? (
        <TaskDetailDialog
          taskId={overlay.taskId}
          onClose={() => setOverlay(null)}
          onStart={(task) => {
            setOverlay(null);
            void startTask(task);
          }}
          onWait={(task) => setOverlay({ type: "wait", task })}
          onComplete={(task) => void completeTask(task)}
          onRefresh={refresh}
          onNotice={notify}
        />
      ) : null}
      {overlay?.type === "wait" ? (
        <WaitDialog
          task={overlay.task}
          onClose={() => setOverlay(null)}
          onDone={async () => {
            await refresh();
            setOverlay(null);
          }}
          onNotice={notify}
        />
      ) : null}
      {overlay?.type === "review" ? (
        <DailyReviewDialog
          onClose={() => setOverlay(null)}
          onOpenTask={(task) => setOverlay({ type: "detail", taskId: task.id })}
          onRefresh={refresh}
          onNotice={notify}
        />
      ) : null}
      {overlay?.type === "settings" ? (
        <SettingsDialog onClose={() => setOverlay(null)} onNotice={notify} />
      ) : null}
    </AppShell>
  );
}
