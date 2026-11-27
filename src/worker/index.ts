import { parentPort, workerData } from "node:worker_threads";
import type { Result } from "../shared/contracts";
import type {
  WorkerBootMessage,
  WorkerReplyValue,
  WorkerRequest,
  WorkerStartOptions,
} from "../shared/worker-protocol";
import { openStore, type Store } from "./database";
import { describeBootFailure, DomainError, toAppError } from "./errors";
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

  const sync = store.createSyncClient(() =>
    port.postMessage({ changed: store.revision() }),
  );
  sync.start();

  port.on("message", async (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      typeof (message as { requestId?: unknown }).requestId !== "number"
    )
      return;
    // 集成测试专用：模拟就绪后进程在应答前退出（没有 error 事件、不回复请求）。
    if (options.faults?.includes("request.exitBeforeReply")) {
      await sync.close();
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
        await sync.close();
        store.close();
        port.postMessage({
          requestId,
          result: { ok: true, value: null, revision },
        });
        port.close();
        return;
      }
      const revision = store.revision();
      switch (request.kind) {
        case "account":
          result = {
            ok: true,
            value: await sync.account(request.input),
            revision: store.revision(),
          };
          break;
        case "getNotionEncryptedToken":
          result = {
            ok: true,
            value: store.notion.getEncryptedToken(),
            revision,
          };
          break;
        case "notion": {
          const reply = await store.notion.handle(request.payload);
          const nextRevision = store.revision();
          if (nextRevision > revision) sync.localCommitted();
          result = {
            ok: true,
            value: reply,
            revision: nextRevision,
          };
          break;
        }
        case "pairWithPayload":
          throw DomainError.validation("请在手机上扫描桌面配对码。");
        case "enableSync":
          result = {
            ok: true,
            value: await sync.enable(request.input),
            revision: store.revision(),
          };
          break;
        case "disableSync":
          result = {
            ok: true,
            value: await sync.disable(),
            revision: store.revision(),
          };
          break;
        case "getSyncStatus":
          result = { ok: true, value: sync.status(), revision };
          break;
        case "syncNow":
          result = {
            ok: true,
            value: await sync.syncNow(),
            revision: store.revision(),
          };
          break;
        case "getPairingPayload":
          result = { ok: true, value: sync.pairing(), revision };
          break;
        default:
          result = dispatch(store, request);
          if (result.ok && result.revision > revision) sync.localCommitted();
      }
    } catch (error) {
      result = toAppError(error);
    }
    port.postMessage({ requestId, result });
  });

  // 集成测试专用：模拟数据库已打开、但 worker 在 ready 之前退出且没有 fatal/error 事件。
  if (options.faults?.includes("boot.exitBeforeReady")) {
    void sync.close().then(() => {
      store.close();
      port.close();
    });
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
