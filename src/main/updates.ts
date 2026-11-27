import { app, shell } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  getAvailableRelease,
  latestReleaseUrl,
  repositoryUrl,
  type AvailableRelease,
  type UpdateOffer,
} from "../shared/releases";
import type { Result } from "../shared/contracts";
import type { DesktopHost } from "./desktop";

function updateError(message: string): Result<never> {
  return { ok: false, code: "SYSTEM_SETTING_ERROR", message, retryable: true };
}

export function createDesktopUpdates(desktop: Pick<DesktopHost, "quit">) {
  let available: AvailableRelease | null = null;
  let staged: { path: string; offer: UpdateOffer } | undefined;
  let applying = false;

  return {
    async checkForUpdate(): Promise<Result<UpdateOffer | null>> {
      if (staged) return { ok: true, value: staged.offer, revision: 0 };
      try {
        available = await getAvailableRelease(
          app.getVersion(),
          process.platform === "win32" && app.isPackaged
            ? "windows"
            : "browser",
        );
        return {
          ok: true,
          value: available?.installer
            ? { ...available.offer, action: "download" }
            : (available?.offer ?? null),
          revision: 0,
        };
      } catch {
        return updateError("暂时无法检查更新，请检查网络后重试。");
      }
    },
    async applyUpdate(intent?: "restart"): Promise<Result<UpdateOffer | null>> {
      if (applying) return updateError("正在处理更新，请稍候。");
      applying = true;
      let folder: string | undefined;
      try {
        if (intent === "restart") {
          if (!staged) return updateError("请先下载更新。");
          const { path } = staged;
          const quit = await desktop.quit(async () => {
            const child = spawn(path, [], { detached: true, stdio: "ignore" });
            await once(child, "spawn");
            child.unref();
            staged = undefined;
          });
          if (!quit.ok) return quit;
          return { ok: true, value: null, revision: 0 };
        }
        if (staged) return { ok: true, value: staged.offer, revision: 0 };
        const version = available?.offer.version;
        const installer = available?.installer;
        if (!version || !installer) {
          await shell.openExternal(available?.page ?? latestReleaseUrl);
        } else {
          folder = await mkdtemp(join(app.getPath("temp"), "pickup-update-"));
          const path = join(folder, basename(new URL(installer.url).pathname));
          const response = await fetch(installer.url, {
            signal: AbortSignal.timeout(300000),
          });
          if (!response.ok || !response.body)
            throw new Error("update-download-failed");
          const hash = createHash("sha256");
          const verify = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              hash.update(chunk);
              done(null, chunk);
            },
          });
          await pipeline(
            response.body,
            verify,
            createWriteStream(path, { flags: "wx" }),
          );
          if (hash.digest("hex") !== installer.sha256)
            throw new Error("update-checksum-mismatch");
          const stagedFolder = folder;
          app.once("will-quit", () => {
            if (staged?.path !== path) return;
            try {
              rmSync(stagedFolder, { recursive: true, force: true });
            } catch {
              console.error("update-cleanup-failed");
            }
          });
          staged = { path, offer: { version, action: "restart" } };
          return { ok: true, value: staged.offer, revision: 0 };
        }
        return { ok: true, value: null, revision: 0 };
      } catch {
        return updateError("无法打开或安装更新，请检查网络后重试。");
      } finally {
        if (folder && !staged)
          await rm(folder, { recursive: true, force: true }).catch(() => {
            console.error("update-cleanup-failed");
          });
        applying = false;
      }
    },
    async openRepository(): Promise<Result<null>> {
      try {
        await shell.openExternal(repositoryUrl);
        return { ok: true, value: null, revision: 0 };
      } catch {
        return updateError("无法打开 GitHub 仓库。");
      }
    },
  };
}
