import { Worker } from "node:worker_threads";
import workerPath from "../worker/index?modulePath";
import type { Request, Result } from "../shared/contracts";
export class StoreClient {
  private worker: Worker;
  private sequence = 0;
  private failed = false;
  sqliteVersion = "";
  private pending = new Map<number, (value: Result<unknown>) => void>();
  readonly ready: Promise<void>;
  constructor(path: string) {
    this.worker = new Worker(workerPath, { workerData: { path } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (message) => {
        if (message.ready) {
          this.sqliteVersion = message.sqliteVersion;
          resolve();
        } else if (message.fatal) {
          this.fail();
          reject(new Error("Database initialization failed"));
        } else {
          this.pending.get(message.requestId)?.(message.result);
          this.pending.delete(message.requestId);
        }
      });
      this.worker.on("error", () => {
        this.fail();
        reject(new Error("Database worker failed"));
      });
      this.worker.on("exit", () => {
        this.fail();
        reject(new Error("Database worker exited"));
      });
    });
  }
  private fail() {
    this.failed = true;
    for (const resolve of this.pending.values())
      resolve({
        ok: false,
        code: "OUTCOME_UNKNOWN",
        message: "保存结果待确认，请保留输入并重启后重试。",
      });
    this.pending.clear();
  }
  async send<T>(request: Request): Promise<Result<T>> {
    await this.ready;
    if (this.failed)
      return {
        ok: false,
        code: "DB_UNAVAILABLE",
        message: "数据库当前不可用，请重启应用。",
      };
    return new Promise((resolve) => {
      const requestId = ++this.sequence;
      this.pending.set(requestId, resolve as (value: Result<unknown>) => void);
      this.worker.postMessage({ requestId, request });
    });
  }
  async close() {
    if (!this.failed) await this.send({ kind: "close" });
  }
}
