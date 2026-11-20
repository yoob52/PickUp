import { parentPort, workerData } from "node:worker_threads";
import type { Result } from "../shared/contracts";
import type {
  WorkerBootMessage,
  WorkerReplyValue,
  WorkerRequest,
  WorkerStartOptions,
} from "../shared/worker-protocol";
import { openStore, type Store } from "./database";
import { describeBootFailure, toAppError } from "./errors";
import { dispatch } from "./dispatch";

if (!parentPort) throw new Error("worker requires a parent port");

const port = parentPort!;

const options = workerData as WorkerStartOptions;
function start(): void {
  let store: Store;
  try {
    store = openStore(
      options.path,
      options.faults ? { faults: options.faults } : {},
    );
  } catch (error) {
    port.postMessage({
      fatal: true,
      code: "DB_UNAVAILABLE",
      message: describeBootFailure(error),
    } satisfies WorkerBootMessage);
    port.close();
    return;
  }

  port.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      typeof (message as { requestId?: unknown }).requestId !== "number"
    )
      return;
    // 集成测试专用：模拟就绪后进程在应答前退出（没有 error 事件、不回复请求）。
    if (options.faults?.includes("request.exitBeforeReply")) {
      store.close();
      port.close();
      return;
    }
    const { requestId, request } = message as {
      requestId: number;
      request: WorkerRequest;
    };
    let result: Result<WorkerReplyValue>;
    try {
      if (request.kind === "close") {
        const revision = store.revision();
        store.close();
        port.postMessage({
          requestId,
          result: { ok: true, value: null, revision },
        });
        port.close();
        return;
      }
      result = dispatch(store, request);
    } catch (error) {
      result = toAppError(error);
    }
    port.postMessage({ requestId, result });
  });

  // 集成测试专用：模拟数据库已打开、但 worker 在 ready 之前退出且没有 fatal/error 事件。
  if (options.faults?.includes("boot.exitBeforeReady")) {
    store.close();
    port.close();
    return;
  }

  port.postMessage({
    ready: true,
    sqliteVersion: store.sqliteVersion,
    schemaVersion: store.schemaVersion,
    backupPath: store.backupPath,
  } satisfies WorkerBootMessage);
}

start();
