import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { PreferenceState } from "../../../shared/contracts";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  onClose: () => void;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function SettingsDialog({ onClose, onNotice }: Props) {
  const [state, setState] = useState<PreferenceState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accelerator, setAccelerator] = useState("");

  async function load() {
    const result = await window.pickup.getPreferences();
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setState(result.value);
    setAccelerator(result.value.values.accelerator);
    setError("");
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
        if (result.code === "STATE_CONFLICT") await load();
        return;
      }
      setState(result.value.preferences);
      setAccelerator(result.value.preferences.values.accelerator);
      onNotice(success);
    } finally {
      setBusy(false);
    }
  }

  const values = state?.values;

  return (
    <Modal eyebrow="Preferences / F07" title="让入口安静。" onClose={onClose}>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="helper" style={{ marginTop: 0 }}>
        偏好保存在本地数据库。托盘、全局快捷键、开机启动和独立窗口仍待桌面集成接入，开关不会假装已经对操作系统生效。
      </p>
      <ToggleRow
        title="显示桌面入口"
        detail="已写入偏好。独立 widget 窗口尚未创建，打开后不会出现悬浮窗。"
        on={values?.widgetEnabled ?? true}
        disabled={!values || busy}
        label="切换桌面入口偏好"
        onToggle={() =>
          void patch(
            { widgetEnabled: !values?.widgetEnabled },
            values?.widgetEnabled
              ? "已保存：下次桌面入口接入后将保持隐藏。"
              : "已保存：桌面入口偏好为显示，窗口仍待桌面集成创建。",
          )
        }
      />
      <ToggleRow
        title="入口置顶"
        detail="仅保存期望值。置顶行为由桌面窗口接管后才会生效。"
        on={values?.widgetPinned ?? false}
        disabled={!values || busy}
        label="切换入口置顶偏好"
        onToggle={() =>
          void patch(
            { widgetPinned: !values?.widgetPinned },
            "已保存置顶偏好，操作系统窗口尚未应用。",
          )
        }
      />
      <ToggleRow
        title="开机启动"
        detail="默认关闭。当前只保存偏好，不会向系统注册启动项。"
        on={values?.launchAtLogin ?? false}
        disabled={!values || busy}
        label="切换开机启动偏好"
        onToggle={() =>
          void patch(
            { launchAtLogin: !values?.launchAtLogin },
            "已保存开机启动偏好，尚未向操作系统注册。",
          )
        }
      />
      <div className="toggle-row">
        <div>
          <strong>快速记录快捷键</strong>
          <span>
            当前未向系统注册全局快捷键。主窗口内仍可用“记一件事”打开记录框。
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
            void patch(
              { accelerator: accelerator.trim() },
              "已保存快捷键偏好，全局注册仍待桌面集成。",
            );
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
