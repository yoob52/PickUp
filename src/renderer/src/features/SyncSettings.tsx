import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Cloud,
  Copy,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import QRCode from "qrcode";
import type { SyncStatus } from "../../../shared/sync-contracts";
import type { Result } from "../../../shared/contracts";
import { Button, Field } from "../ui/primitives";
import { Modal } from "../ui/Modal";
import { AccountPanel } from "./AccountPanel";

export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [registrationToken, setRegistrationToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  async function copyPairing() {
    try {
      const result = await window.pickup.copyPairingPayload();
      if (!result.ok) {
        setCopyMessage(result.message);
        return;
      }
      setCopyMessage("配对码已复制，请仅发送到你信任的设备。");
    } catch {
      setCopyMessage("复制失败，请稍后重试。");
    }
  }

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const result = await window.pickup.getSyncStatus();
      if (!active) return;
      if (result.ok) {
        setStatus(result.value);
        if (!result.value.enabled) setQr(null);
      } else setError(result.message);
    };
    void refresh();
    const unsubscribe = window.pickup.onStateChanged(() => void refresh());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function act(operation: () => Promise<Result<SyncStatus>>) {
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      if (result.ok) {
        setStatus(result.value);
        if (result.value.enabled) setRegistrationToken("");
      } else {
        setError(result.message);
        const current = await window.pickup.getSyncStatus();
        if (current.ok) setStatus(current.value);
      }
    } catch {
      setError("无法连接同步服务，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  async function showPairing() {
    setCopyMessage("");
    setBusy(true);
    setError("");
    try {
      const result = await window.pickup.getPairingPayload();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setQr(
        await QRCode.toDataURL(result.value, {
          errorCorrectionLevel: "M",
          width: 320,
          margin: 4,
          color: { dark: "#202b28", light: "#ffffff" },
        }),
      );
    } catch {
      setError("配对二维码生成失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sync-settings" aria-labelledby="sync-heading">
      <div className="sync-heading">
        <Cloud size={19} aria-hidden="true" />
        <div>
          <h3 id="sync-heading">同步</h3>
          <p className="helper">让未完的事，在自己的设备间接续。</p>
        </div>
        <span className="sync-badge">端到端加密</span>
      </div>
      <AccountPanel status={status} onStatus={setStatus} />
      {error || status?.error ? (
        <p className="field-error" role="alert">
          {error || status?.error}
        </p>
      ) : null}
      {!status ? (
        <p className="helper">正在读取同步状态…</p>
      ) : status.enabled ? (
        <>
          <div className="sync-status">
            <ShieldCheck size={17} aria-hidden="true" />
            <div>
              <strong role="status">
                {status.stopped
                  ? "需要重新配对"
                  : status.running
                    ? "正在同步…"
                    : status.error
                      ? "同步暂未完成"
                      : status.lastSuccess
                        ? "已同步"
                        : "已启用，等待首次同步"}
              </strong>
              <p className="helper">{status.serverUrl}</p>
              <p className="helper">
                上次同步：
                {status.lastSuccess
                  ? new Date(status.lastSuccess).toLocaleString("zh-CN")
                  : "尚未同步"}
              </p>
              {status.retryAt && !status.stopped ? (
                <p className="helper">
                  将在 {new Date(status.retryAt).toLocaleTimeString("zh-CN")}{" "}
                  重试。
                </p>
              ) : null}
            </div>
          </div>
          <div className="sync-actions">
            <Button
              kind="secondary"
              icon={<RefreshCw size={15} />}
              disabled={busy || status.running || status.stopped}
              onClick={() => void act(() => window.pickup.syncNow())}
            >
              立即同步
            </Button>
            <Button
              kind="ghost"
              icon={<QrCode size={15} />}
              disabled={busy || status.stopped}
              onClick={() => void showPairing()}
            >
              显示配对二维码
            </Button>
            <Button
              kind="ghost"
              icon={<Unplug size={15} />}
              disabled={busy}
              onClick={() => void act(() => window.pickup.disableSync())}
            >
              停止同步
            </Button>
          </div>
          <p className="helper">
            停止同步只断开本机，不会删除本地任务或撤销其他设备的访问。
          </p>
        </>
      ) : (
        <details className="account-advanced">
          <summary>高级：旧版配对空间</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(() =>
                window.pickup.enableSync({ serverUrl, registrationToken }),
              );
            }}
          >
            <Field
              id="sync-server"
              label="服务器地址"
              hint="使用 HTTPS；本机调试可用 http://localhost。"
            >
              <input
                id="sync-server"
                type="url"
                placeholder="https://sync.example.com"
                required
                autoComplete="url"
                value={serverUrl}
                disabled={busy}
                onChange={(event) => setServerUrl(event.target.value)}
              />
            </Field>
            <Field
              id="sync-registration"
              label="注册令牌"
              hint="由服务器管理员提供，仅注册时使用，不会保存。"
            >
              <input
                id="sync-registration"
                type="password"
                autoComplete="off"
                required
                minLength={32}
                value={registrationToken}
                disabled={busy}
                onChange={(event) => setRegistrationToken(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              kind="secondary"
              icon={<Cloud size={15} />}
              disabled={busy}
            >
              {busy ? "正在启用…" : "启用同步"}
            </Button>
          </form>
        </details>
      )}
      {qr
        ? createPortal(
            <Modal
              title="配对设备"
              eyebrow="同步 / 安全连接"
              stacked
              onClose={() => setQr(null)}
            >
              <p className="sync-pairing-warning">
                <ShieldCheck size={18} aria-hidden="true" />
                任何扫描此二维码的人都会获得此同步空间的完整访问权限，包括读取和修改数据。仅向你信任的设备展示，勿截图分享。
              </p>
              <div className="sync-qr">
                <img src={qr} width={320} height={320} alt="同步配对二维码" />
              </div>
              <p className="helper">
                在 Android
                应用中打开同步并扫码，或复制配对码后在手机粘贴。关闭后二维码不会继续显示。
              </p>
              {copyMessage ? (
                <p role="status" className="helper">
                  {copyMessage}
                </p>
              ) : null}
              <div className="modal-actions">
                <Button
                  kind="secondary"
                  icon={<Copy size={15} />}
                  onClick={() => void copyPairing()}
                >
                  复制配对码
                </Button>
                <Button onClick={() => setQr(null)}>关闭二维码</Button>
              </div>
            </Modal>,
            document.body,
          )
        : null}
    </section>
  );
}
