import { useEffect, useState } from "react";
import { Link2, RefreshCw, Shield, Trash2 } from "lucide-react";
import type {
  NotionConfig,
  NotionSourceType,
  NotionTargetOption,
} from "../../../shared/notion-contracts";
import { Button } from "../ui/primitives";

type Props = {
  onNotice: (text: string, tone?: "ok" | "error") => void;
  onConfigChange?: (config: NotionConfig) => void;
};

export function NotionSettings({ onNotice, onConfigChange }: Props) {
  const [config, setConfig] = useState<NotionConfig | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [targets, setTargets] = useState<NotionTargetOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function loadConfig() {
    const result = await window.pickup.notion({ action: "getConfig" });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.value.action === "getConfig") {
      setConfig(result.value.config);
      onConfigChange?.(result.value.config);
      setError("");
      if (result.value.config.hasToken) {
        void loadTargets();
      }
    }
  }

  async function loadTargets(inlineToken?: string) {
    const result = await window.pickup.notion({
      action: "listTargets",
      ...(inlineToken ? { token: inlineToken } : {}),
    });
    if (result.ok && result.value.action === "listTargets") {
      setTargets(result.value.targets);
    }
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  async function handleTestAndSaveToken() {
    if (busy) return;
    const candidate = tokenInput.trim();
    if (!candidate && !config?.hasToken) {
      setError("请先粘贴 Notion Internal Integration Token。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const testRes = await window.pickup.notion({
        action: "testConnection",
        ...(candidate ? { token: candidate } : {}),
      });
      if (!testRes.ok || testRes.value.action !== "testConnection") {
        const msg = !testRes.ok ? testRes.message : "连接测试失败。";
        setError(msg);
        onNotice(msg, "error");
        return;
      }
      setTargets(testRes.value.targets);

      const saveRes = await window.pickup.notion({
        action: "saveConfig",
        ...(candidate ? { token: candidate } : {}),
        workspaceName: testRes.value.workspaceName,
      });
      if (!saveRes.ok || saveRes.value.action !== "saveConfig") {
        const msg = !saveRes.ok ? saveRes.message : "保存配置失败。";
        setError(msg);
        onNotice(msg, "error");
        return;
      }
      setConfig(saveRes.value.config);
      onConfigChange?.(saveRes.value.config);
      setTokenInput("");
      onNotice(`已连接 Notion 工作区：${testRes.value.workspaceName}`);
    } finally {
      setBusy(false);
    }
  }

  async function savePatch(
    patch: {
      dailyParentId?: string;
      dailyParentTitle?: string;
      importSourceId?: string;
      importSourceTitle?: string;
      importSourceType?: NotionSourceType;
      autoWriteback?: boolean;
      clearToken?: boolean;
    },
    successMsg: string,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await window.pickup.notion({
        action: "saveConfig",
        ...patch,
      });
      if (!res.ok || res.value.action !== "saveConfig") {
        const msg = !res.ok ? res.message : "保存 Notion 配置失败。";
        setError(msg);
        onNotice(msg, "error");
        return;
      }
      setConfig(res.value.config);
      onConfigChange?.(res.value.config);
      if (patch.clearToken) {
        setTargets([]);
        setTokenInput("");
      }
      onNotice(successMsg);
    } finally {
      setBusy(false);
    }
  }

  const pageTargets = targets.filter((t) => t.type === "page");

  return (
    <section className="notion-settings-panel" aria-label="Notion 集成">
      <div className="notion-settings-head">
        <h3>
          <Link2 size={16} aria-hidden="true" />
          Notion 集成（本机直连）
        </h3>
        <span
          className={
            config?.connected ? "notion-badge synced-pill" : "notion-badge"
          }
        >
          {config?.connected ? `已连接 · ${config.workspaceName}` : "未连接"}
        </span>
      </div>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="notion-field">
        <label htmlFor="notion-token-input">Internal Integration Token</label>
        <div className="notion-token-row">
          <input
            id="notion-token-input"
            className="notion-input"
            type="password"
            value={tokenInput}
            disabled={busy}
            placeholder={
              config?.hasToken
                ? `已保存（${config.tokenHint}），留空可保持不变`
                : "粘贴 ntn_... 或 secret_... 开头令牌"
            }
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <Button
            kind="secondary"
            disabled={busy}
            onClick={() => void handleTestAndSaveToken()}
          >
            {tokenInput.trim() ? "验证并保存" : "测试连接"}
          </Button>
          {config?.hasToken ? (
            <Button
              kind="ghost"
              icon={<Trash2 size={14} />}
              disabled={busy}
              onClick={() =>
                void savePatch({ clearToken: true }, "已清除本机 Notion 令牌。")
              }
            >
              断开
            </Button>
          ) : null}
        </div>
      </div>

      {config?.hasToken ? (
        <>
          <div className="notion-field-grid">
            <div className="notion-field">
              <label htmlFor="notion-daily-parent">
                日报写入父页面（每天生成一页）
              </label>
              <select
                id="notion-daily-parent"
                className="notion-select"
                value={config.dailyParentId}
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value;
                  const target = pageTargets.find((item) => item.id === id);
                  void savePatch(
                    {
                      dailyParentId: id,
                      dailyParentTitle: target?.title ?? "",
                    },
                    id
                      ? `日报父页面已设为「${target?.title ?? id}」。`
                      : "已清除日报父页面。",
                  );
                }}
              >
                <option value="">请选择已分享给集成的页面</option>
                {config.dailyParentId &&
                !pageTargets.some((t) => t.id === config.dailyParentId) ? (
                  <option value={config.dailyParentId}>
                    {config.dailyParentTitle || config.dailyParentId}
                  </option>
                ) : null}
                {pageTargets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="notion-field">
              <label htmlFor="notion-import-source">待办 / 日程导入来源</label>
              <select
                id="notion-import-source"
                className="notion-select"
                value={config.importSourceId}
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value;
                  const target = targets.find((item) => item.id === id);
                  void savePatch(
                    {
                      importSourceId: id,
                      importSourceTitle: target?.title ?? "",
                      importSourceType: target ? target.type : "",
                    },
                    id
                      ? `导入来源已设为「${target?.title ?? id}」。`
                      : "已清除导入来源。",
                  );
                }}
              >
                <option value="">请选择数据库或页面</option>
                {config.importSourceId &&
                !targets.some((t) => t.id === config.importSourceId) ? (
                  <option value={config.importSourceId}>
                    {config.importSourceTitle || config.importSourceId}
                  </option>
                ) : null}
                {targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}（{item.type === "database" ? "数据库" : "页面"}
                    ）
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="notion-refresh-row">
            <Button
              kind="ghost"
              icon={<RefreshCw size={13} />}
              disabled={busy}
              onClick={() => void loadTargets()}
            >
              刷新可访问页面与数据库
            </Button>
          </div>

          <div className="toggle-row notion-writeback-row">
            <div>
              <strong>完成后自动回写 Notion（可选）</strong>
              <span>
                在 PickUp 标记已完成时，异步勾选对应 Notion To-do 或将状态改为
                Done。
              </span>
            </div>
            <button
              type="button"
              className={config.autoWriteback ? "toggle on" : "toggle"}
              aria-pressed={config.autoWriteback}
              aria-label="切换完成后自动回写 Notion"
              disabled={busy}
              onClick={() =>
                void savePatch(
                  { autoWriteback: !config.autoWriteback },
                  config.autoWriteback
                    ? "已关闭完成状态回写 Notion。"
                    : "已开启完成状态自动回写 Notion。",
                )
              }
            />
          </div>
        </>
      ) : null}

      <p className="notion-security-note">
        <Shield size={14} aria-hidden="true" />
        Token
        经系统密钥链加密后仅保存在本机，不进入云同步；同步中继始终不接触任务明文。
      </p>
    </section>
  );
}
