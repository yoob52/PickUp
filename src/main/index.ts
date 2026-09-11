import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  type IpcMainInvokeEvent,
} from "electron";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTaskSchema, type Snapshot } from "../shared/contracts";
import { StoreClient } from "./worker-client";
import { runIntegration } from "./integration";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pickup",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let store: StoreClient | undefined;
let quitting = false;
const testMode = !app.isPackaged && process.argv.includes("--integration-test");
const e2eMode = process.env.PICKUP_E2E === "1";
if (!app.isPackaged)
  app.setPath("userData", join(app.getPath("appData"), "PickUp-development"));
if (e2eMode && process.env.PICKUP_TEST_DATA)
  app.setPath("userData", resolve(process.env.PICKUP_TEST_DATA));

function trusted(event: IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame)
    throw new Error("Invalid IPC sender");
  const url = new URL(event.senderFrame.url);
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (url.protocol === "pickup:" && url.host === "app") return;
  if (!app.isPackaged && dev && url.origin === new URL(dev).origin) return;
  throw new Error("Invalid IPC origin");
}
async function main() {
  if (testMode) {
    await app.whenReady();
    try {
      await runIntegration();
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
    return;
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  await app.whenReady();
  const data = join(app.getPath("userData"), "data");
  await mkdir(data, { recursive: true });
  store = new StoreClient(join(data, "pickup.sqlite"));
  let databaseReady = true;
  try {
    await store.ready;
  } catch {
    databaseReady = false;
  }
  ipcMain.handle("pickup:snapshot", async (event) => {
    trusted(event);
    return databaseReady
      ? store!.send<Snapshot>({ kind: "snapshot" })
      : {
          ok: false,
          code: "DB_UNAVAILABLE",
          message: "数据库初始化失败。原数据已保留，请关闭后检查存储环境。",
        };
  });
  ipcMain.handle("pickup:create", async (event, raw: unknown) => {
    trusted(event);
    const parsed = createTaskSchema.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "请填写有效标题。",
      };
    if (!databaseReady)
      return {
        ok: false,
        code: "DB_UNAVAILABLE",
        message: "数据库当前不可用，请保留输入。",
      };
    const result = await store!.send<{ taskId: string }>({
      kind: "create",
      input: parsed.data,
    });
    if (result.ok)
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed())
          win.webContents.send("pickup:changed", result.revision);
    return result;
  });
  const rendererRoot = resolve(__dirname, "../renderer");
  protocol.handle("pickup", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response(null, { status: 403 });
    let name: string;
    try {
      name = decodeURIComponent(url.pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    const file = resolve(
      rendererRoot,
      "." + (name === "/" ? "/index.html" : name),
    );
    const path = relative(rendererRoot, file);
    if (path.startsWith("..") || path.includes(":"))
      return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 600,
    minHeight: 540,
    show: !e2eMode,
    backgroundColor: "#121313",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadURL("pickup://app/index.html");
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting || !store) return;
  event.preventDefault();
  quitting = true;
  void store.close().finally(() => app.quit());
});
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
