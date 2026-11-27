import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PickupAPI, WindowAction } from "../src/shared/contracts";
import type { StoreClient } from "../src/main/worker-client";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handle: vi.fn(),
  send: vi.fn(),
  writeText: vi.fn(),
  fromWebContents: vi.fn().mockReturnValue(null),
  exposed: undefined as unknown,
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  clipboard: { writeText: mocks.writeText },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
  BrowserWindow: {
    fromWebContents: mocks.fromWebContents,
    getAllWindows: () => [],
  },
  ipcMain: { handle: mocks.handle },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: vi.fn(),
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      mocks.listeners.set(channel, handler);
    },
    removeListener: (channel: string) => {
      mocks.listeners.delete(channel);
    },
  },
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      if (key === "pickup") mocks.exposed = api;
    },
  },
}));

import "../src/preload/index";
import { registerIpcHandlers, registeredChannels } from "../src/main/ipc";

function api(): PickupAPI {
  return mocks.exposed as PickupAPI;
}

/** 调用每个 preload 方法，收集它实际使用的 channel。 */
function collectChannels(): string[] {
  const channels = new Set<string>();
  for (const [name, value] of Object.entries(api())) {
    if (name.startsWith("on") || typeof value !== "function") continue;
    mocks.invoke.mockClear();
    (value as (input: unknown) => unknown)(undefined);
    expect(mocks.invoke, `${name} 必须调用单一 channel`).toHaveBeenCalledTimes(
      1,
    );
    channels.add(mocks.invoke.mock.calls[0][0] as string);
  }
  return [...channels].sort();
}

beforeAll(() => {
  const send = mocks.send;
  const windowOk = async (action: WindowAction) => ({
    ok: true as const,
    value: { type: "window" as const, action },
    revision: 0,
  });
  registerIpcHandlers(
    { send, onStateChanged: vi.fn() } as unknown as StoreClient,
    {
      start: async () => undefined,
      isQuitting: () => false,
      showMain: () => windowOk("showMain"),
      controlMainWindow: (action) => windowOk(action),
      showCapture: () => windowOk("showCapture"),
      hideCapture: () => windowOk("hideCapture"),
      hideWidget: () => windowOk("hideWidget"),
      moveWidget: async () => ({ ok: true, value: true, revision: 0 }),
      setWidgetExpanded: async (expanded) => ({
        ok: true,
        value: expanded,
        revision: 0,
      }),
      quit: () => windowOk("quit"),
      getDesktopState: async () => ({
        ok: true,
        revision: 0,
        value: {
          accelerator: "Control+Alt+N",
          acceleratorRegistered: true,
          launchAtLogin: false,
          launchAtLoginApplied: true,
          widgetVisible: false,
        },
      }),
      applyPreferencePatch: async (input) =>
        send({ kind: "updatePreference", input }),
    },
  );
});

describe("IPC 契约一致性", () => {
  it("copies only the worker's active login request and reports missing requests and clipboard failures", async () => {
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === "pickup:copyLoginPayload",
    )![1];
    const frame = { url: "pickup://app/index.html" },
      event = { sender: { mainFrame: frame }, senderFrame: frame };
    mocks.fromWebContents.mockReturnValue({});
    mocks.writeText.mockClear();
    try {
      expect(await handler(event, "arbitrary content")).toMatchObject({
        ok: false,
        code: "VALIDATION_ERROR",
      });
      mocks.send.mockResolvedValueOnce({
        ok: false,
        code: "VALIDATION_ERROR",
        message: "登录码已过期",
        retryable: false,
      });
      expect(await handler(event)).toMatchObject({
        ok: false,
        code: "VALIDATION_ERROR",
      });
      mocks.send.mockResolvedValueOnce({
        ok: true,
        value: { status: {} },
        revision: 2,
      });
      expect(await handler(event)).toMatchObject({
        ok: false,
        code: "VALIDATION_ERROR",
      });
      expect(mocks.writeText).not.toHaveBeenCalled();
      mocks.send.mockResolvedValue({
        ok: true,
        value: { qrPayload: "pickup-login:1:test" },
        revision: 2,
      });
      expect(await handler(event)).toEqual({
        ok: true,
        value: null,
        revision: 2,
      });
      expect(mocks.send).toHaveBeenLastCalledWith({
        kind: "account",
        input: { action: "getHandoffPayload" },
      });
      expect(mocks.writeText).toHaveBeenLastCalledWith("pickup-login:1:test");
      mocks.writeText.mockImplementationOnce(() => {
        throw new Error("clipboard unavailable");
      });
      expect(await handler(event)).toMatchObject({
        ok: false,
        code: "SYSTEM_SETTING_ERROR",
      });
    } finally {
      mocks.fromWebContents.mockReturnValue(null);
      mocks.writeText.mockClear();
    }
  });
  it("copies only the worker's pairing code through a trusted fixed API and reports clipboard failures", async () => {
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === "pickup:copyPairingPayload",
    )![1];
    const frame = { url: "pickup://app/index.html" };
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    mocks.fromWebContents.mockReturnValue({});
    try {
      expect(await handler(event, "arbitrary clipboard content")).toMatchObject(
        { ok: false, code: "VALIDATION_ERROR" },
      );
      expect(mocks.writeText).not.toHaveBeenCalled();
      mocks.send.mockResolvedValueOnce({
        ok: false,
        code: "VALIDATION_ERROR",
        message: "请先启用同步。",
        retryable: false,
      });
      expect(await handler(event)).toMatchObject({
        ok: false,
        code: "VALIDATION_ERROR",
      });
      expect(mocks.writeText).not.toHaveBeenCalled();
      mocks.send.mockResolvedValue({
        ok: true,
        value: "pickup-sync:1:test",
        revision: 3,
      });
      expect(await handler(event)).toEqual({
        ok: true,
        value: null,
        revision: 3,
      });
      expect(mocks.send).toHaveBeenLastCalledWith({
        kind: "getPairingPayload",
      });
      expect(mocks.writeText).toHaveBeenCalledWith("pickup-sync:1:test");
      mocks.writeText.mockImplementationOnce(() => {
        throw new Error("clipboard unavailable");
      });
      expect(await handler(event)).toMatchObject({
        ok: false,
        code: "SYSTEM_SETTING_ERROR",
      });
    } finally {
      mocks.fromWebContents.mockReturnValue(null);
    }
  });
  it("preload identifies the desktop host", () => {
    expect(api().host).toBe("desktop");
  });
  it("preload 暴露的每个业务方法都有 main 侧固定处理函数", () => {
    const channels = collectChannels();
    const registered = [...registeredChannels()].sort();
    expect(channels.length).toBeGreaterThan(20);
    expect(channels).toEqual(registered);
  });

  it("每个 channel 只登记一次，且不存在额外入口", () => {
    const registered = [...registeredChannels()].sort();
    const handled = mocks.handle.mock.calls.map((call) => call[0] as string);
    expect(handled.length).toBe(registered.length);
    expect(new Set(handled).size).toBe(handled.length);
    expect([...handled].sort()).toEqual(registered);
  });

  it("所有 channel 使用固定前缀，不提供通用转发入口", () => {
    for (const channel of collectChannels())
      expect(channel.startsWith("pickup:")).toBe(true);
  });

  it("状态变化订阅使用固定事件并可取消", () => {
    const received: number[] = [];
    const unsubscribe = api().onStateChanged((revision) =>
      received.push(revision),
    );
    const handler = mocks.listeners.get("pickup:changed");
    expect(handler).toBeTypeOf("function");
    handler?.({}, 7);
    expect(received).toEqual([7]);
    unsubscribe();
    expect(mocks.listeners.has("pickup:changed")).toBe(false);
  });
});
