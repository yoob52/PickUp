import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import type { UpdateOffer } from "../../../shared/releases";
import { Button, IconButton } from "../ui/primitives";
import { useToast } from "../ui/Toast";

const updateLabels: Record<UpdateOffer["action"], [string, string]> = {
  download: ["下载更新", "正在下载…"],
  restart: ["重启并安装", "正在启动安装…"],
  install: ["下载并安装", "正在准备安装…"],
  release: ["查看发布页", "正在打开…"],
};

export function useUpdateControls() {
  const notify = useToast();
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const busy = useRef(false);

  const check = useCallback(
    async (manual: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setChecking(true);
      try {
        const result = await window.pickup.checkForUpdate();
        if (result.ok) {
          setOffer(result.value);
          if (manual && !result.value) notify("当前已是最新版本。");
        } else if (manual) {
          notify(result.message, "error");
        }
      } catch {
        if (manual) notify("暂时无法检查更新，请稍后重试。", "error");
      } finally {
        busy.current = false;
        setChecking(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void check(false);
  }, [check]);

  async function apply() {
    if (!offer || busy.current) return;
    busy.current = true;
    setApplying(true);
    try {
      const result =
        offer.action === "restart"
          ? await window.pickup.applyUpdate("restart")
          : await window.pickup.applyUpdate();
      if (!result.ok) notify(result.message, "error");
      else if (result.value) setOffer(result.value);
      else if (offer.action === "install")
        notify("安装程序已打开，请按提示完成更新。");
    } catch {
      notify("无法打开更新，请稍后重试。", "error");
    } finally {
      busy.current = false;
      setApplying(false);
    }
  }

  async function openRepository() {
    try {
      const result = await window.pickup.openRepository();
      if (!result.ok) notify(result.message, "error");
    } catch {
      notify("无法打开 GitHub 仓库。", "error");
    }
  }

  return {
    buttons: (
      <>
        <IconButton
          label={checking ? "正在检查更新" : "检查更新"}
          onClick={() => void check(true)}
          disabled={checking || applying}
        >
          <RefreshCw size={17} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="打开 GitHub 仓库"
          onClick={() => void openRepository()}
        >
          <svg
            viewBox="0 0 16 16"
            width="18"
            height="18"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.23.48-2.7-.95-2.7-.95-.37-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.22.82 1.22.82.71 1.22 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82A7.63 7.63 0 0 1 8 3.85c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.88 3.75-3.67 3.95.29.25.55.73.55 1.48l-.01 2.21c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
          </svg>
        </IconButton>
      </>
    ),
    notice: offer && (
      <div className="update-notice">
        <span role="status">
          {offer.action === "restart" ? "已下载" : "发现新版本"}{" "}
          <strong>v{offer.version}</strong>
          {offer.action === "restart" && "，请先保存修改。"}
        </span>
        <Button
          kind="secondary"
          icon={
            offer.action === "release" ? (
              <ExternalLink size={15} />
            ) : (
              <Download size={15} />
            )
          }
          disabled={checking || applying}
          onClick={() => void apply()}
        >
          {updateLabels[offer.action][applying ? 1 : 0]}
        </Button>
      </div>
    ),
  };
}
