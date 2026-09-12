import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AppError, WorkspaceSnapshot } from "../../../shared/contracts";
import { emptyWorkspaceSnapshot } from "../../../shared/task";

export type WorkspacePhase = "loading" | "ready" | "unavailable";

export type WorkspaceState = {
  snapshot: WorkspaceSnapshot;
  phase: WorkspacePhase;
  error: AppError | null;
  notice: string | null;
  refresh: () => Promise<boolean>;
};

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(emptyWorkspaceSnapshot);
  const [phase, setPhase] = useState<WorkspacePhase>("loading");
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const revision = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const result = await window.pickup.getWorkspaceSnapshot();
      if (seq !== sequence.current) return false;
      if (!result.ok) {
        if (result.code === "DB_UNAVAILABLE") {
          setPhase("unavailable");
          setError(result);
          setNotice(null);
          return false;
        }
        setNotice(result.message);
        if (phaseRef.current === "loading") setPhase("ready");
        return false;
      }
      if (result.revision < revision.current) return true;
      revision.current = result.revision;
      setSnapshot(result.value);
      setPhase("ready");
      setError(null);
      setNotice(null);
      return true;
    } catch {
      if (seq !== sequence.current) return false;
      setNotice("读取失败，请重新打开应用或稍后刷新。");
      if (phaseRef.current === "loading") setPhase("ready");
      return false;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.pickup.onStateChanged((next) => {
      if (next >= revision.current) void refresh();
    });
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ snapshot, phase, error, notice, refresh }),
    [snapshot, phase, error, notice, refresh],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceProvider is required");
  return value;
}
