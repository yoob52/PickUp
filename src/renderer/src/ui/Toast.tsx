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

type ToastState = { text: string; tone: Tone } | null;

const ToastContext = createContext<(text: string, tone?: Tone) => void>(
  () => {},
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);
  const timer = useRef<number>(0);
  const notify = useCallback((text: string, tone: Tone = "ok") => {
    setToast({ text, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        className={["toast", toast ? "show" : "", toast?.tone]
          .filter(Boolean)
          .join(" ")}
        role="status"
        aria-live="polite"
      >
        {toast?.text}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: Tone) => void {
  return useContext(ToastContext);
}
