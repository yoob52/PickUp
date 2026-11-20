import type { AppError, Result } from "../shared/contracts";
import type { StoreSender } from "../shared/api-registry";
import type {
  WorkerBootMessage,
  WorkerResponse,
  WorkerRequest,
} from "../shared/worker-protocol";

const unavailable = (message: string): AppError => ({
  ok: false,
  code: "DB_UNAVAILABLE",
  message,
  retryable: true,
});
const unknownOutcome: AppError = {
  ok: false,
  code: "OUTCOME_UNKNOWN",
  message:
    "数据库响应中断，提交结果尚不确定。请查询原命令回执或使用相同提交标识重试。",
  retryable: true,
};

export class MobileWorkerClient implements StoreSender {
  private sequence = 0;
  private failure: AppError | null = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: Result<unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly ready: Promise<void>;
  private settleReady!: () => void;
  private readonly bootTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly worker: Worker) {
    this.ready = new Promise((resolve) => {
      this.settleReady = resolve;
    });
    this.bootTimer = setTimeout(
      () => this.fail("数据库启动超时，未切换到内存存储。请重新加载后重试。"),
      60_000,
    );
    worker.onmessage = (
      event: MessageEvent<WorkerBootMessage | WorkerResponse>,
    ) => {
      const message = event.data;
      if ("fatal" in message) {
        this.fail(message.message);
        return;
      }
      if ("ready" in message) {
        clearTimeout(this.bootTimer);
        this.settleReady();
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.resolve(message.result);
    };
    worker.onerror = () =>
      this.fail("数据库工作线程异常退出，请重新加载。原数据未被重置。");
    worker.onmessageerror = () =>
      this.fail("无法读取数据库工作线程响应，请重新加载。");
  }

  private fail(message: string): void {
    if (this.failure) return;
    this.failure = unavailable(message);
    clearTimeout(this.bootTimer);
    this.settleReady();
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(unknownOutcome);
    }
    this.pending.clear();
    this.worker.terminate();
  }

  async send<T = unknown>(request: WorkerRequest): Promise<Result<T>> {
    await this.ready;
    if (this.failure) return this.failure;
    return new Promise<Result<T>>((resolve) => {
      const requestId = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(unknownOutcome);
      }, 10_000);
      this.pending.set(requestId, {
        resolve: (result) => resolve(result as Result<T>),
        timer,
      });
      try {
        this.worker.postMessage({ requestId, request });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(
          unavailable("请求未能发送到数据库工作线程，请重新加载后重试。"),
        );
      }
    });
  }

  dispose(): void {
    this.fail("数据库连接已关闭，请重新加载。");
  }
}
