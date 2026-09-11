import { Worker } from "node:worker_threads";
import workerPath from "../worker/index?modulePath";
import type { AppError, Result } from "../shared/contracts";
import type {
  WorkerBootMessage,
  WorkerFaultStage,
  WorkerRequest,
  WorkerResponse,
} from "../shared/worker-protocol";

/** 单次 worker 请求的上界；超时不等于回滚，返回 OUTCOME_UNKNOWN 供调用方查回执。 */
const REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

const DB_UNAVAILABLE: AppError = {
  ok: false,
  code: "DB_UNAVAILABLE",
  message: "数据库当前不可用，请重启应用；未确认保存的输入请先保留。",
  retryable: true,
};

const OUTCOME_UNKNOWN: AppError = {
  ok: false,
  code: "OUTCOME_UNKNOWN",
  message: "保存结果待确认。请用同一提交查询结果或原样重试，不要重复新建。",
  retryable: true,
};

export type StoreClientOptions = {
  faults?: WorkerFaultStage[];
  requestTimeoutMs?: number;
};

type Pending = {
  resolve: (value: Result<unknown>) => void;
  timer: NodeJS.Timeout;
};

export class StoreClient {
  private readonly worker: Worker;
  private readonly requestTimeoutMs: number;
  private sequence = 0;
  private state: "starting" | "ready" | "fatal" | "stopped" = "starting";
  private bootFailure: AppError | null = null;
  private closing = false;
  private exited = false;
  private readySettled = false;
  private readonly pending = new Map<number, Pending>();
  readonly ready: Promise<void>;
  sqliteVersion = "";
  schemaVersion = 0;
  backupPath: string | null = null;

  constructor(path: string, options: StoreClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.worker = new Worker(workerPath, {
      workerData: options.faults ? { path, faults: options.faults } : { path },
    });
    this.ready = new Promise<void>((resolve, reject) => {
      /**
       * 初始化 Promise 只结算一次：ready 消息、启动失败、ready 前退出（含连接报错、
       * 正常关闭）都必须结束它，否则 await ready 的 send() 会永久挂起。
       */
      const settleReady = (error: Error | null): void => {
        if (this.readySettled) return;
        this.readySettled = true;
        if (error) reject(error);
        else resolve();
      };
      this.worker.on(
        "message",
        (message: WorkerBootMessage | WorkerResponse) => {
          if ("ready" in message && message.ready) {
            this.sqliteVersion = message.sqliteVersion;
            this.schemaVersion = message.schemaVersion;
            this.backupPath = message.backupPath;
            this.state = "ready";
            settleReady(null);
            return;
          }
          if ("fatal" in message && message.fatal) {
            this.state = "fatal";
            this.bootFailure = {
              ok: false,
              code: message.code,
              message: message.message,
              retryable: false,
            };
            this.settleAll(this.bootFailure);
            settleReady(new Error("database unavailable"));
            return;
          }
          this.handleResponse(message as WorkerResponse);
        },
      );
      this.worker.on("error", () => {
        this.stop("数据库进程异常退出，已停止接受新的写入，请重启应用。");
        settleReady(new Error("database worker failed"));
      });
      this.worker.on("exit", (code) => {
        this.exited = true;
        if (this.closing && code === 0) {
          // 正常关闭：已提交结果与 bootFailure 语义保持不变，只结束尚未结算的初始化等待。
          settleReady(new Error("database worker closed before ready"));
          return;
        }
        this.stop("数据库进程已退出，请重启应用后再继续。");
        settleReady(new Error("database worker exited before ready"));
      });
    });
  }

  /** 启动失败时的诊断信息；main 用它展示恢复错误页而不是空白成功状态。 */
  get failure(): AppError | null {
    return this.bootFailure;
  }

  private handleResponse(message: WorkerResponse): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    this.pending.delete(message.requestId);
    clearTimeout(entry.timer);
    entry.resolve(message.result as Result<unknown>);
  }

  private settleAll(error: AppError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(error);
    }
    this.pending.clear();
  }

  private stop(message: string): void {
    if (this.state === "ready" || this.state === "starting")
      this.state = "stopped";
    // 启动失败已带有诊断信息时不覆盖，避免丢失具体原因。
    this.bootFailure ??= {
      ok: false,
      code: "DB_UNAVAILABLE",
      message,
      retryable: true,
    };
    this.settleAll(OUTCOME_UNKNOWN);
  }

  private unavailable(): AppError {
    return this.bootFailure ?? DB_UNAVAILABLE;
  }

  async send<T>(
    request: WorkerRequest,
    options: { timeoutMs?: number } = {},
  ): Promise<Result<T>> {
    try {
      await this.ready;
    } catch {
      return this.unavailable() as Result<T>;
    }
    if (this.state !== "ready") return this.unavailable() as Result<T>;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<Result<T>>((resolve) => {
      const requestId = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(OUTCOME_UNKNOWN as Result<T>);
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as (value: Result<unknown>) => void,
        timer,
      });
      this.worker.postMessage({ requestId, request });
    });
  }

  /** 等待已接收命令完成并关闭连接；worker 不退出时终止线程，避免阻塞退出。 */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.exited) {
      this.state = "stopped";
      return;
    }
    const exited = new Promise<void>((resolve) => {
      if (this.exited) resolve();
      else this.worker.once("exit", () => resolve());
    });
    if (this.state === "ready")
      await this.send({ kind: "close" }, { timeoutMs: CLOSE_TIMEOUT_MS });
    const terminated = setTimeout(
      () => void this.worker.terminate(),
      CLOSE_TIMEOUT_MS,
    );
    await exited;
    clearTimeout(terminated);
    this.state = "stopped";
  }
}
