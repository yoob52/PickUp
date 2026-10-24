import type { ReactNode } from "react";
import logo from "../../../../docs/logo.png";
import {
  Archive,
  Clock3,
  Inbox,
  LayoutDashboard,
  Minus,
  PauseCircle,
  Plus,
  SlidersHorizontal,
  Square,
  Sunset,
  X,
} from "lucide-react";
import type { StatusCounts } from "../../../shared/task";
import { formatStamp } from "../lib/format";
import { Button, IconButton } from "../ui/primitives";
import { useToast } from "../ui/Toast";
import type { MainWindowAction } from "../../../shared/contracts";
import type { ListFilter } from "./TaskBoard";

type Props = {
  counts: StatusCounts;
  filter: ListFilter;
  connection: string;
  onFilter: (filter: ListFilter) => void;
  onCapture: () => void;
  onReview: () => void;
  onSettings: () => void;
  children: ReactNode;
};

export function AppShell({
  counts,
  filter,
  connection,
  onFilter,
  onCapture,
  onReview,
  onSettings,
  children,
}: Props) {
  const notify = useToast();

  async function controlWindow(action: MainWindowAction) {
    const result = await window.pickup.controlMainWindow(action);
    if (!result.ok) notify(result.message, "error");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src={logo} alt="" draggable={false} />
          <div>
            <div className="brand-name">接着 PickUp</div>
            <div className="brand-meta">记下新事，接回未完的事</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className="quiet-chip">{connection}</span>
          <span className="date-stamp">{formatStamp(Date.now())}</span>
          <Button icon={<Plus size={15} />} onClick={onCapture}>
            记一件事
          </Button>
          <IconButton label="打开设置" onClick={onSettings}>
            <SlidersHorizontal size={16} />
          </IconButton>
        </div>
        <div className="window-controls" role="group" aria-label="窗口控制">
          <button
            type="button"
            aria-label="最小化"
            onClick={() => void controlWindow("minimize")}
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="最大化或还原"
            onClick={() => void controlWindow("toggleMaximize")}
          >
            <Square size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="关闭主窗口"
            onClick={() => void controlWindow("close")}
          >
            <X size={16} aria-hidden="true" />
          </button>
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
              <button
                type="button"
                className="nav-item review-nav"
                onClick={onReview}
              >
                <span className="nav-left">
                  <Sunset size={16} />
                  今日收尾
                </span>
              </button>
            </nav>
          </div>
          <div className="sidebar-bottom">
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
        <main className="main">{children}</main>
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
      aria-current={active ? "page" : undefined}
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
