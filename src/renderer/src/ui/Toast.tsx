import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Tone = "ok" | "error";

export type ToastAction = { label: string; run: () => void };

type ToastState = { text: string; tone: Tone; action?: ToastAction };
type Notify = (text: string, tone?: Tone, action?: ToastAction) => void;

const ToastContext = createContext<Notify>(() => {});
const ActionTargetContext = createContext<{
  register: (target: HTMLDivElement | null) => void;
  content: ReactNode;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [actionTarget, setActionTarget] = useState<HTMLDivElement | null>(null);
  const inDialog = Boolean(actionTarget && toast?.action);
  const timer = useRef<number>(0);
  const surface = useRef<HTMLDivElement>(null);
  const scheduleDismiss = useCallback((actionable: boolean) => {
    window.clearTimeout(timer.current);
    if (actionable && surface.current?.matches(":hover, :focus-within")) return;
    timer.current = window.setTimeout(
      () => setToast(null),
      actionable ? 10_000 : 3200,
    );
  }, []);
  const notify = useCallback<Notify>((text, tone = "ok", action) => {
    setToast({ text, tone, action });
  }, []);
  useEffect(() => {
    if (!toast) return;
    scheduleDismiss(Boolean(toast.action));
    return () => window.clearTimeout(timer.current);
  }, [inDialog, scheduleDismiss, toast]);

  const content = (
    <div
      ref={surface}
      className={[
        "toast",
        toast ? "show" : "",
        toast?.tone,
        toast?.action && "has-action",
        inDialog && "in-dialog",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerEnter={
        toast?.action ? () => window.clearTimeout(timer.current) : undefined
      }
      onPointerLeave={toast?.action ? () => scheduleDismiss(true) : undefined}
      onFocus={
        toast?.action ? () => window.clearTimeout(timer.current) : undefined
      }
      onBlur={toast?.action ? () => scheduleDismiss(true) : undefined}
    >
      <span role="status">{toast?.text}</span>
      {toast?.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            if (inDialog) actionTarget?.focus();
            setToast(null);
            toast.action?.run();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );

  return (
    <ToastContext.Provider value={notify}>
      <ActionTargetContext.Provider
        value={{
          register: setActionTarget,
          content: inDialog ? content : null,
        }}
      >
        {children}
      </ActionTargetContext.Provider>
      {!inDialog ? content : null}
    </ToastContext.Provider>
  );
}

export function ToastActionTarget() {
  const target = useContext(ActionTargetContext);
  return (
    <div ref={target?.register} tabIndex={-1} className="toast-action-target">
      {target?.content}
    </div>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
