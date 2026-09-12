import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PickupAPI, WindowAction } from "../src/shared/contracts";
import type { StoreClient } from "../src/main/worker-client";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handle: vi.fn(),
  exposed: undefined as unknown,
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    fromWebContents: () => null,
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
    if (name.startsWith("on")) continue;
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
  const send = vi.fn();
  const windowOk = async (action: WindowAction) => ({
    ok: true as const,
    value: { type: "window" as const, action },
    revision: 0,
  });
  registerIpcHandlers({ send } as unknown as StoreClient, {
    start: async () => undefined,
    isQuitting: () => false,
    showMain: () => windowOk("showMain"),
    showCapture: () => windowOk("showCapture"),
    hideCapture: () => windowOk("hideCapture"),
    hideWidget: () => windowOk("hideWidget"),
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
  });
});

describe("IPC 契约一致性", () => {
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
