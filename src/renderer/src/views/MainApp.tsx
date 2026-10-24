import { useEffect, useRef, useState } from "react";
import { Plus, Sunset } from "lucide-react";
import type { Page, TaskSummary } from "../../../shared/contracts";
import { createPending, invokeCommand } from "../lib/command";
import { useWorkspace } from "../state/workspace";
import { Button, NoticeBar } from "../ui/primitives";
import { useToast } from "../ui/Toast";
import { AppShell } from "../features/AppShell";
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
  | {
      type: "switch";
      from: TaskSummary;
      to: TaskSummary | null;
      mode: "switch" | "pause";
    }
  | { type: "detail"; taskId: string }
  | { type: "wait"; task: TaskSummary }
  | { type: "settings" };

export function MainApp() {
  const { snapshot, phase, error, notice, refresh } = useWorkspace();
  const notify = useToast();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [filter, setFilter] = useState<BoardFilter>("unfinished");
  const [ended, setEnded] = useState<Page<TaskSummary> | null>(null);
  const [endedLoading, setEndedLoading] = useState(false);
  const [resumeHighlight, setResumeHighlight] = useState(false);
  const [savedUnsynced, setSavedUnsynced] = useState(false);
  const boardRef = useRef<HTMLElement | null>(null);
  const endedGen = useRef(0);
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
    const gen = ++endedGen.current;
    setEndedLoading(true);
    void window.pickup
      .listTasks({ statuses: ["done", "cancelled"], offset: 0, limit: 50 })
      .then((result) => {
        if (gen !== endedGen.current) return;
        setEndedLoading(false);
        if (result.ok) setEnded(result.value);
        else notify(result.message, "error");
      });
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
        void window.pickup.showCapture();
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

  async function loadMoreEnded() {
    if (!ended || !ended.hasMore) return;
    const gen = endedGen.current;
    const page = ended;
    const result = await window.pickup.listTasks({
      statuses: ["done", "cancelled"],
      offset: page.offset + page.limit,
      limit: page.limit,
    });
    if (gen !== endedGen.current) return;
    if (!result.ok) {
      notify(result.message, "error");
      return;
    }
    setEnded({
      ...result.value,
      items: [...page.items, ...result.value.items],
    });
  }

  function focusBoard(next: BoardFilter) {
    setFilter(next);
    boardRef.current?.scrollIntoView({ block: "start" });
  }

  if (phase === "unavailable") {
    return (
      <main className="fatal-screen">
        <p className="eyebrow">本地数据</p>
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
      onCapture={() => void window.pickup.showCapture()}
      onReview={() => setReviewOpen(true)}
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
      <section className="dashboard-grid" aria-label="当前工作">
        <CurrentCard
          current={snapshot.currentTask}
          onCapture={() => void window.pickup.showCapture()}
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
        <ResumePanel
          snapshot={snapshot}
          highlight={resumeHighlight && !snapshot.currentTask}
          onContinue={(task) => void startTask(task)}
          onChooseOther={() => focusBoard("paused")}
          onDefer={() => setResumeHighlight(false)}
          onPickNext={() => setReviewOpen(true)}
          onChangeNext={() => setReviewOpen(true)}
        />
      </section>
      <button
        type="button"
        className="capture-trigger"
        onClick={() => void window.pickup.showCapture()}
      >
        <Plus size={17} aria-hidden="true" />
        <span className="capture-placeholder">
          有件新事？先记在这里，不打断当前工作。
        </span>
        <kbd className="capture-key">N</kbd>
        <span className="capture-cta">记一件事</span>
      </button>
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
        <aside className="workspace-aside">
          <div className="metrics" aria-label="工作区统计">
            <div>
              <span className="metric-label">未结束</span>
              <span className="metric-value">
                {snapshot.counts.unfinished.toString().padStart(2, "0")}
              </span>
            </div>
            <div>
              <span className="metric-label">可接回</span>
              <span className="metric-value">
                {snapshot.counts.paused.toString().padStart(2, "0")}
              </span>
            </div>
            <div>
              <span className="metric-label">等待中</span>
              <span className="metric-value">
                {snapshot.counts.waiting.toString().padStart(2, "0")}
              </span>
            </div>
          </div>
          <div className="review-card">
            <Sunset size={22} aria-hidden="true" />
            <div>
              <span className="eyebrow">给今天一个从容的句点</span>
              <h3>做完的放心放下，未完的留个入口。</h3>
              <p>整理今天的线索，选好下次开工的第一件事。</p>
            </div>
            <Button kind="secondary" onClick={() => setReviewOpen(true)}>
              开始收尾
            </Button>
          </div>
        </aside>
      </section>
      <footer className="workspace-footer">
        <span>PickUp / 接着</span>
        <span>记下新事，接回未完的事。</span>
      </footer>
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
          revision={snapshot.revision}
          onClose={() => setOverlay(null)}
          stacked={reviewOpen}
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
      {reviewOpen ? (
        <DailyReviewDialog
          onClose={() => setReviewOpen(false)}
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
