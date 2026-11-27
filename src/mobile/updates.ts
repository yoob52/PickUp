import { Capacitor, registerPlugin } from "@capacitor/core";
import { version } from "../../package.json";
import type { PickupAPI, Result } from "../shared/contracts";
import {
  getAvailableRelease,
  latestReleaseUrl,
  repositoryUrl,
  type AvailableRelease,
} from "../shared/releases";

const androidUpdater = registerPlugin<{
  install(options: { version: string; sha256: string }): Promise<void>;
}>("PickupUpdater");

function result<T>(value: T): Result<T> {
  return { ok: true, value, revision: 0 };
}

function failure(message: string): Result<never> {
  return { ok: false, code: "SYSTEM_SETTING_ERROR", message, retryable: true };
}

function openExternal(url: string) {
  if (Capacitor.isNativePlatform()) window.location.assign(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function createMobileUpdates(): Pick<
  PickupAPI,
  "checkForUpdate" | "applyUpdate" | "openRepository"
> {
  let available: AvailableRelease | null = null;
  return {
    async checkForUpdate() {
      try {
        available = await getAvailableRelease(
          version,
          Capacitor.getPlatform() === "android" ? "android" : "browser",
        );
        return result(available?.offer ?? null);
      } catch {
        return failure("暂时无法检查更新，请检查网络后重试。");
      }
    },
    async applyUpdate() {
      try {
        if (available?.installer) {
          await androidUpdater.install({
            version: available.offer.version,
            sha256: available.installer.sha256,
          });
        } else {
          openExternal(available?.page ?? latestReleaseUrl);
        }
        return result(null);
      } catch (error) {
        return failure(
          (error as { code?: string } | null)?.code === "INSTALL_PERMISSION"
            ? "请在系统设置中允许 PickUp 安装应用，再试一次。"
            : "无法下载或打开更新，请检查网络后重试。",
        );
      }
    },
    async openRepository() {
      try {
        openExternal(repositoryUrl);
        return result(null);
      } catch {
        return failure("无法打开 GitHub 仓库。");
      }
    },
  };
}
