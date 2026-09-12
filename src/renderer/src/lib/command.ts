import type {
  AppError,
  BreakpointDraft,
  Result,
  TaskRef,
  TaskSummary,
} from "../../../shared/contracts";

export function taskRef(task: Pick<TaskSummary, "id" | "version">): TaskRef {
  return { taskId: task.id, expectedVersion: task.version };
}

export function newCommandId(): string {
  return crypto.randomUUID();
}

export function emptyBreakpoint(): BreakpointDraft {
  return { progress: "", nextStep: "", referenceText: "" };
}

export function isBlankBreakpoint(draft: BreakpointDraft): boolean {
  return (
    !draft.progress.trim() &&
    !draft.nextStep.trim() &&
    !draft.referenceText.trim()
  );
}

export function optionalBreakpoint(
  draft: BreakpointDraft,
): BreakpointDraft | undefined {
  return isBlankBreakpoint(draft) ? undefined : draft;
}

export type PendingCommand<T> = {
  take(make: (commandId: string) => T, same: (current: T) => boolean): T;
  peek(): T | null;
  clear(): void;
};

export function createPending<T>(): PendingCommand<T> {
  let current: T | null = null;
  return {
    take(make, same) {
      if (!current || !same(current)) current = make(newCommandId());
      return current;
    },
    peek() {
      return current;
    },
    clear() {
      current = null;
    },
  };
}

const UNKNOWN: AppError = {
  ok: false,
  code: "OUTCOME_UNKNOWN",
  message: "保存结果待确认，请保留内容并重试。",
  retryable: true,
};

export async function invokeCommand<T>(
  commandId: string,
  send: () => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    const result = await send();
    if (result.ok || result.code !== "OUTCOME_UNKNOWN") return result;
    return recover(commandId, send, result);
  } catch {
    return recover(commandId, send, UNKNOWN);
  }
}

async function recover<T>(
  commandId: string,
  send: () => Promise<Result<T>>,
  original: AppError,
): Promise<Result<T>> {
  try {
    const outcome = await window.pickup.getCommandResult({ commandId });
    if (outcome.ok && outcome.value.status === "committed") {
      return {
        ok: true,
        value: outcome.value.value as T,
        revision: outcome.value.revision,
      };
    }
    if (!outcome.ok && outcome.code === "DB_UNAVAILABLE") return outcome;
    if (
      original.retryable &&
      outcome.ok &&
      outcome.value.status === "unknown"
    ) {
      const retry = await send();
      if (retry.ok || retry.code !== "OUTCOME_UNKNOWN") return retry;
    }
    return original;
  } catch {
    return original;
  }
}
