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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
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
  }, [scheduleDismiss, toast]);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        ref={surface}
        className={[
          "toast",
          toast ? "show" : "",
          toast?.tone,
          toast?.action && "has-action",
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
              setToast(null);
              toast.action?.run();
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
