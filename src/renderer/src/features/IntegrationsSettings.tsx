import { useEffect, useState } from "react";
import {
  BookOpen,
  FolderOpen,
  Link2,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";
import type {
  NotionConfig,
  NotionSourceType,
  NotionTargetOption,
} from "../../../shared/notion-contracts";
import type { ObsidianConfig } from "../../../shared/obsidian-contracts";
import { Button } from "../ui/primitives";

export type IntegrationsEnabledState = {
  notion: boolean;
  obsidian: boolean;
};

type Props = {
  onNotice: (text: string, tone?: "ok" | "error") => void;
  onEnabledChange?: (next: IntegrationsEnabledState) => void;
};

export function IntegrationsSettings({ onNotice, onEnabledChange }: Props) {
  const [notion, setNotion] = useState<NotionConfig | null>(null);
  const [obsidian, setObsidian] = useState<ObsidianConfig | null>(null);
  const [targets, setTargets] = useState<NotionTargetOption[]>([]);
  const [tokenInput, setTokenInput] = useState("");
  const [notionBusy, setNotionBusy] = useState(false);
  const [notionError, setNotionError] = useState("");

  const [obsidianBusy, setObsidianBusy] = useState(false);
  const [obsidianError, setObsidianError] = useState("");
  const [vaultPathDraft, setVaultPathDraft] = useState("");
  const [dailyFolderDraft, setDailyFolderDraft] = useState("Daily");
  const [dailyFormatDraft, setDailyFormatDraft] = useState("YYYY-MM-DD");
  const [todoSourceDraft, setTodoSourceDraft] = useState("");
  const [todoTagDraft, setTodoTagDraft] = useState("");
  const [vaultInfo, setVaultInfo] = useState("");

  function emitEnabled(
    nextNotion: NotionConfig | null,
    nextObsidian: ObsidianConfig | null,
  ) {
    onEnabledChange?.({
      notion: nextNotion?.enabled ?? false,
      obsidian: nextObsidian?.enabled ?? false,
    });
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

  async function loadAll() {
    const [notionRes, obsidianRes] = await Promise.all([
      window.pickup.notion({ action: "getConfig" }),
      window.pickup.obsidian({ action: "getConfig" }),
    ]);
    let nextNotion: NotionConfig | null = null;
    let nextObsidian: ObsidianConfig | null = null;

    if (notionRes.ok && notionRes.value.action === "getConfig") {
      nextNotion = notionRes.value.config;
      setNotion(nextNotion);
      setNotionError("");
      if (nextNotion.enabled && nextNotion.hasToken) {
        void loadTargets();
      }
    } else if (!notionRes.ok) {
      setNotionError(notionRes.message);
    }

    if (obsidianRes.ok && obsidianRes.value.action === "getConfig") {
      nextObsidian = obsidianRes.value.config;
      setObsidian(nextObsidian);
      setVaultPathDraft(nextObsidian.vaultPath);
      setDailyFolderDraft(nextObsidian.dailyFolder);
      setDailyFormatDraft(nextObsidian.dailyFilenameFormat || "YYYY-MM-DD");
      setTodoSourceDraft(nextObsidian.todoSourcePath);
      setTodoTagDraft(nextObsidian.todoTag);
      setObsidianError("");
    } else if (!obsidianRes.ok) {
      setObsidianError(obsidianRes.message);
    }

    emitEnabled(nextNotion, nextObsidian);
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function saveNotionPatch(
    patch: {
      enabled?: boolean;
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
    if (notionBusy) return;
    setNotionBusy(true);
    setNotionError("");
    try {
      const res = await window.pickup.notion({
        action: "saveConfig",
        ...patch,
      });
      if (!res.ok || res.value.action !== "saveConfig") {
        const msg = !res.ok ? res.message : "保存 Notion 配置失败。";
        setNotionError(msg);
        onNotice(msg, "error");
        return;
      }
      setNotion(res.value.config);
      emitEnabled(res.value.config, obsidian);
      if (patch.clearToken) {
        setTargets([]);
        setTokenInput("");
      } else if (patch.enabled && res.value.config.hasToken) {
        void loadTargets();
      }
      onNotice(successMsg);
    } finally {
      setNotionBusy(false);
    }
  }

  async function handleTestAndSaveNotionToken() {
    if (notionBusy) return;
    const candidate = tokenInput.trim();
    if (!candidate && !notion?.hasToken) {
      setNotionError("请先粘贴 Notion Internal Integration Token。");
      return;
    }
    setNotionBusy(true);
    setNotionError("");
    try {
      const testRes = await window.pickup.notion({
        action: "testConnection",
        ...(candidate ? { token: candidate } : {}),
      });
      if (!testRes.ok || testRes.value.action !== "testConnection") {
        const msg = !testRes.ok ? testRes.message : "连接测试失败。";
        setNotionError(msg);
        onNotice(msg, "error");
        return;
      }
      setTargets(testRes.value.targets);

      const saveRes = await window.pickup.notion({
        action: "saveConfig",
        enabled: true,
        ...(candidate ? { token: candidate } : {}),
        workspaceName: testRes.value.workspaceName,
      });
      if (!saveRes.ok || saveRes.value.action !== "saveConfig") {
        const msg = !saveRes.ok ? saveRes.message : "保存配置失败。";
        setNotionError(msg);
        onNotice(msg, "error");
        return;
      }
      setNotion(saveRes.value.config);
      emitEnabled(saveRes.value.config, obsidian);
      setTokenInput("");
      onNotice(`已连接 Notion 工作区：${testRes.value.workspaceName}`);
    } finally {
      setNotionBusy(false);
    }
  }

  async function saveObsidianPatch(
    patch: {
      enabled?: boolean;
      vaultPath?: string;
      dailyFolder?: string;
      dailyFilenameFormat?: string;
      todoSourcePath?: string;
      todoTag?: string;
      autoWriteback?: boolean;
    },
    successMsg: string,
  ) {
    if (obsidianBusy) return;
    setObsidianBusy(true);
    setObsidianError("");
    try {
      const res = await window.pickup.obsidian({
        action: "saveConfig",
        ...patch,
      });
      if (!res.ok || res.value.action !== "saveConfig") {
        const msg = !res.ok ? res.message : "保存 Obsidian 配置失败。";
        setObsidianError(msg);
        onNotice(msg, "error");
        return;
      }
      const next = res.value.config;
      setObsidian(next);
      setVaultPathDraft(next.vaultPath);
      setDailyFolderDraft(next.dailyFolder);
      setDailyFormatDraft(next.dailyFilenameFormat || "YYYY-MM-DD");
      setTodoSourceDraft(next.todoSourcePath);
      setTodoTagDraft(next.todoTag);
      emitEnabled(notion, next);
      onNotice(successMsg);
    } finally {
      setObsidianBusy(false);
    }
  }

  async function handlePickVault() {
    if (obsidianBusy) return;
    setObsidianBusy(true);
    setObsidianError("");
    try {
      const picked = await window.pickup.obsidian({ action: "pickVault" });
      if (!picked.ok || picked.value.action !== "pickVault") {
        const msg = !picked.ok ? picked.message : "无法打开目录选择器。";
        setObsidianError(msg);
        onNotice(msg, "error");
        return;
      }
      if (!picked.value.vaultPath) return;
      const chosenPath = picked.value.vaultPath;
      const testRes = await window.pickup.obsidian({
        action: "testVault",
        vaultPath: chosenPath,
      });
      if (!testRes.ok || testRes.value.action !== "testVault") {
        const msg = !testRes.ok ? testRes.message : "无法访问所选目录。";
        setObsidianError(msg);
        onNotice(msg, "error");
        return;
      }
      const saveRes = await window.pickup.obsidian({
        action: "saveConfig",
        enabled: true,
        vaultPath: testRes.value.vaultPath,
      });
      if (!saveRes.ok || saveRes.value.action !== "saveConfig") {
        const msg = !saveRes.ok ? saveRes.message : "保存 Vault 路径失败。";
        setObsidianError(msg);
        onNotice(msg, "error");
        return;
      }
      setObsidian(saveRes.value.config);
      setVaultPathDraft(saveRes.value.config.vaultPath);
      setVaultInfo(
        `已识别 Vault「${testRes.value.vaultName}」（${testRes.value.markdownCount} 篇笔记）`,
      );
      emitEnabled(notion, saveRes.value.config);
      onNotice(`已绑定 Obsidian Vault：${testRes.value.vaultName}`);
    } finally {
      setObsidianBusy(false);
    }
  }

  async function handleTestAndSaveVault() {
    if (obsidianBusy) return;
    const candidate = vaultPathDraft.trim();
    if (!candidate) {
      setObsidianError("请先选择或填写 Obsidian Vault 目录路径。");
      return;
    }
    setObsidianBusy(true);
    setObsidianError("");
    try {
      const testRes = await window.pickup.obsidian({
        action: "testVault",
        vaultPath: candidate,
      });
      if (!testRes.ok || testRes.value.action !== "testVault") {
        const msg = !testRes.ok ? testRes.message : "目录校验失败。";
        setObsidianError(msg);
        onNotice(msg, "error");
        return;
      }
      const saveRes = await window.pickup.obsidian({
        action: "saveConfig",
        vaultPath: testRes.value.vaultPath,
        dailyFolder: dailyFolderDraft.trim(),
        dailyFilenameFormat: dailyFormatDraft.trim() || "YYYY-MM-DD",
        todoSourcePath: todoSourceDraft.trim(),
        todoTag: todoTagDraft.trim(),
      });
      if (!saveRes.ok || saveRes.value.action !== "saveConfig") {
        const msg = !saveRes.ok ? saveRes.message : "保存 Obsidian 配置失败。";
        setObsidianError(msg);
        onNotice(msg, "error");
        return;
      }
      setObsidian(saveRes.value.config);
      setVaultPathDraft(saveRes.value.config.vaultPath);
      setVaultInfo(
        `已识别 Vault「${testRes.value.vaultName}」（${testRes.value.markdownCount} 篇笔记）`,
      );
      emitEnabled(notion, saveRes.value.config);
      onNotice("Obsidian 集成配置已保存。");
    } finally {
      setObsidianBusy(false);
    }
  }

  const pageTargets = targets.filter((t) => t.type === "page");

  return (
    <section className="integrations-section" aria-label="内置集成">
      <div className="integrations-header">
        <div>
          <h3>内置集成</h3>
          <p>
            默认全部关闭，按需启用。未启用任何集成时，主界面与今日收尾保持安静，不显示额外入口。
          </p>
        </div>
      </div>

      {/* Notion Card */}
      <article
        className={
          notion?.enabled ? "integration-card enabled" : "integration-card"
        }
      >
        <div className="integration-card-head">
          <div className="integration-card-title">
            <span className="integration-icon" aria-hidden="true">
              <Link2 size={16} />
            </span>
            <div>
              <div className="integration-name-row">
                <strong>Notion</strong>
                <span
                  className={
                    notion?.enabled && notion.connected
                      ? "notion-badge synced-pill"
                      : "notion-badge"
                  }
                >
                  {!notion?.enabled
                    ? "未启用"
                    : notion.connected
                      ? `已连接 · ${notion.workspaceName}`
                      : "待配置"}
                </span>
              </div>
              <span className="integration-desc">
                双向导入数据库待办与页面 To-do，支持每日收尾一键写入。
              </span>
            </div>
          </div>
          <button
            type="button"
            className={notion?.enabled ? "toggle on" : "toggle"}
            aria-pressed={notion?.enabled ?? false}
            aria-label="启用 Notion 集成"
            disabled={!notion || notionBusy}
            onClick={() =>
              void saveNotionPatch(
                { enabled: !notion?.enabled },
                notion?.enabled
                  ? "已停用 Notion 集成。"
                  : "已启用 Notion 集成。",
              )
            }
          />
        </div>

        {notion?.enabled ? (
          <div className="integration-card-body">
            {notionError ? (
              <p className="field-error" role="alert">
                {notionError}
              </p>
            ) : null}

            <div className="notion-field">
              <label htmlFor="notion-token-input">
                Internal Integration Token
              </label>
              <div className="notion-token-row">
                <input
                  id="notion-token-input"
                  className="notion-input"
                  type="password"
                  value={tokenInput}
                  disabled={notionBusy}
                  placeholder={
                    notion.hasToken
                      ? `已保存（${notion.tokenHint}），留空可保持不变`
                      : "粘贴 ntn_... 或 secret_... 开头令牌"
                  }
                  onChange={(event) => setTokenInput(event.target.value)}
                />
                <Button
                  kind="secondary"
                  disabled={notionBusy}
                  onClick={() => void handleTestAndSaveNotionToken()}
                >
                  {tokenInput.trim() ? "验证并保存" : "测试连接"}
                </Button>
                {notion.hasToken ? (
                  <Button
                    kind="ghost"
                    icon={<Trash2 size={14} />}
                    disabled={notionBusy}
                    onClick={() =>
                      void saveNotionPatch(
                        { clearToken: true },
                        "已清除本机 Notion 令牌。",
                      )
                    }
                  >
                    断开
                  </Button>
                ) : null}
              </div>
            </div>

            {notion.hasToken ? (
              <>
                <div className="notion-field-grid">
                  <div className="notion-field">
                    <label htmlFor="notion-daily-parent">
                      日报写入父页面（每天生成一页）
                    </label>
                    <select
                      id="notion-daily-parent"
                      className="notion-select"
                      value={notion.dailyParentId}
                      disabled={notionBusy}
                      onChange={(event) => {
                        const id = event.target.value;
                        const target = pageTargets.find(
                          (item) => item.id === id,
                        );
                        void saveNotionPatch(
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
                      {notion.dailyParentId &&
                      !pageTargets.some(
                        (t) => t.id === notion.dailyParentId,
                      ) ? (
                        <option value={notion.dailyParentId}>
                          {notion.dailyParentTitle || notion.dailyParentId}
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
                    <label htmlFor="notion-import-source">
                      待办 / 日程导入来源
                    </label>
                    <select
                      id="notion-import-source"
                      className="notion-select"
                      value={notion.importSourceId}
                      disabled={notionBusy}
                      onChange={(event) => {
                        const id = event.target.value;
                        const target = targets.find((item) => item.id === id);
                        void saveNotionPatch(
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
                      {notion.importSourceId &&
                      !targets.some((t) => t.id === notion.importSourceId) ? (
                        <option value={notion.importSourceId}>
                          {notion.importSourceTitle || notion.importSourceId}
                        </option>
                      ) : null}
                      {targets.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}（
                          {item.type === "database" ? "数据库" : "页面"}）
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="notion-refresh-row">
                  <Button
                    kind="ghost"
                    icon={<RefreshCw size={13} />}
                    disabled={notionBusy}
                    onClick={() => void loadTargets()}
                  >
                    刷新可访问页面与数据库
                  </Button>
                </div>

                <div className="toggle-row notion-writeback-row">
                  <div>
                    <strong>完成后自动回写 Notion</strong>
                    <span>
                      在 PickUp 标记已完成时，异步勾选对应 Notion To-do
                      或将状态改为完成。
                    </span>
                  </div>
                  <button
                    type="button"
                    className={notion.autoWriteback ? "toggle on" : "toggle"}
                    aria-pressed={notion.autoWriteback}
                    aria-label="切换完成后自动回写 Notion"
                    disabled={notionBusy}
                    onClick={() =>
                      void saveNotionPatch(
                        { autoWriteback: !notion.autoWriteback },
                        notion.autoWriteback
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
              Token 经系统密钥链加密后仅保存在本机，不进入云同步。
            </p>
          </div>
        ) : null}
      </article>

      {/* Obsidian Card */}
      <article
        className={
          obsidian?.enabled ? "integration-card enabled" : "integration-card"
        }
      >
        <div className="integration-card-head">
          <div className="integration-card-title">
            <span className="integration-icon" aria-hidden="true">
              <BookOpen size={16} />
            </span>
            <div>
              <div className="integration-name-row">
                <strong>Obsidian</strong>
                <span
                  className={
                    obsidian?.enabled && obsidian.configured
                      ? "notion-badge synced-pill"
                      : "notion-badge"
                  }
                >
                  {!obsidian?.enabled
                    ? "未启用"
                    : obsidian.configured
                      ? "已绑定 Vault"
                      : "待选择目录"}
                </span>
              </div>
              <span className="integration-desc">
                直连本机 Vault Markdown：扫描 `- [ ]`
                待办、写入每日笔记并支持回写勾选。
              </span>
            </div>
          </div>
          <button
            type="button"
            className={obsidian?.enabled ? "toggle on" : "toggle"}
            aria-pressed={obsidian?.enabled ?? false}
            aria-label="启用 Obsidian 集成"
            disabled={!obsidian || obsidianBusy}
            onClick={() =>
              void saveObsidianPatch(
                { enabled: !obsidian?.enabled },
                obsidian?.enabled
                  ? "已停用 Obsidian 集成。"
                  : "已启用 Obsidian 集成。",
              )
            }
          />
        </div>

        {obsidian?.enabled ? (
          <div className="integration-card-body">
            {obsidianError ? (
              <p className="field-error" role="alert">
                {obsidianError}
              </p>
            ) : null}

            <div className="notion-field">
              <label htmlFor="obsidian-vault-input">本机 Vault 目录</label>
              <div className="notion-token-row">
                <input
                  id="obsidian-vault-input"
                  className="notion-input"
                  type="text"
                  value={vaultPathDraft}
                  disabled={obsidianBusy}
                  placeholder="选择或输入 Obsidian Vault 根目录路径"
                  onChange={(event) => setVaultPathDraft(event.target.value)}
                />
                <Button
                  kind="secondary"
                  icon={<FolderOpen size={14} />}
                  disabled={obsidianBusy}
                  onClick={() => void handlePickVault()}
                >
                  选择目录
                </Button>
              </div>
              {vaultInfo ? (
                <span className="obsidian-vault-info">{vaultInfo}</span>
              ) : null}
            </div>

            <div className="notion-field-grid">
              <div className="notion-field">
                <label htmlFor="obsidian-daily-folder">
                  日报文件夹（相对路径）
                </label>
                <input
                  id="obsidian-daily-folder"
                  className="notion-input"
                  type="text"
                  value={dailyFolderDraft}
                  disabled={obsidianBusy}
                  placeholder="例如 Daily（留空写到根目录）"
                  onChange={(event) => setDailyFolderDraft(event.target.value)}
                />
              </div>

              <div className="notion-field">
                <label htmlFor="obsidian-daily-format">日报文件名格式</label>
                <input
                  id="obsidian-daily-format"
                  className="notion-input"
                  type="text"
                  value={dailyFormatDraft}
                  disabled={obsidianBusy}
                  placeholder="YYYY-MM-DD"
                  onChange={(event) => setDailyFormatDraft(event.target.value)}
                />
              </div>
            </div>

            <div className="notion-field-grid">
              <div className="notion-field">
                <label htmlFor="obsidian-todo-source">
                  待办扫描范围（可选）
                </label>
                <input
                  id="obsidian-todo-source"
                  className="notion-input"
                  type="text"
                  value={todoSourceDraft}
                  disabled={obsidianBusy}
                  placeholder="留空扫描整个 Vault，如 Projects/Inbox.md"
                  onChange={(event) => setTodoSourceDraft(event.target.value)}
                />
              </div>

              <div className="notion-field">
                <label htmlFor="obsidian-todo-tag">标签过滤（可选）</label>
                <input
                  id="obsidian-todo-tag"
                  className="notion-input"
                  type="text"
                  value={todoTagDraft}
                  disabled={obsidianBusy}
                  placeholder="例如 #todo，留空匹配所有未勾选待办"
                  onChange={(event) => setTodoTagDraft(event.target.value)}
                />
              </div>
            </div>

            <div className="notion-refresh-row">
              <Button
                kind="secondary"
                disabled={obsidianBusy}
                onClick={() => void handleTestAndSaveVault()}
              >
                校验目录并保存配置
              </Button>
            </div>

            <div className="toggle-row notion-writeback-row">
              <div>
                <strong>完成后自动回写 Obsidian</strong>
                <span>
                  在 PickUp 标记已完成时，自动把对应 Markdown 中的 `- [ ]` 改为
                  `- [x]`。
                </span>
              </div>
              <button
                type="button"
                className={obsidian.autoWriteback ? "toggle on" : "toggle"}
                aria-pressed={obsidian.autoWriteback}
                aria-label="切换完成后自动回写 Obsidian"
                disabled={obsidianBusy}
                onClick={() =>
                  void saveObsidianPatch(
                    { autoWriteback: !obsidian.autoWriteback },
                    obsidian.autoWriteback
                      ? "已关闭 Obsidian 完成回写。"
                      : "已开启 Obsidian 完成自动回写。",
                  )
                }
              />
            </div>

            <p className="notion-security-note">
              <Shield size={14} aria-hidden="true" />
              纯本机 Markdown 文件读写，严格限定在所选 Vault
              内，不联网也不进入云同步。
            </p>
          </div>
        ) : null}
      </article>
    </section>
  );
}
