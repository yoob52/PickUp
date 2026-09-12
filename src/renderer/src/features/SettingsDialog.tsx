import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { DesktopState, PreferenceState } from "../../../shared/contracts";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  onClose: () => void;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function SettingsDialog({ onClose, onNotice }: Props) {
  const [state, setState] = useState<PreferenceState | null>(null);
  const [desktop, setDesktop] = useState<DesktopState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accelerator, setAccelerator] = useState("");

  async function load() {
    const [prefs, system] = await Promise.all([
      window.pickup.getPreferences(),
      window.pickup.getDesktopState(),
    ]);
    if (!prefs.ok) {
      setError(prefs.message);
      return;
    }
    setState(prefs.value);
    setAccelerator(prefs.value.values.accelerator);
    if (system.ok) setDesktop(system.value);
    else setError(system.message);
  }

  useEffect(() => {
    void load();
  }, []);

  async function patch(
    next: Partial<PreferenceState["values"]>,
    success: string,
  ) {
    if (!state || busy) return;
    setBusy(true);
    try {
      const result = await window.pickup.updatePreference({
        patch: next,
        expectedVersion: state.version,
      });
      if (!result.ok) {
        setError(result.message);
        onNotice(result.message, "error");
        await load();
        return;
      }
      setState(result.value.preferences);
      setAccelerator(result.value.preferences.values.accelerator);
      const system = await window.pickup.getDesktopState();
      if (system.ok) setDesktop(system.value);
      setError("");
      onNotice(success);
    } finally {
      setBusy(false);
    }
  }

  const values = state?.values;

  return (
    <Modal eyebrow="设置" title="让入口安静。" onClose={onClose}>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="helper" style={{ marginTop: 0 }}>
        快捷键和开机启动会写入操作系统。失败时会显示真实状态，不会假装已经生效。
      </p>
      <ToggleRow
        title="显示桌面入口"
        detail={
          values?.widgetEnabled
            ? "轻量入口在桌面上。可移动、收起或隐藏。"
            : "入口已隐藏。仍可用快捷键和主窗口记录。"
        }
        on={values?.widgetEnabled ?? true}
        disabled={!values || busy}
        label="切换桌面入口"
        onToggle={() =>
          void patch(
            { widgetEnabled: !values?.widgetEnabled },
            values?.widgetEnabled ? "已隐藏桌面入口。" : "已显示桌面入口。",
          )
        }
      />
      <ToggleRow
        title="入口置顶"
        detail={
          values?.widgetPinned
            ? "桌面入口保持在其他窗口前面。"
            : "默认不置顶，避免挡住正在做的事。"
        }
        on={values?.widgetPinned ?? false}
        disabled={!values || busy || !values.widgetEnabled}
        label="切换入口置顶"
        onToggle={() =>
          void patch(
            { widgetPinned: !values?.widgetPinned },
            values?.widgetPinned ? "已取消置顶。" : "入口已置顶。",
          )
        }
      />
      <ToggleRow
        title="开机启动"
        detail={
          desktop && !desktop.launchAtLoginApplied
            ? "系统登录项与偏好不一致。可再试一次。"
            : values?.launchAtLogin
              ? "已加入系统登录项。开机后会在后台待命。"
              : "默认关闭。打开后会写入系统登录项。"
        }
        on={values?.launchAtLogin ?? false}
        disabled={!values || busy}
        label="切换开机启动"
        onToggle={() =>
          void patch(
            { launchAtLogin: !values?.launchAtLogin },
            values?.launchAtLogin ? "已关闭开机启动。" : "已开启开机启动。",
          )
        }
      />
      <div className="toggle-row">
        <div>
          <strong>快速记录快捷键</strong>
          <span>
            {desktop?.acceleratorRegistered
              ? `已注册 ${desktop.accelerator}。在其他软件中也可唤起。`
              : "当前组合未能注册，可能和其他程序冲突。请更换，主窗口仍可记一件事。"}
          </span>
        </div>
        <input
          className="accelerator-input"
          aria-label="快捷键组合"
          value={accelerator}
          disabled={!values || busy}
          onChange={(event) => setAccelerator(event.target.value)}
          onBlur={() => {
            if (!values || accelerator.trim() === values.accelerator) return;
            if (!accelerator.trim()) {
              setAccelerator(values.accelerator);
              return;
            }
            void patch({ accelerator: accelerator.trim() }, "快捷键已更新。");
          }}
        />
      </div>
      <div className="modal-actions">
        <Button icon={<Check size={15} />} onClick={onClose}>
          完成
        </Button>
      </div>
    </Modal>
  );
}

function ToggleRow({
  title,
  detail,
  on,
  disabled,
  label,
  onToggle,
}: {
  title: string;
  detail: string;
  on: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <button
        type="button"
        className={on ? "toggle on" : "toggle"}
        aria-pressed={on}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
      />
    </div>
  );
}
