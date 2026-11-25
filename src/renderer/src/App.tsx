import { useEffect } from "react";
import { getWindowKind } from "./window-kind";
import { WorkspaceProvider } from "./state/workspace";
import { ToastProvider } from "./ui/Toast";
import { CaptureApp } from "./views/CaptureApp";
import { MainApp } from "./views/MainApp";
import { WidgetApp } from "./views/WidgetApp";

export function App() {
  const mobile = window.pickup.host === "mobile";
  const kind = mobile ? "main" : getWindowKind();
  document.documentElement.dataset.window = kind;
  document.documentElement.dataset.host = window.pickup.host;
  useEffect(() => {
    if (!mobile) return;
    const viewport = window.visualViewport;
    function resize() {
      document.documentElement.style.setProperty(
        "--mobile-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--mobile-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
      document.documentElement.toggleAttribute(
        "data-keyboard",
        window.innerHeight - (viewport?.height ?? window.innerHeight) > 100,
      );
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      )
        active.scrollIntoView({ block: "nearest" });
    }
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      document.documentElement.style.removeProperty("--mobile-height");
      document.documentElement.style.removeProperty("--mobile-top");
      document.documentElement.removeAttribute("data-keyboard");
    };
  }, [mobile]);
  return (
    <WorkspaceProvider>
      <ToastProvider>
        {kind === "capture" ? (
          <>
            <header className="capture-titlebar">PickUp / 快速记录</header>
            <CaptureApp />
          </>
        ) : kind === "widget" ? (
          <WidgetApp />
        ) : (
          <MainApp />
        )}
      </ToastProvider>
    </WorkspaceProvider>
  );
}
