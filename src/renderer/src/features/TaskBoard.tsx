import { useMemo } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import type { Page, TaskSummary } from "../../../shared/contracts";
import type { TaskStatus } from "../../../shared/task";
import { TASK_STATUS_LABEL } from "../../../shared/task";
import { nextStepText } from "../lib/format";
import {
  EmptyState,
  IconButton,
  StatusDot,
  StatusMark,
} from "../ui/primitives";

export type ListFilter = "unfinished" | "todo" | "paused" | "waiting" | "ended";

type Props = {
  filter: ListFilter;
  unfinished: TaskSummary[];
  ended: Page<TaskSummary> | null;
  endedLoading: boolean;
  onFilter: (filter: ListFilter) => void;
  onOpen: (task: TaskSummary) => void;
  onStart: (task: TaskSummary) => void;
  onLoadMore: () => void;
};

const FILTERS: { id: ListFilter; label: string }[] = [
  { id: "unfinished", label: "未结束" },
  { id: "todo", label: "待处理" },
  { id: "paused", label: "暂停" },
  { id: "waiting", label: "等待" },
  { id: "ended", label: "已结束" },
];

export function TaskBoard({
  filter,
  unfinished,
  ended,
  endedLoading,
  onFilter,
  onOpen,
  onStart,
  onLoadMore,
}: Props) {
  const items = useMemo(() => {
    if (filter === "ended") return ended?.items ?? [];
    if (filter === "unfinished") return unfinished;
    return unfinished.filter((task) => task.status === filter);
  }, [ended, filter, unfinished]);

  const meta =
    filter === "ended"
      ? ended
        ? `${ended.items.length} / ${ended.total} 条已结束`
        : "正在读取已结束事项"
      : `${items.length} 条记录 / ${labelOf(filter)}`;

  return (
    <article className="task-board">
      <div className="section-head">
        <div>
          <h3>所有线程</h3>
          <span className="section-meta">{meta}</span>
        </div>
        <div className="filter-tabs" role="tablist" aria-label="任务筛选">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={
                filter === item.id ? "filter-tab active" : "filter-tab"
              }
              onClick={() => onFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="task-list">
        {items.length === 0 ? (
          <EmptyState>
            {endedLoading
              ? "正在读取列表…"
              : "这里暂时没有记录。先记下一件新事。"}
          </EmptyState>
        ) : (
          items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onOpen={() => onOpen(task)}
              onStart={() => onStart(task)}
            />
          ))
        )}
      </div>
      {filter === "ended" && ended?.hasMore ? (
        <button type="button" className="load-more" onClick={onLoadMore}>
          加载更多（还有 {ended.total - ended.items.length} 条，不是全部）
        </button>
      ) : null}
    </article>
  );
}

function TaskRow({
  task,
  onOpen,
  onStart,
}: {
  task: TaskSummary;
  onOpen: () => void;
  onStart: () => void;
}) {
  const sub =
    task.status === "waiting"
      ? task.waitReason || "等待条件"
      : nextStepText(task) || task.note || "尚未留下说明";
  const startable =
    task.status === "todo" ||
    task.status === "paused" ||
    task.status === "waiting";

  return (
    <article
      className="task-row"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <StatusDot status={task.status} />
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        <div className="task-sub">{sub}</div>
      </div>
      <div className="row-actions">
        <IconButton
          label="打开详情"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <ArrowUpRight size={14} />
        </IconButton>
        {startable ? (
          <IconButton
            label="开始或继续"
            onClick={(event) => {
              event.stopPropagation();
              onStart();
            }}
          >
            <Play size={14} />
          </IconButton>
        ) : null}
      </div>
      <StatusMark status={task.status} />
    </article>
  );
}

function labelOf(filter: ListFilter): string {
  if (filter === "unfinished") return "当前工作区";
  if (filter === "ended") return "已结束";
  return TASK_STATUS_LABEL[filter as TaskStatus];
}
