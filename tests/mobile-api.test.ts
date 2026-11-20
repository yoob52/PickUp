import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileAPI } from "../src/mobile/api";
import { MobileWorkerClient } from "../src/mobile/client";
import { storeRegistry, type StoreSender } from "../src/shared/api-registry";
import type { Result } from "../src/shared/contracts";
import { localDayRangeUtc } from "../src/shared/local-date";
import type { WorkerRequest } from "../src/shared/worker-protocol";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const send = vi.fn(async (): Promise<Result<unknown>> => ({
    ok: true,
    value: null,
    revision: 7,
  }));
  return { send, ...createMobileAPI({ send } as StoreSender) };
}

describe("mobile API boundary", () => {
  it("keeps registration and exporting pairing codes desktop-only", async () => {
    const { api, send, dispose } = setup();
    try {
      for (const result of [
        await api.enableSync({
          serverUrl: "https://example.com",
          registrationToken: "x".repeat(40),
        }),
        await api.getPairingPayload(),
        await api.copyPairingPayload(),
      ])
        expect(result).toMatchObject({
          ok: false,
          code: "VALIDATION_ERROR",
          retryable: false,
        });
      expect(send).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
  it("wires joining, status, manual sync and disabling through the validated registry", async () => {
    const { api, send, dispose } = setup();
    try {
      expect(await api.pairWithPayload("")).toMatchObject({
        ok: false,
        code: "VALIDATION_ERROR",
      });
      expect(send).not.toHaveBeenCalled();
      await api.pairWithPayload(" pickup-sync:1:test ");
      expect(send).toHaveBeenLastCalledWith(
        { kind: "pairWithPayload", payload: "pickup-sync:1:test" },
        { timeoutMs: 120000 },
      );
      await api.getSyncStatus();
      expect(send).toHaveBeenLastCalledWith({ kind: "getSyncStatus" });
      await api.syncNow();
      expect(send).toHaveBeenLastCalledWith(
        { kind: "syncNow" },
        { timeoutMs: 120000 },
      );
      await api.disableSync();
      expect(send).toHaveBeenLastCalledWith({ kind: "disableSync" });
    } finally {
      dispose();
    }
  });
  it("exposes an immutable mobile host capability", () => {
    const { api, dispose } = setup();
    expect(api.host).toBe("mobile");
    expect(Object.getOwnPropertyDescriptor(api, "host")?.writable).toBe(false);
    dispose();
  });
  it("validates and normalizes inputs without sending invalid or empty data", async () => {
    const { api, send, dispose } = setup();
    try {
      const invalidMethods = [
        "listTasks",
        "getTaskDetail",
        "getCommandResult",
        "createTask",
        "updateTask",
        "startTask",
        "switchTask",
        "pauseTask",
        "markWaiting",
        "resolveWaiting",
        "completeTask",
        "cancelTask",
        "reopenTask",
        "saveBreakpoint",
        "setNextUp",
        "finishDailyReview",
        "saveDraft",
        "clearDraft",
        "updatePreference",
      ] as const;
      for (const name of invalidMethods) {
        const method = api[name] as (
          input: unknown,
        ) => Promise<Result<unknown>>;
        expect(await method({}), name).toMatchObject({
          ok: false,
          code: "VALIDATION_ERROR",
        });
        expect(await method(undefined), name).toMatchObject({
          ok: false,
          code: "VALIDATION_ERROR",
        });
      }
      expect(send).not.toHaveBeenCalled();
      const commandId = crypto.randomUUID();
      await api.createTask({ commandId, title: "  接续  ", note: " 保留 " });
      expect(send).toHaveBeenCalledWith({
        kind: "createTask",
        input: { commandId, title: "接续", note: " 保留 " },
      });
    } finally {
      dispose();
    }
  });

  it("computes the local daily range and rejects caller-supplied ranges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 6, 12));
    const { api, send, dispose } = setup();
    try {
      await api.getDailyReview();
      expect(send).toHaveBeenLastCalledWith({
        kind: "getDailyReview",
        input: {
          ...localDayRangeUtc(Date.now()),
          completedOffset: 0,
          completedLimit: 50,
        },
      });
      expect(await api.getDailyReview({ startUtc: 0 } as never)).toMatchObject({
        ok: false,
        code: "VALIDATION_ERROR",
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("notifies only successful broadcast commands and isolates listener failures", async () => {
    const { api, send, dispose } = setup();
    const changed = vi.fn();
    const stop = api.onStateChanged(changed);
    try {
      const input = { commandId: crypto.randomUUID(), title: "继续", note: "" };
      await api.createTask(input);
      expect(changed).toHaveBeenCalledWith(7);
      changed.mockClear();
      await api.getWorkspaceSnapshot();
      await api.saveDraft({ title: "草稿", note: "", expectedDraftVersion: 0 });
      expect(changed).not.toHaveBeenCalled();
      send.mockResolvedValueOnce({
        ok: false,
        code: "STORAGE_ERROR",
        message: "failed",
        retryable: true,
      });
      expect(await api.createTask(input)).toMatchObject({ ok: false });
      expect(changed).not.toHaveBeenCalled();
      stop();
      await api.createTask(input);
      expect(changed).not.toHaveBeenCalled();
      api.onStateChanged(() => {
        throw new Error("listener");
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await api.createTask(input)).toMatchObject({ ok: true });
      expect(error).toHaveBeenCalledWith("mobile-notification-failed");
      expect(
        storeRegistry
          .filter((entry) => entry.broadcast)
          .map((entry) => entry.channel),
      ).toHaveLength(13);
    } finally {
      dispose();
    }
  });

  it("rejects desktop operations and preferences without fake commits", async () => {
    const { api, send, dispose } = setup();
    try {
      for (const name of [
        "showMain",
        "controlMainWindow",
        "showCapture",
        "hideCapture",
        "hideWidget",
        "moveWidget",
        "setWidgetExpanded",
        "quit",
        "getDesktopState",
      ] as const) {
        expect(
          await (api[name] as () => Promise<Result<unknown>>)(),
        ).toMatchObject({
          ok: false,
          code: "VALIDATION_ERROR",
          retryable: false,
        });
      }
      for (const patch of [
        { launchAtLogin: true },
        { accelerator: "Control+N" },
        { widgetEnabled: true },
      ]) {
        expect(
          await api.updatePreference({ patch, expectedVersion: 0 }),
        ).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      }
      const listener = vi.fn();
      api.onCaptureShown(listener)();
      api.onPrepareClose(async () => {
        listener();
        return true;
      })();
      expect(listener).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("invalidates at midnight and on visibility after a missed day, with cleanup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 59));
    const { api, dispose } = setup();
    const listener = vi.fn();
    const stop = api.onDayInvalidated(listener);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 0, 3, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date(2026, 0, 4, 12));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(2);
    dispose();
  });
});

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

describe("mobile worker transport", () => {
  it("forwards remote state notifications and honors sync request timeouts", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new MobileWorkerClient(worker as unknown as Worker);
    const { api, dispose } = createMobileAPI(client);
    const listener = vi.fn();
    api.onStateChanged(listener);
    worker.emit({ ready: true });
    worker.emit({ changed: 9 });
    expect(listener).toHaveBeenCalledWith(9);
    const pending = api.syncNow();
    await vi.advanceTimersByTimeAsync(20000);
    const { requestId } = worker.postMessage.mock.calls[0][0];
    worker.emit({ requestId, result: { ok: true, value: null, revision: 9 } });
    expect(await pending).toMatchObject({ ok: true });
    dispose();
    worker.emit({ changed: 10 });
    expect(listener).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it("waits for readiness and correlates replies", async () => {
    const worker = new FakeWorker();
    const client = new MobileWorkerClient(worker as unknown as Worker);
    const pending = client.send({ kind: "getWorkspaceSnapshot" });
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.emit({ ready: true });
    await Promise.resolve();
    const { requestId } = worker.postMessage.mock.calls[0][0];
    const result = { ok: true, value: null, revision: 2 };
    worker.emit({ requestId, result });
    expect(await pending).toEqual(result);
    client.dispose();
  });

  it("reports startup failure and never sends queued or future requests", async () => {
    const worker = new FakeWorker();
    const client = new MobileWorkerClient(worker as unknown as Worker);
    const pending = client.send({ kind: "getWorkspaceSnapshot" });
    worker.emit({
      fatal: true,
      code: "DB_UNAVAILABLE",
      message: "OPFS unavailable",
    });
    expect(await pending).toMatchObject({
      ok: false,
      code: "DB_UNAVAILABLE",
      message: "OPFS unavailable",
    });
    expect(await client.send({ kind: "getDraft" })).toMatchObject({
      ok: false,
      code: "DB_UNAVAILABLE",
    });
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("bounds requests and reports uncertain outcomes after crashes", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new MobileWorkerClient(worker as unknown as Worker);
    worker.emit({ ready: true });
    const request: WorkerRequest = { kind: "getWorkspaceSnapshot" };
    const timed = client.send(request);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await timed).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    const crashed = client.send(request);
    await Promise.resolve();
    worker.onerror?.();
    expect(await crashed).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
    expect(await client.send(request)).toMatchObject({
      ok: false,
      code: "DB_UNAVAILABLE",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
