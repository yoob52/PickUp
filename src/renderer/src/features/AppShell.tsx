import type { ReactNode } from "react";
import {
  Archive,
  Clock3,
  Inbox,
  LayoutDashboard,
  PauseCircle,
  SlidersHorizontal,
  Sunset,
} from "lucide-react";
import type { StatusCounts } from "../../../shared/task";
import { formatStamp } from "../lib/format";
import { IconButton } from "../ui/primitives";
import type { ListFilter } from "./TaskBoard";

type Props = {
  counts: StatusCounts;
  filter: ListFilter;
  connection: string;
  onFilter: (filter: ListFilter) => void;
  onReview: () => void;
  onSettings: () => void;
  children: ReactNode;
};

export function AppShell({
  counts,
  filter,
  connection,
  onFilter,
  onReview,
  onSettings,
  children,
}: Props) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            接
          </div>
          <div>
            <div className="brand-name">接着 PickUp</div>
            <div className="brand-meta">记下新事，接回未完的事</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className="quiet-chip">{connection}</span>
          <span className="date-stamp">{formatStamp(Date.now())}</span>
          <IconButton label="打开设置" onClick={onSettings}>
            <SlidersHorizontal size={16} />
          </IconButton>
        </div>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <div>
            <div className="side-label">Workspace</div>
            <nav className="side-nav" aria-label="主导航">
              <NavItem
                icon={<LayoutDashboard size={16} />}
                label="工作台"
                count={counts.unfinished}
                active={filter === "unfinished"}
                onClick={() => onFilter("unfinished")}
              />
              <NavItem
                icon={<Inbox size={16} />}
                label="待处理"
                count={counts.todo}
                active={filter === "todo"}
                onClick={() => onFilter("todo")}
              />
              <NavItem
                icon={<PauseCircle size={16} />}
                label="已暂停"
                count={counts.paused}
                active={filter === "paused"}
                onClick={() => onFilter("paused")}
              />
              <NavItem
                icon={<Clock3 size={16} />}
                label="等待中"
                count={counts.waiting}
                active={filter === "waiting"}
                onClick={() => onFilter("waiting")}
              />
              <NavItem
                icon={<Archive size={16} />}
                label="已结束"
                count={counts.done + counts.cancelled}
                active={filter === "ended"}
                onClick={() => onFilter("ended")}
              />
            </nav>
          </div>
          <div className="sidebar-bottom">
            <button type="button" className="nav-item" onClick={onReview}>
              <span className="nav-left">
                <Sunset size={16} />
                今日收尾
              </span>
            </button>
            <div className="local-state">
              <div className="local-state-top">
                <span>Storage</span>
                <span>Offline first</span>
              </div>
              <strong>状态已在本机保存</strong>
            </div>
            <p className="sidebar-note">
              记下新事，接回未完的事。每一次暂停，都留一条回来的线。
            </p>
          </div>
        </aside>
        <div className="main">{children}</div>
      </div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "nav-item active" : "nav-item"}
      onClick={onClick}
    >
      <span className="nav-left">
        {icon}
        {label}
      </span>
      <span className="nav-count">{count}</span>
    </button>
  );
}
