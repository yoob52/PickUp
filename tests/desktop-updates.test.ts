import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDesktop } from "../src/main/desktop";
import { createDesktopUpdates } from "../src/main/updates";
import type { StoreClient } from "../src/main/worker-client";

const mocks = vi.hoisted(() => ({
  closeStore: vi.fn(),
  getPath: vi.fn(),
  quit: vi.fn(),
  spawn: vi.fn(),
  on: vi.fn(),
  contents: {
    focus: vi.fn(),
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    send: vi.fn(),
    on: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn() },
    setWindowOpenHandler: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: mocks.getPath,
    getVersion: () => "1.0.0",
    quit: mocks.quit,
  },
  shell: {},
  nativeImage: { createFromPath: vi.fn() },
  ipcMain: { on: mocks.on, removeListener: vi.fn() },
  BrowserWindow: class {
    webContents = mocks.contents;
    focus() {}
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    on() {}
    setAlwaysOnTop() {}
    setMenu() {}
    show() {}
  },
}));
vi.mock("node:child_process", () => ({
  default: { spawn: mocks.spawn },
  spawn: mocks.spawn,
}));

const installer = Buffer.from("installer bytes");
const name = "PickUp.Setup.1.1.0.exe";
const url = `https://github.com/yoob52/PickUp/releases/download/v1.1.0/${name}`;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let folder: string;

beforeEach(async () => {
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32" });
  folder = await mkdtemp(join(tmpdir(), "pickup-update-test-"));
  mocks.getPath.mockReturnValue(folder);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input === url
        ? new Response(installer)
        : Response.json({
            tag_name: "v1.1.0",
            draft: false,
            prerelease: false,
            assets: [
              {
                name,
                state: "uploaded",
                browser_download_url: url,
                digest: `sha256:${createHash("sha256").update(installer).digest("hex")}`,
              },
            ],
          }),
    ),
  );
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllGlobals();
  await rm(folder, { recursive: true, force: true });
});

async function startApplying() {
  const desktop = createDesktop({
    store: { close: mocks.closeStore } as unknown as StoreClient,
    e2eMode: true,
    preload: "",
    loadURL: async () => undefined,
  });
  await desktop.showCapture();
  const updates = createDesktopUpdates(desktop);
  expect(await updates.checkForUpdate()).toMatchObject({
    ok: true,
    value: { action: "install" },
  });
  const done = updates.applyUpdate();
  await vi.waitFor(() =>
    expect(mocks.contents.send).toHaveBeenCalledWith("pickup:prepare-close"),
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.quit).not.toHaveBeenCalled();
  const reply = (saved: boolean) =>
    mocks.on.mock.lastCall![1]({ sender: mocks.contents }, saved);
  return { desktop, done, reply };
}

it("waits for the draft to save, launches the verified installer detached, then quits normally", async () => {
  const unref = vi.fn();
  const child = Object.assign(new EventEmitter(), { unref });
  mocks.spawn.mockReturnValueOnce(child);
  const { done, reply } = await startApplying();
  reply(true);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
  const [path] = mocks.spawn.mock.lastCall!;
  expect(mocks.spawn).toHaveBeenCalledWith(path, [], {
    detached: true,
    stdio: "ignore",
  });
  expect(await readFile(path)).toEqual(installer);
  expect(mocks.quit).not.toHaveBeenCalled();
  child.emit("spawn");
  expect(await done).toMatchObject({ ok: true });
  expect(unref).toHaveBeenCalledBefore(mocks.closeStore);
  expect(mocks.closeStore).toHaveBeenCalledBefore(mocks.quit);
});

it("leaves PickUp open and does not launch the installer when saving the draft fails", async () => {
  const { desktop, done, reply } = await startApplying();
  reply(false);
  expect(await done).toMatchObject({ ok: false, code: "STORAGE_ERROR" });
  expect(desktop.isQuitting()).toBe(false);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.quit).not.toHaveBeenCalled();
});
