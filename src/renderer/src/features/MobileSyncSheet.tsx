import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import { Cloud, QrCode, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import type { SyncStatus } from "../../../shared/sync-contracts";
import type { Result } from "../../../shared/contracts";
import { Modal } from "../ui/Modal";
import { Button, Field } from "../ui/primitives";
import { AccountPanel } from "./AccountPanel";

export function MobileSyncSheet({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const result = await window.pickup.getSyncStatus();
      if (!active) return;
      if (result.ok) setStatus(result.value);
      else setError(result.message);
    };
    void refresh();
    const stop = window.pickup.onStateChanged(() => void refresh());
    return () => {
      active = false;
      stop();
    };
  }, []);
  async function act(operation: () => Promise<Result<SyncStatus>>) {
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      if (result.ok) {
        setStatus(result.value);
        setPayload("");
      } else {
        setError(result.message);
        const current = await window.pickup.getSyncStatus();
        if (current.ok) setStatus(current.value);
      }
    } catch {
      setError("操作未完成，请检查网络或使用粘贴配对码重试。");
    } finally {
      setBusy(false);
    }
  }
  async function scan() {
    if (!Capacitor.isNativePlatform()) {
      setError("请在 Android 应用中扫码，浏览器可使用粘贴配对码。");
      return;
    }
    await act(async () => {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "扫描桌面 PickUp 的配对二维码",
      });
      return window.pickup.pairWithPayload(result.ScanResult);
    });
  }
  return (
    <Modal title="同步" eyebrow="自己的设备 / 接续未完" onClose={onClose}>
      <div className="mobile-sync-intro">
        <Cloud size={26} aria-hidden="true" />
        <p>在电脑记下，在手机接着。</p>
      </div>
      <p className="helper">
        仅在应用前台同步；切到后台后暂停，回到应用会继续。
      </p>
      {error || status?.error ? (
        <p className="field-error" role="alert">
          {error || status?.error}
        </p>
      ) : null}
      {!status ? <p role="status">正在读取同步状态…</p> : null}
      <AccountPanel
        status={status}
        onStatus={(next) => {
          setStatus(next);
          setError("");
        }}
      />
      {status?.enabled ? (
        <>
          <div className="sync-status" role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>
                {status.stopped
                  ? "需要重新配对"
                  : status.running
                    ? "正在同步…"
                    : status.error
                      ? "同步暂未完成"
                      : status.lastSuccess
                        ? "已同步"
                        : "等待首次同步"}
              </strong>
              <p className="helper">{status.serverUrl}</p>
              <p className="helper">
                上次同步：
                {status.lastSuccess
                  ? new Date(status.lastSuccess).toLocaleString()
                  : "尚未同步"}
              </p>
            </div>
          </div>
          <div className="mobile-sync-actions">
            <Button
              icon={<RefreshCw size={17} />}
              disabled={busy || status.running || status.stopped}
              onClick={() => void act(() => window.pickup.syncNow())}
            >
              立即同步
            </Button>
            <Button
              kind="ghost"
              icon={<Unplug size={17} />}
              disabled={busy}
              onClick={() => void act(() => window.pickup.disableSync())}
            >
              停止同步
            </Button>
          </div>
        </>
      ) : null}
      {status && (!status.enabled || status.stopped) ? (
        <>
          <Button
            className="mobile-scan"
            icon={<QrCode size={20} />}
            disabled={busy}
            onClick={() => void scan()}
          >
            {status.stopped ? "重新扫码配对" : "扫码配对"}
          </Button>
          <p className="helper">
            在桌面设置中打开“显示配对二维码”。首次扫码会请求相机权限。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(() => window.pickup.pairWithPayload(payload));
            }}
          >
            <Field
              id="mobile-pairing"
              label="粘贴配对码"
              hint="也可在桌面复制配对码，通过可信方式传到手机。配对码授予完整读写权限，请勿分享。"
            >
              <textarea
                id="mobile-pairing"
                rows={4}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="pickup-sync:1:…"
                value={payload}
                disabled={busy}
                onChange={(event) => setPayload(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              kind="secondary"
              disabled={busy || !payload.trim()}
            >
              {busy ? "正在配对…" : "配对并同步"}
            </Button>
          </form>
        </>
      ) : null}
      <div className="modal-actions">
        <Button kind="ghost" onClick={onClose}>
          完成
        </Button>
      </div>
    </Modal>
  );
}
