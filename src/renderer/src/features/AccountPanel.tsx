import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Capacitor } from "@capacitor/core";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import {
  Copy,
  KeyRound,
  LogIn,
  LogOut,
  QrCode,
  ShieldCheck,
} from "lucide-react";
import {
  DEFAULT_SYNC_SERVER,
  type AccountInput,
  type AccountReply,
} from "../../../shared/account-contracts";
import type { SyncStatus } from "../../../shared/sync-contracts";
import { Button, Field } from "../ui/primitives";
import { Modal } from "../ui/Modal";

export function AccountPanel({
  status,
  onStatus,
}: {
  status: SyncStatus | null;
  onStatus: (value: SyncStatus) => void;
}) {
  const [mode, setMode] = useState<"login" | "register" | "recover">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(DEFAULT_SYNC_SERVER);
  const [recovery, setRecovery] = useState("");
  const [shownCode, setShownCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  async function copyLogin() {
    try {
      const result = await window.pickup.copyLoginPayload();
      setCopyMessage(
        result.ok ? "登录码已复制，请仅发送到你信任的手机。" : result.message,
      );
    } catch {
      setCopyMessage("复制失败，请稍后重试。");
    }
  }
  const [qr, setQr] = useState<{ image: string; expiresAt: number } | null>(
    null,
  );
  const [loginCode, setLoginCode] = useState("");
  const [confirmation, setConfirmation] =
    useState<AccountReply["confirmation"]>();
  useEffect(() => {
    if (!status?.accountEmail) return;
    let active = true;
    void window.pickup.account({ action: "pendingRecovery" }).then((result) => {
      if (active && result.ok && result.value.recoveryCode)
        setShownCode(result.value.recoveryCode);
    });
    return () => {
      active = false;
    };
  }, [status?.accountEmail]);
  async function act(input: AccountInput): Promise<AccountReply | undefined> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await window.pickup.account(input);
      if (!result.ok) {
        setError(result.message);
        const current = await window.pickup.getSyncStatus();
        if (current.ok) onStatus(current.value);
        return;
      }
      onStatus(result.value.status);
      if (result.value.recoveryCode) {
        setShownCode(result.value.recoveryCode);
        setSaved(false);
      }
      if (["register", "login", "recover"].includes(input.action)) {
        setPassword("");
        setRecovery("");
        setNotice("已登录；未完的事会在设备间同步。");
      }
      if (result.value.qrPayload) {
        setCopyMessage("");
        setQr({
          image: await QRCode.toDataURL(result.value.qrPayload, {
            width: 320,
            margin: 4,
          }),
          expiresAt: result.value.expiresAt!,
        });
      }
      if (result.value.confirmation) setConfirmation(result.value.confirmation);
      return result.value;
    } catch {
      setError("账户操作未完成，请检查网络后重试。输入已保留。");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!qr) return;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || document.visibilityState !== "visible") return;
      if (Date.now() >= qr.expiresAt) {
        setError("扫码请求已过期，请重新生成。");
        setQr(null);
        return;
      }
      const result = await window.pickup.account({ action: "pollHandoff" });
      if (!active) return;
      if (!result.ok) {
        setError(result.message);
        setQr(null);
        return;
      }
      if (!result.value.pending) {
        onStatus(result.value.status);
        setQr(null);
        setNotice("扫码登录成功。");
        return;
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
    };
    timer = setTimeout(() => void poll(), 1000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [qr, onStatus]);
  async function scanLogin() {
    if (!Capacitor.isNativePlatform()) {
      setError("浏览器可在下方粘贴电脑登录码。");
      return;
    }
    try {
      const code = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "扫描电脑的登录二维码",
      });
      setLoginCode(code.ScanResult);
      await act({ action: "inspectHandoff", payload: code.ScanResult });
    } catch {
      setError("扫码未完成，可使用粘贴电脑登录码。");
    }
  }
  return (
    <div className="account-panel">
      <div className="sync-heading">
        <KeyRound size={19} aria-hidden="true" />
        <div>
          <h3>自己的账户，自己的线索。</h3>
          <p className="helper">
            端到端加密；服务器无法读取任务。邮箱暂不验证。
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="helper">
          {notice}
        </p>
      ) : null}
      {shownCode ? (
        <section className="account-recovery" aria-label="保存恢复码">
          <h4>请离线保存恢复码</h4>
          <p className="helper">
            只展示这一次。忘记密码且丢失恢复码后，任何人都无法解密你的数据。请勿分享。
          </p>
          <Field id="account-shown-recovery" label="恢复码（仅此一次）">
            <textarea
              id="account-shown-recovery"
              readOnly
              rows={3}
              value={shownCode}
            />
          </Field>
          <label className="account-check">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            我已离线保存恢复码
          </label>
          <Button
            disabled={!saved || busy}
            onClick={() =>
              void act({ action: "ackRecovery" }).then((result) => {
                if (result) setShownCode("");
              })
            }
          >
            完成保存
          </Button>
        </section>
      ) : null}
      {status?.enabled && !status.stopped ? (
        <>
          <p className="account-identity">
            <ShieldCheck size={17} aria-hidden="true" />
            {status.accountEmail ?? "通过配对码连接"}
          </p>
          <Button
            kind="ghost"
            disabled={busy}
            icon={<LogOut size={16} />}
            onClick={() => void act({ action: "logout" })}
          >
            退出
          </Button>
          <p className="helper">退出保留本地任务；不会撤销已分享的配对密钥。</p>
          {window.pickup.host === "mobile" && status.accountEmail ? (
            <>
              <Button
                kind="secondary"
                icon={<QrCode size={18} />}
                disabled={busy}
                onClick={() => void scanLogin()}
              >
                扫码登录电脑
              </Button>
              <details className="account-advanced">
                <summary>粘贴电脑登录码</summary>
                <Field id="desktop-login-code" label="电脑登录码">
                  <textarea
                    id="desktop-login-code"
                    rows={3}
                    value={loginCode}
                    onChange={(e) => setLoginCode(e.target.value)}
                  />
                </Field>
                <Button
                  kind="secondary"
                  disabled={busy || !loginCode.trim()}
                  onClick={() =>
                    void act({ action: "inspectHandoff", payload: loginCode })
                  }
                >
                  检查登录请求
                </Button>
              </details>
            </>
          ) : null}
        </>
      ) : (
        <>
          <p className="helper">
            登录会把本机已有记录合并到此账户；退出不会删除本地记录。请仅在自己的设备使用。
          </p>
          <div className="account-tabs" aria-label="账户操作">
            {(
              [
                ["login", "登录"],
                ["register", "注册"],
                ["recover", "找回密码"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                kind={mode === value ? "secondary" : "ghost"}
                disabled={busy}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setError("");
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                mode === "recover"
                  ? {
                      action: mode,
                      serverUrl,
                      email,
                      password,
                      recoveryCode: recovery,
                    }
                  : { action: mode, serverUrl, email, password },
              );
            }}
          >
            <Field id="account-email" label="邮箱">
              <input
                id="account-email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field
              id="account-password"
              label={mode === "recover" ? "新密码" : "密码"}
              hint="至少 10 个字符；密码不会发送到服务器。"
            >
              <input
                id="account-password"
                type="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                minLength={10}
                maxLength={1024}
                required
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {mode === "recover" ? (
              <Field id="account-recovery" label="恢复码">
                <textarea
                  id="account-recovery"
                  required
                  rows={3}
                  value={recovery}
                  disabled={busy}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setRecovery(e.target.value)}
                />
              </Field>
            ) : null}
            <details className="account-advanced">
              <summary>高级</summary>
              <Field
                id="account-server"
                label="账户服务器"
                hint="默认使用 PickUp 中央服务。自建服务必须使用 HTTPS；localhost 仅供开发。"
              >
                <input
                  id="account-server"
                  type="url"
                  required
                  value={serverUrl}
                  disabled={busy}
                  onChange={(e) => setServerUrl(e.target.value)}
                />
              </Field>
            </details>
            <Button type="submit" disabled={busy} icon={<LogIn size={17} />}>
              {busy
                ? "正在安全处理…"
                : mode === "register"
                  ? "注册并加密同步"
                  : mode === "recover"
                    ? "重设密码并登录"
                    : "登录并同步"}
            </Button>
          </form>
          {window.pickup.host === "desktop" ? (
            <Button
              kind="ghost"
              disabled={busy}
              icon={<QrCode size={17} />}
              onClick={() => void act({ action: "beginHandoff", serverUrl })}
            >
              扫码登录
            </Button>
          ) : null}
        </>
      )}
      {confirmation ? (
        <div
          className="account-confirm"
          role="region"
          aria-label="确认电脑登录"
        >
          <h4>确认在这台电脑登录？</h4>
          <p>{confirmation.email}</p>
          <p className="helper">{confirmation.serverUrl}</p>
          <p className="helper">
            仅确认你正在操作的电脑。确认后，该电脑可读取和修改全部同步数据。
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void act({ action: "approveHandoff", payload: loginCode }).then(
                (result) => {
                  if (result) {
                    setConfirmation(undefined);
                    setLoginCode("");
                    setNotice("已授权电脑登录。");
                  }
                },
              )
            }
          >
            确认登录电脑
          </Button>
          <Button
            kind="ghost"
            disabled={busy}
            onClick={() => setConfirmation(undefined)}
          >
            取消
          </Button>
        </div>
      ) : null}
      {qr
        ? createPortal(
            <Modal
              title="扫码登录"
              stacked
              eyebrow="手机确认 / 安全接续"
              onClose={() => {
                setQr(null);
                void window.pickup.account({ action: "cancelHandoff" });
              }}
            >
              <p className="helper">
                用已登录的手机打开同步，点“扫码登录电脑”，核对服务器和账户后确认。二维码
                2 分钟内有效。
              </p>
              <div className="sync-qr">
                <img
                  src={qr.image}
                  width={320}
                  height={320}
                  alt="电脑登录二维码"
                />
              </div>
              <p role="status" className="helper">
                等待手机确认… 到期时间{" "}
                {new Date(qr.expiresAt).toLocaleTimeString()}
              </p>
              <Button
                kind="ghost"
                icon={<Copy size={16} />}
                onClick={() => void copyLogin()}
              >
                复制登录码
              </Button>
              {copyMessage ? (
                <p role="status" className="helper">
                  {copyMessage}
                </p>
              ) : null}
              <Button
                kind="ghost"
                onClick={() => {
                  setQr(null);
                  void window.pickup.account({ action: "cancelHandoff" });
                }}
              >
                取消扫码登录
              </Button>
            </Modal>,
            document.body,
          )
        : null}
    </div>
  );
}
