import type { Result } from "../shared/contracts";
import type {
  WorkerBootMessage,
  WorkerRequest,
  WorkerReplyValue,
  WorkerResponse,
} from "../shared/worker-protocol";
import { dispatch } from "../worker/dispatch";
import { describeBootFailure, toAppError } from "../worker/errors";
import { openMobileStore } from "./database";

const scope = globalThis as unknown as {
  postMessage(message: WorkerBootMessage | WorkerResponse): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close(): void;
};

async function start(): Promise<void> {
  let store: Awaited<ReturnType<typeof openMobileStore>>;
  try {
    store = await openMobileStore();
  } catch (error) {
    scope.postMessage({
      fatal: true,
      code: "DB_UNAVAILABLE",
      message: `${describeBootFailure(error)} 请确认浏览器支持 OPFS，且没有其他标签页占用数据库；关闭其他标签页后重试。未切换到内存存储。`,
    } satisfies WorkerBootMessage);
    scope.close();
    return;
  }
  scope.onmessage = (event: MessageEvent<unknown>) => {
    if (
      !event.data ||
      typeof event.data !== "object" ||
      typeof (event.data as { requestId?: unknown }).requestId !== "number"
    )
      return;
    const { requestId, request } = event.data as {
      requestId: number;
      request: WorkerRequest;
    };
    let result: Result<WorkerReplyValue>;
    try {
      if (request?.kind === "close") {
        const revision = store.revision();
        store.close();
        scope.postMessage({
          requestId,
          result: { ok: true, value: null, revision },
        } satisfies WorkerResponse);
        scope.close();
        return;
      }
      result = dispatch(
        store,
        request ?? ({ kind: "unknown" } as unknown as WorkerRequest),
      );
    } catch (error) {
      result = toAppError(error);
    }
    scope.postMessage({ requestId, result } satisfies WorkerResponse);
  };
  scope.postMessage({
    ready: true,
    sqliteVersion: store.sqliteVersion,
    schemaVersion: store.schemaVersion,
    backupPath: store.backupPath,
  } satisfies WorkerBootMessage);
}

void start();
