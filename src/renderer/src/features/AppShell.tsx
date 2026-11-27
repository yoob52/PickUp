import { useRef, type ReactNode } from "react";
import logo from "../../../../docs/logo.png";
import {
  Download,
  LayoutDashboard,
  Cloud,
  Minus,
  Plus,
  SlidersHorizontal,
  Square,
  Sunset,
  X,
} from "lucide-react";
import { formatStamp } from "../lib/format";
import { Button, IconButton } from "../ui/primitives";
import { useToast } from "../ui/Toast";
import type { MainWindowAction } from "../../../shared/contracts";
import { useUpdateControls } from "./UpdateControls";

type Props = {
  connection: string;
  onCapture: () => void;
  onReview: () => void;
  onSettings: () => void;
  onSync: () => void;
  onNotionImport?: () => void;
  notionConnected?: boolean;
  children: ReactNode;
};

export function AppShell({
  connection,
  onCapture,
  onReview,
  onSettings,
  onSync,
  onNotionImport,
  notionConnected,
  children,
}: Props) {
  const notify = useToast();
  const mobile = window.pickup.host === "mobile";
  const mainRef = useRef<HTMLElement>(null);
  const updates = useUpdateControls();

  async function controlWindow(action: MainWindowAction) {
    const result = await window.pickup.controlMainWindow(action);
    if (!result.ok) notify(result.message, "error");
  }

  if (mobile) {
    return (
      <div className="app-shell mobile-shell">
        <div>
          <header className="mobile-header">
            <img src={logo} alt="" draggable={false} />
            <span>接着 PickUp</span>
            <div className="mobile-header-actions">
              {updates.buttons}
              <IconButton label="打开同步" onClick={onSync}>
                <Cloud size={20} />
              </IconButton>
            </div>
          </header>
          {updates.notice}
        </div>
        <main className="main" ref={mainRef}>
          {children}
        </main>
        <nav className="mobile-bottom-nav" aria-label="手机导航">
          <button
            type="button"
            aria-current="page"
            onClick={() => mainRef.current?.scrollTo({ top: 0 })}
          >
            <LayoutDashboard size={22} aria-hidden="true" />
            <span>工作台</span>
          </button>
          <button type="button" className="mobile-capture" onClick={onCapture}>
            <Plus size={22} aria-hidden="true" />
            <span>记一件事</span>
          </button>
          <button type="button" onClick={onReview}>
            <Sunset size={22} aria-hidden="true" />
            <span>今日收尾</span>
          </button>
        </nav>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div>
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
            {onNotionImport ? (
              <Button
                kind="secondary"
                icon={<Download size={14} />}
                onClick={onNotionImport}
              >
                Notion 导入
              </Button>
            ) : null}
            <Button icon={<Plus size={15} />} onClick={onCapture}>
              记一件事
            </Button>
            {updates.buttons}
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
        {updates.notice}
      </div>
      <div className="layout">
        <aside className="sidebar">
          <div>
            <div className="side-label">工作区</div>
            <nav className="side-nav" aria-label="主导航">
              <button
                type="button"
                className="nav-item active"
                aria-current="page"
                onClick={() => mainRef.current?.scrollTo({ top: 0 })}
              >
                <span className="nav-left">
                  <LayoutDashboard size={16} />
                  工作台
                </span>
              </button>
              <button type="button" className="nav-item" onClick={onReview}>
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
                <span>本地存储</span>
                <span>离线优先</span>
              </div>
              <strong>状态已在本机保存</strong>
              {notionConnected ? (
                <button
                  type="button"
                  className="notion-status-chip"
                  onClick={onSettings}
                >
                  <span className="notion-status-dot" aria-hidden="true" />
                  <span>Notion 已连接 · 配置</span>
                </button>
              ) : null}
            </div>
            <p className="sidebar-note">
              记下新事，接回未完的事。每一次暂停，都留一条回来的线。
            </p>
          </div>
        </aside>
        <main className="main" ref={mainRef}>
          {children}
        </main>
      </div>
    </div>
  );
}
