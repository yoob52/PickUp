import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "./database";
import type { Request, Result } from "../shared/contracts";
const port = parentPort!;
try {
  const store = openDatabase(workerData.path as string);
  port.on(
    "message",
    ({ requestId, request }: { requestId: number; request: Request }) => {
      let result: Result<unknown>;
      try {
        if (request.kind === "close") {
          store.close();
          port.postMessage({
            requestId,
            result: { ok: true, value: null, revision: 0 },
          });
          port.close();
          return;
        }
        if (request.kind === "create") {
          const saved = store.create(request.input);
          result = { ok: true, ...saved };
        } else {
          const value = store.snapshot();
          result = { ok: true, value, revision: value.revision };
        }
      } catch (error) {
        const reused =
          error instanceof Error && error.message === "COMMAND_ID_REUSED";
        result = {
          ok: false,
          code: reused ? "COMMAND_ID_REUSED" : "STORAGE_ERROR",
          message: reused
            ? "提交标识已用于其他内容，请重新提交。"
            : "数据未保存，请保留输入后重试。",
        };
      }
      port.postMessage({ requestId, result });
    },
  );
  port.postMessage({ ready: true, sqliteVersion: store.sqliteVersion });
} catch {
  port.postMessage({ fatal: true });
  port.close();
}
