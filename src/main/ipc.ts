import {
  BrowserWindow,
  app,
  clipboard,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import { z, type ZodType } from "zod";
import {
  mainWindowActionSchema,
  moveWidgetSchema,
  updatePreferenceSchema,
  type Result,
} from "../shared/contracts";
import { storeRegistry, type Registered } from "../shared/api-registry";
import type { DesktopHost } from "./desktop";
import type { StoreClient } from "./worker-client";
import type { AccountReply } from "../shared/account-contracts";
import { createDesktopUpdates } from "./updates";

const noInput = z.undefined();
const registry: Registered[] = [...storeRegistry];
function register<S extends ZodType, V>(
  channel: string,
  schema: S,
  broadcast: boolean,
  run: (client: StoreClient, input: z.output<S>) => Promise<Result<V>>,
): void {
  registry.push({ channel, schema, broadcast, run: run as Registered["run"] });
}

/** 校验已登记窗口、主 frame 与允许的来源；renderer 参数不构成权限证明。 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame)
    throw new Error("untrusted-ipc-sender");
  const url = new URL(event.senderFrame.url);
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (url.protocol === "pickup:" && url.host === "app") return;
  if (!app.isPackaged && devServer && url.origin === new URL(devServer).origin)
    return;
  throw new Error("untrusted-ipc-origin");
}

/**
 * 事务已提交后才广播刷新通知；通知发送失败不影响已提交的结果，
 * 也不会被描述成数据库保存失败。
 */
function notifyStateChanged(revision: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send("pickup:changed", revision);
    } catch {
      console.error("state-changed-notification-failed", { revision });
    }
  }
}

export function registerIpcHandlers(
  client: StoreClient,
  desktop: DesktopHost,
): void {
  client.onStateChanged(notifyStateChanged);
  const updates = createDesktopUpdates(desktop);
  register("pickup:checkForUpdate", noInput, false, updates.checkForUpdate);
  register(
    "pickup:applyUpdate",
    z.literal("restart").optional(),
    false,
    (_client, intent) => updates.applyUpdate(intent),
  );
  register("pickup:openRepository", noInput, false, updates.openRepository);
  register("pickup:copyLoginPayload", noInput, false, async (client) => {
    const result = await client.send<AccountReply>({
      kind: "account",
      input: { action: "getHandoffPayload" },
    });
    if (!result.ok) return result;
    if (!result.value.qrPayload)
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "请先生成有效的电脑登录码。",
        retryable: false,
      };
    try {
      clipboard.writeText(result.value.qrPayload);
      return { ok: true, value: null, revision: result.revision };
    } catch {
      return {
        ok: false,
        code: "SYSTEM_SETTING_ERROR",
        message: "无法写入剪贴板，请稍后重试。",
        retryable: true,
      };
    }
  });
  register("pickup:copyPairingPayload", noInput, false, async (client) => {
    const result = await client.send<string>({ kind: "getPairingPayload" });
    if (!result.ok) return result;
    try {
      clipboard.writeText(result.value);
      return { ok: true, value: null, revision: result.revision };
    } catch {
      return {
        ok: false,
        code: "SYSTEM_SETTING_ERROR",
        message: "无法写入剪贴板，请稍后重试。",
        retryable: true,
      };
    }
  });
  register(
    "pickup:updatePreference",
    updatePreferenceSchema,
    false,
    (_client, input) => desktop.applyPreferencePatch(input),
  );
  register("pickup:showMain", noInput, false, () => desktop.showMain());
  register(
    "pickup:controlMainWindow",
    mainWindowActionSchema,
    false,
    (_client, action) => desktop.controlMainWindow(action),
  );
  register("pickup:showCapture", noInput, false, () => desktop.showCapture());
  register("pickup:hideCapture", noInput, false, () => desktop.hideCapture());
  register("pickup:hideWidget", noInput, false, () => desktop.hideWidget());
  register("pickup:moveWidget", moveWidgetSchema, false, (_client, input) =>
    desktop.moveWidget(input),
  );
  register(
    "pickup:setWidgetExpanded",
    z.boolean(),
    false,
    (_client, expanded) => desktop.setWidgetExpanded(expanded),
  );
  register("pickup:quit", noInput, false, () => desktop.quit());
  register("pickup:getDesktopState", noInput, false, () =>
    desktop.getDesktopState(),
  );
  for (const entry of registry) {
    ipcMain.handle(entry.channel, async (event, raw: unknown) => {
      try {
        assertTrustedSender(event);
      } catch {
        console.error("rejected-ipc-request", { channel: entry.channel });
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "请求来源不可信，已拒绝处理。",
          retryable: false,
        } satisfies Result<never>;
      }
      const parsed = entry.schema.safeParse(raw);
      if (!parsed.success)
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "提交内容不符合要求，请检查后重试。",
          retryable: false,
        } satisfies Result<never>;
      const result = await entry.run(client, parsed.data);
      if (entry.broadcast && result.ok) notifyStateChanged(result.revision);
      return result;
    });
  }
}

export function registeredChannels(): string[] {
  return registry.map((entry) => entry.channel);
}
