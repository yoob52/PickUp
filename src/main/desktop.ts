import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  type NativeImage,
} from "electron";
import type {
  DesktopState,
  PreferenceState,
  Preferences,
  Result,
  UpdatePreferenceInput,
  UpdatePreferenceValue,
  WindowAction,
  WindowActionValue,
} from "../shared/contracts";
import { DEFAULT_PREFERENCES } from "../shared/contracts";
import type { StoreClient } from "./worker-client";
import { defaultWidgetBounds, visibleBounds, type Rect } from "./bounds";

export type WindowKind = "main" | "capture" | "widget";

export type DesktopHost = {
  start(): Promise<void>;
  isQuitting(): boolean;
  showMain(): Promise<Result<WindowActionValue>>;
  showCapture(): Promise<Result<WindowActionValue>>;
  hideCapture(): Promise<Result<WindowActionValue>>;
  hideWidget(): Promise<Result<WindowActionValue>>;
  quit(): Promise<Result<WindowActionValue>>;
  getDesktopState(): Promise<Result<DesktopState>>;
  applyPreferencePatch(
    input: UpdatePreferenceInput,
  ): Promise<Result<UpdatePreferenceValue>>;
};

type Options = {
  store: StoreClient;
  e2eMode: boolean;
  preload: string;
  loadURL: (win: BrowserWindow, kind: WindowKind) => Promise<void>;
};

const PREPARE_CLOSE_TIMEOUT_MS = 2_500;
const BOUNDS_SAVE_MS = 400;
const COLLAPSED_HEIGHT = 76;
const EXPANDED_HEIGHT = 248;

function windowResult(action: WindowAction): Result<WindowActionValue> {
  return { ok: true, value: { type: "window", action }, revision: 0 };
}

function asError(
  code: "SHORTCUT_CONFLICT" | "SYSTEM_SETTING_ERROR" | "STORAGE_ERROR",
  message: string,
  retryable: boolean,
): Result<never> {
  return { ok: false, code, message, retryable };
}

function trayImage(): NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const on = dx * dx + dy * dy <= 36;
      const i = (y * size + x) * 4;
      buffer[i] = on ? 0x5c : 0;
      buffer[i + 1] = on ? 0xff : 0;
      buffer[i + 2] = on ? 0xd8 : 0;
      buffer[i + 3] = on ? 255 : 0;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function workAreas(): Rect[] {
  return screen.getAllDisplays().map((display) => ({
    x: Math.round(display.workArea.x),
    y: Math.round(display.workArea.y),
    width: Math.round(display.workArea.width),
    height: Math.round(display.workArea.height),
  }));
}

function normalizeAccelerator(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, "")
    .replace(/Ctrl/gi, "Control")
    .replace(/Cmd/gi, "Command")
    .replace(/Win/gi, "Super");
}

export function createDesktop(options: Options): DesktopHost {
  const { store, e2eMode, preload, loadURL } = options;
  const skipOs = e2eMode;
  let quitting = false;
  let main: BrowserWindow | undefined;
  let capture: BrowserWindow | undefined;
  let widget: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let registeredAccelerator = "";
  let acceleratorRegistered = false;
  let loginApplied = false;
  let boundsTimer: NodeJS.Timeout | undefined;
  let flushingCapture = false;
  const kinds = new WeakMap<BrowserWindow, WindowKind>();

  const webPreferences = {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  } as const;

  function attachGuards(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
  }

  async function createWindow(
    kind: WindowKind,
    extra: Electron.BrowserWindowConstructorOptions,
  ): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      show: false,
      backgroundColor: kind === "main" ? "#121313" : "#f2f0e9",
      webPreferences,
      ...extra,
    });
    kinds.set(win, kind);
    attachGuards(win);
    await loadURL(win, kind);
    return win;
  }

  function broadcast(channel: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        win.webContents.send(channel);
      } catch {
        console.error("desktop-broadcast-failed", { channel });
      }
    }
  }

  async function readPreferences(): Promise<PreferenceState> {
    const result = await store.send<PreferenceState>({
      kind: "getPreferences",
    });
    if (result.ok) return result.value;
    return { values: DEFAULT_PREFERENCES, version: 0 };
  }

  async function writePatch(
    patch: UpdatePreferenceInput["patch"],
    expectedVersion: number,
  ): Promise<Result<UpdatePreferenceValue>> {
    return store.send<UpdatePreferenceValue>({
      kind: "updatePreference",
      input: { patch, expectedVersion },
    });
  }

  function askPrepareClose(win: BrowserWindow): Promise<boolean> {
    if (win.isDestroyed() || win.webContents.isDestroyed())
      return Promise.resolve(true);
    if (win.webContents.isLoadingMainFrame()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener("pickup:prepare-close-result", onResult);
        resolve(false);
      }, PREPARE_CLOSE_TIMEOUT_MS);
      function onResult(event: Electron.IpcMainEvent, ok: unknown): void {
        if (event.sender !== win.webContents) return;
        clearTimeout(timer);
        ipcMain.removeListener("pickup:prepare-close-result", onResult);
        resolve(ok === true);
      }
      ipcMain.on("pickup:prepare-close-result", onResult);
      try {
        win.webContents.send("pickup:prepare-close");
      } catch {
        clearTimeout(timer);
        ipcMain.removeListener("pickup:prepare-close-result", onResult);
        resolve(true);
      }
    });
  }

  async function flushCaptureDraft(): Promise<boolean> {
    if (!capture || capture.isDestroyed()) return true;
    if (flushingCapture) return false;
    flushingCapture = true;
    try {
      return await askPrepareClose(capture);
    } finally {
      flushingCapture = false;
    }
  }

  async function ensureMain(): Promise<BrowserWindow> {
    if (main && !main.isDestroyed()) return main;
    main = await createWindow("main", {
      width: 1120,
      height: 780,
      minWidth: 600,
      minHeight: 540,
      title: "接着 PickUp",
    });
    main.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      main?.hide();
    });
    return main;
  }

  async function ensureCapture(): Promise<BrowserWindow> {
    if (capture && !capture.isDestroyed()) return capture;
    capture = await createWindow("capture", {
      width: 520,
      height: 420,
      minWidth: 420,
      minHeight: 320,
      skipTaskbar: true,
      title: "记下新一件事",
    });
    capture.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      void (async () => {
        const saved = await flushCaptureDraft();
        if (saved) capture?.hide();
        else {
          capture?.show();
          capture?.focus();
        }
      })();
    });
    return capture;
  }

  function currentWidgetRect(collapsed: boolean): Rect {
    const area = screen.getPrimaryDisplay().workArea;
    if (widget && !widget.isDestroyed()) {
      const [x, y] = widget.getPosition();
      const [width] = widget.getSize();
      return visibleBounds(
        {
          x,
          y,
          width,
          height: collapsed ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT,
        },
        workAreas(),
      );
    }
    return defaultWidgetBounds(
      {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
      },
      collapsed,
    );
  }

  function applyWidgetChrome(values: Preferences): void {
    if (!widget || widget.isDestroyed()) return;
    widget.setAlwaysOnTop(values.widgetPinned);
    const stored = values.widgetBounds;
    const next = visibleBounds(
      stored ?? currentWidgetRect(values.widgetCollapsed),
      workAreas(),
    );
    const height = values.widgetCollapsed ? COLLAPSED_HEIGHT : next.height;
    widget.setBounds({ ...next, height });
  }

  function queueBoundsSave(): void {
    if (!widget || widget.isDestroyed() || skipOs) return;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      void persistWidgetBounds();
    }, BOUNDS_SAVE_MS);
  }

  async function persistWidgetBounds(): Promise<void> {
    if (!widget || widget.isDestroyed()) return;
    const bounds = widget.getBounds();
    const prefs = await readPreferences();
    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    const current = prefs.values.widgetBounds;
    if (
      current &&
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    )
      return;
    await writePatch({ widgetBounds: next }, prefs.version);
  }

  async function ensureWidget(values: Preferences): Promise<void> {
    if (!values.widgetEnabled) {
      if (widget && !widget.isDestroyed()) {
        clearTimeout(boundsTimer);
        await persistWidgetBounds();
        widget.destroy();
        widget = undefined;
      }
      return;
    }
    if (!widget || widget.isDestroyed()) {
      const bounds =
        values.widgetBounds ??
        defaultWidgetBounds(
          screen.getPrimaryDisplay().workArea,
          values.widgetCollapsed,
        );
      const placed = visibleBounds(bounds, workAreas());
      widget = await createWindow("widget", {
        x: placed.x,
        y: placed.y,
        width: placed.width,
        height: values.widgetCollapsed ? COLLAPSED_HEIGHT : placed.height,
        minWidth: 240,
        minHeight: 72,
        frame: false,
        skipTaskbar: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: "接着 PickUp",
      });
      widget.setAlwaysOnTop(values.widgetPinned);
      widget.on("moved", queueBoundsSave);
      widget.on("resized", queueBoundsSave);
      widget.on("close", (event) => {
        if (quitting) return;
        event.preventDefault();
        void hideWidget();
      });
    }
    applyWidgetChrome(values);
    if (!e2eMode) widget.show();
  }

  function registerAccelerator(accelerator: string): boolean {
    const next = normalizeAccelerator(accelerator);
    if (!next) return false;
    if (registeredAccelerator === next && acceleratorRegistered) return true;
    const ok = globalShortcut.register(next, () => {
      void showCapture();
    });
    if (!ok) return false;
    if (registeredAccelerator && registeredAccelerator !== next)
      globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = next;
    acceleratorRegistered = true;
    return true;
  }

  function applyLoginItem(enabled: boolean): boolean {
    if (skipOs) {
      loginApplied = enabled;
      return true;
    }
    try {
      const settings = app.isPackaged
        ? { openAtLogin: enabled }
        : {
            openAtLogin: enabled,
            path: process.execPath,
            args: [app.getAppPath()],
          };
      app.setLoginItemSettings(settings);
      loginApplied = app.getLoginItemSettings().openAtLogin === enabled;
      return loginApplied;
    } catch {
      loginApplied = false;
      return false;
    }
  }

  function actualLoginItem(): boolean {
    if (skipOs) return loginApplied;
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  }

  function createTray(): void {
    if (tray) return;
    tray = new Tray(trayImage());
    tray.setToolTip("接着 PickUp");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 PickUp", click: () => void showMain() },
        { label: "记一件事", click: () => void showCapture() },
        { type: "separator" },
        { label: "完全退出", click: () => void quit() },
      ]),
    );
    tray.on("click", () => {
      void showMain();
    });
  }

  function listenSystem(): void {
    const relayout = () => {
      void readPreferences().then((prefs) => {
        if (widget && !widget.isDestroyed() && prefs.values.widgetEnabled)
          applyWidgetChrome(prefs.values);
      });
    };
    screen.on("display-added", relayout);
    screen.on("display-removed", relayout);
    screen.on("display-metrics-changed", relayout);
    powerMonitor.on("resume", () => {
      broadcast("pickup:day-invalidated");
      relayout();
    });
    powerMonitor.on("unlock-screen", () => broadcast("pickup:day-invalidated"));
  }

  async function showMain(): Promise<Result<WindowActionValue>> {
    const win = await ensureMain();
    if (win.isMinimized()) win.restore();
    if (!e2eMode) win.show();
    win.focus();
    return windowResult("showMain");
  }

  async function showCapture(): Promise<Result<WindowActionValue>> {
    const win = await ensureCapture();
    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(true, "floating");
    win.show();
    win.focus();
    win.webContents.focus();
    win.webContents.send("pickup:capture-shown");
    return windowResult("showCapture");
  }

  async function hideCapture(): Promise<Result<WindowActionValue>> {
    if (capture && !capture.isDestroyed()) {
      capture.setAlwaysOnTop(false);
      capture.hide();
    }
    return windowResult("hideCapture");
  }

  async function hideWidget(): Promise<Result<WindowActionValue>> {
    const prefs = await readPreferences();
    if (prefs.values.widgetEnabled) {
      const written = await writePatch({ widgetEnabled: false }, prefs.version);
      if (!written.ok) return written;
    }
    if (widget && !widget.isDestroyed()) {
      clearTimeout(boundsTimer);
      await persistWidgetBounds();
      widget.hide();
      widget.destroy();
      widget = undefined;
    }
    return windowResult("hideWidget");
  }

  async function applyPreferencePatch(
    input: UpdatePreferenceInput,
  ): Promise<Result<UpdatePreferenceValue>> {
    const nextAccelerator = input.patch.accelerator;
    let previousAccelerator = registeredAccelerator;
    if (typeof nextAccelerator === "string") {
      const normalized = normalizeAccelerator(nextAccelerator);
      if (!normalized)
        return asError("SHORTCUT_CONFLICT", "请填写有效的快捷键组合。", false);
      if (!registerAccelerator(normalized)) {
        if (previousAccelerator) registerAccelerator(previousAccelerator);
        return asError(
          "SHORTCUT_CONFLICT",
          "快捷键无法注册，可能已被其他程序占用。请更换组合，主窗口仍可记一件事。",
          false,
        );
      }
      input = {
        ...input,
        patch: { ...input.patch, accelerator: normalized },
      };
    }
    const nextLogin = input.patch.launchAtLogin;
    const previousLogin = actualLoginItem();
    if (typeof nextLogin === "boolean") {
      if (!applyLoginItem(nextLogin)) {
        applyLoginItem(previousLogin);
        return asError(
          "SYSTEM_SETTING_ERROR",
          "开机启动未能写入系统登录项。当前开关仍显示真实状态。",
          true,
        );
      }
    }
    const saved = await writePatch(input.patch, input.expectedVersion);
    if (!saved.ok) {
      if (typeof nextAccelerator === "string" && previousAccelerator)
        registerAccelerator(previousAccelerator);
      if (typeof nextLogin === "boolean") applyLoginItem(previousLogin);
      return saved;
    }
    const values = saved.value.preferences.values;
    if (
      input.patch.widgetEnabled !== undefined ||
      input.patch.widgetPinned !== undefined ||
      input.patch.widgetCollapsed !== undefined ||
      input.patch.widgetBounds !== undefined
    )
      await ensureWidget(values);
    return saved;
  }

  async function getDesktopState(): Promise<Result<DesktopState>> {
    const prefs = await readPreferences();
    return {
      ok: true,
      revision: 0,
      value: {
        accelerator: registeredAccelerator || prefs.values.accelerator,
        acceleratorRegistered,
        launchAtLogin: prefs.values.launchAtLogin,
        launchAtLoginApplied: actualLoginItem() === prefs.values.launchAtLogin,
        widgetVisible: Boolean(
          widget && !widget.isDestroyed() && widget.isVisible(),
        ),
      },
    };
  }

  async function quit(): Promise<Result<WindowActionValue>> {
    if (quitting) return windowResult("quit");
    const saved = await flushCaptureDraft();
    if (!saved) {
      await showCapture();
      return asError(
        "STORAGE_ERROR",
        "还有未保存的快速记录草稿。窗口已保留，请处理后再退出。",
        true,
      );
    }
    quitting = true;
    clearTimeout(boundsTimer);
    if (widget && !widget.isDestroyed()) await persistWidgetBounds();
    if (registeredAccelerator) globalShortcut.unregisterAll();
    acceleratorRegistered = false;
    tray?.destroy();
    tray = undefined;
    await store.close();
    app.quit();
    return windowResult("quit");
  }

  async function start(): Promise<void> {
    const prefs = await readPreferences();
    acceleratorRegistered = registerAccelerator(prefs.values.accelerator);
    applyLoginItem(prefs.values.launchAtLogin);
    await ensureMain();
    await ensureCapture();
    await ensureWidget(prefs.values);
    if (!e2eMode) main?.show();
    createTray();
    listenSystem();
  }

  return {
    start,
    isQuitting: () => quitting,
    showMain,
    showCapture,
    hideCapture,
    hideWidget,
    quit,
    getDesktopState,
    applyPreferencePatch,
  };
}
