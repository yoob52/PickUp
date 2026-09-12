import { app, net, protocol } from "electron";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDesktop, type WindowKind } from "./desktop";
import { registerIpcHandlers } from "./ipc";
import { runIntegration } from "./integration";
import { StoreClient } from "./worker-client";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pickup",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let store: StoreClient | undefined;
const testMode = !app.isPackaged && process.argv.includes("--integration-test");
const e2eMode = process.env.PICKUP_E2E === "1";
if (!app.isPackaged)
  app.setPath("userData", join(app.getPath("appData"), "PickUp-development"));
if (e2eMode && process.env.PICKUP_TEST_DATA)
  app.setPath("userData", resolve(process.env.PICKUP_TEST_DATA));

function rendererUrl(kind: WindowKind): string {
  const query = kind === "main" ? "" : `?window=${kind}`;
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    return `${process.env.ELECTRON_RENDERER_URL}${query}`;
  return `pickup://app/index.html${query}`;
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
  await app.whenReady();
  const data = join(app.getPath("userData"), "data");
  await mkdir(data, { recursive: true });
  store = new StoreClient(join(data, "pickup.sqlite"));
  try {
    await store.ready;
    if (store.backupPath)
      console.log("database-upgraded", {
        schemaVersion: store.schemaVersion,
        hasBackup: true,
      });
  } catch {
    console.error("database-unavailable", {});
  }
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
  const desktop = createDesktop({
    store,
    e2eMode,
    preload: join(__dirname, "../preload/index.js"),
    loadURL: (win, kind) => win.loadURL(rendererUrl(kind)),
  });
  app.on("second-instance", () => {
    void desktop.showMain();
  });
  registerIpcHandlers(store, desktop);
  await desktop.start();
  app.on("window-all-closed", () => {
    if (desktop.isQuitting()) app.quit();
  });
  app.on("before-quit", (event) => {
    if (desktop.isQuitting()) return;
    event.preventDefault();
    void desktop.quit();
  });
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
