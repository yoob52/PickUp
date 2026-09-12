import { getWindowKind } from "./window-kind";
import { WorkspaceProvider } from "./state/workspace";
import { ToastProvider } from "./ui/Toast";
import { CaptureApp } from "./views/CaptureApp";
import { MainApp } from "./views/MainApp";
import { WidgetApp } from "./views/WidgetApp";

export function App() {
  const kind = getWindowKind();
  document.documentElement.dataset.window = kind;
  return (
    <WorkspaceProvider>
      <ToastProvider>
        {kind === "capture" ? (
          <CaptureApp />
        ) : kind === "widget" ? (
          <WidgetApp />
        ) : (
          <MainApp />
        )}
      </ToastProvider>
    </WorkspaceProvider>
  );
}
