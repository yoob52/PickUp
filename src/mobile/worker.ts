import type { Result } from "../shared/contracts";
import type {
  WorkerBootMessage,
  WorkerRequest,
  WorkerReplyValue,
  WorkerResponse,
} from "../shared/worker-protocol";
import { dispatch } from "../worker/dispatch";
import { describeBootFailure, DomainError, toAppError } from "../worker/errors";
import { pairingInputSchema } from "../shared/sync-contracts";
import { openMobileStore } from "./database";

const scope = globalThis as unknown as {
  postMessage(
    message: WorkerBootMessage | WorkerResponse | { changed: number },
  ): void;
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
  const sync = store.createSyncClient(() =>
    scope.postMessage({ changed: store.revision() }),
  );
  await sync.setActive(false);
  scope.onmessage = async (event: MessageEvent<unknown>) => {
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
        await sync.close();
        store.close();
        scope.postMessage({
          requestId,
          result: { ok: true, value: null, revision },
        } satisfies WorkerResponse);
        scope.close();
        return;
      }
      const revision = store.revision();
      let value: WorkerReplyValue;
      switch (request?.kind) {
        case "account":
          value = await sync.account(request.input);
          break;
        case "setSyncForeground":
          if (typeof request.visible !== "boolean")
            throw DomainError.validation("前台状态无效。");
          await sync.setActive(request.visible);
          value = null;
          break;
        case "pairWithPayload":
          if (!pairingInputSchema.safeParse(request.payload).success)
            throw DomainError.validation("配对码格式无效。");
          value = await sync.pair(request.payload.trim());
          break;
        case "getSyncStatus":
          value = sync.status();
          break;
        case "syncNow":
          value = await sync.syncNow();
          break;
        case "disableSync":
          value = await sync.disable();
          break;
        case "enableSync":
        case "getPairingPayload":
          throw DomainError.validation("手机只能通过桌面配对码加入同步。");
        default:
          result = dispatch(
            store,
            request ?? ({ kind: "unknown" } as unknown as WorkerRequest),
          );
          if (result.ok && result.revision > revision) sync.localCommitted();
          scope.postMessage({ requestId, result });
          return;
      }
      result = { ok: true, value, revision: store.revision() };
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
