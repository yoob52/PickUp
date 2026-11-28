import { useEffect, useState } from "react";
import { BookOpen, Check, Download, Link2, RefreshCw } from "lucide-react";
import type {
  IntegrationProvider,
  NotionConfig,
  NotionImportCandidate,
} from "../../../shared/notion-contracts";
import type {
  ObsidianConfig,
  ObsidianImportCandidate,
} from "../../../shared/obsidian-contracts";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  notionEnabled: boolean;
  obsidianEnabled: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onImported: () => Promise<boolean>;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function IntegrationImportModal({
  notionEnabled,
  obsidianEnabled,
  onClose,
  onOpenSettings,
  onImported,
  onNotice,
}: Props) {
  const initialProvider: IntegrationProvider = notionEnabled
    ? "notion"
    : "obsidian";
  const [provider, setProvider] =
    useState<IntegrationProvider>(initialProvider);

  // Notion state
  const [notionConfig, setNotionConfig] = useState<NotionConfig | null>(null);
  const [notionTab, setNotionTab] = useState<"database" | "page">("database");
  const [notionItems, setNotionItems] = useState<NotionImportCandidate[]>([]);
  const [notionSourceTitle, setNotionSourceTitle] = useState("");
  const [notionSelected, setNotionSelected] = useState<Set<string>>(new Set());

  // Obsidian state
  const [obsidianConfig, setObsidianConfig] = useState<ObsidianConfig | null>(
    null,
  );
  const [obsidianItems, setObsidianItems] = useState<ObsidianImportCandidate[]>(
    [],
  );
  const [obsidianVaultName, setObsidianVaultName] = useState("");
  const [obsidianScanned, setObsidianScanned] = useState(0);
  const [obsidianSelected, setObsidianSelected] = useState<Set<string>>(
    new Set(),
  );

  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");

  async function loadNotion(selectedTab?: "database" | "page") {
    setLoading(true);
    setError("");
    try {
      const cfgRes = await window.pickup.notion({ action: "getConfig" });
      if (!cfgRes.ok || cfgRes.value.action !== "getConfig") {
        setError(!cfgRes.ok ? cfgRes.message : "读取 Notion 配置失败。");
        return;
      }
      const cfg = cfgRes.value.config;
      setNotionConfig(cfg);
      if (!cfg.hasToken || !cfg.importSourceId) {
        setNotionItems([]);
        return;
      }
      const effectiveTab =
        selectedTab ?? (cfg.importSourceType === "page" ? "page" : "database");
      setNotionTab(effectiveTab);
      const res = await window.pickup.notion({
        action: "fetchImportItems",
        tab: effectiveTab,
      });
      if (!res.ok || res.value.action !== "fetchImportItems") {
        setError(!res.ok ? res.message : "读取 Notion 待办失败。");
        setNotionItems([]);
        return;
      }
      setNotionItems(res.value.items);
      setNotionSourceTitle(res.value.sourceTitle);
      setNotionSelected(
        new Set(
          res.value.items
            .filter((item) => !item.alreadyImported)
            .slice(0, 5)
            .map((item) => item.externalId),
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadObsidian() {
    setLoading(true);
    setError("");
    try {
      const cfgRes = await window.pickup.obsidian({ action: "getConfig" });
      if (!cfgRes.ok || cfgRes.value.action !== "getConfig") {
        setError(!cfgRes.ok ? cfgRes.message : "读取 Obsidian 配置失败。");
        return;
      }
      const cfg = cfgRes.value.config;
      setObsidianConfig(cfg);
      if (!cfg.configured) {
        setObsidianItems([]);
        return;
      }
      const res = await window.pickup.obsidian({
        action: "fetchImportItems",
      });
      if (!res.ok || res.value.action !== "fetchImportItems") {
        setError(!res.ok ? res.message : "扫描 Obsidian 待办失败。");
        setObsidianItems([]);
        return;
      }
      setObsidianItems(res.value.items);
      setObsidianVaultName(res.value.vaultName);
      setObsidianScanned(res.value.scannedFiles);
      setObsidianSelected(
        new Set(
          res.value.items
            .filter((item) => !item.alreadyImported)
            .slice(0, 5)
            .map((item) => item.externalId),
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (provider === "notion") void loadNotion();
    else void loadObsidian();
  }, [provider]);

  function toggleNotion(id: string) {
    setNotionSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleObsidian(id: string) {
    setObsidianSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleImport() {
    if (importing) return;
    if (provider === "notion") {
      const chosen = notionItems.filter(
        (item) => notionSelected.has(item.externalId) && !item.alreadyImported,
      );
      if (chosen.length === 0) return;
      setImporting(true);
      setError("");
      try {
        const payloadItems = chosen.map((item) => ({
          externalId: item.externalId,
          externalType: item.externalType,
          title: item.title,
          sourceTitle: item.sourceTitle,
          externalUrl: item.externalUrl,
          dueDate: item.dueDate,
        }));
        let totalImported = 0;
        let totalSkipped = 0;
        for (let i = 0; i < payloadItems.length; i += 50) {
          const batch = payloadItems.slice(i, i + 50);
          const res = await window.pickup.notion({
            action: "importItems",
            items: batch,
          });
          if (!res.ok || res.value.action !== "importItems") {
            if (totalImported > 0) await onImported();
            const msg = !res.ok ? res.message : "导入失败，请稍后重试。";
            setError(msg);
            onNotice(msg, "error");
            return;
          }
          totalImported += res.value.importedCount;
          totalSkipped += res.value.skippedCount;
        }
        await onImported();
        onNotice(
          totalSkipped > 0
            ? `已从 Notion 导入 ${totalImported} 项，跳过 ${totalSkipped} 项重复记录。`
            : `已从 Notion 导入 ${totalImported} 项到待处理。`,
        );
        onClose();
      } finally {
        setImporting(false);
      }
      return;
    }

    const chosen = obsidianItems.filter(
      (item) => obsidianSelected.has(item.externalId) && !item.alreadyImported,
    );
    if (chosen.length === 0) return;
    setImporting(true);
    setError("");
    try {
      const payloadItems = chosen.map((item) => ({
        externalId: item.externalId,
        title: item.title,
        filePath: item.filePath,
        sourceTitle: item.sourceTitle,
        externalUrl: item.externalUrl,
        dueDate: item.dueDate,
      }));
      let totalImported = 0;
      let totalSkipped = 0;
      for (let i = 0; i < payloadItems.length; i += 50) {
        const batch = payloadItems.slice(i, i + 50);
        const res = await window.pickup.obsidian({
          action: "importItems",
          items: batch,
        });
        if (!res.ok || res.value.action !== "importItems") {
          if (totalImported > 0) await onImported();
          const msg = !res.ok ? res.message : "导入失败，请稍后重试。";
          setError(msg);
          onNotice(msg, "error");
          return;
        }
        totalImported += res.value.importedCount;
        totalSkipped += res.value.skippedCount;
      }
      await onImported();
      onNotice(
        totalSkipped > 0
          ? `已从 Obsidian 导入 ${totalImported} 项，跳过 ${totalSkipped} 项重复记录。`
          : `已从 Obsidian 导入 ${totalImported} 项到待处理。`,
      );
      onClose();
    } finally {
      setImporting(false);
    }
  }

  const bothEnabled = notionEnabled && obsidianEnabled;
  const activeSelectedCount =
    provider === "notion" ? notionSelected.size : obsidianSelected.size;
  const needsNotionSetup =
    !notionConfig?.hasToken || !notionConfig.importSourceId;
  const needsObsidianSetup = !obsidianConfig?.configured;

  return (
    <Modal eyebrow="导入待办" title="把外部待办拉进工作台。" onClose={onClose}>
      {bothEnabled ? (
        <div
          className="import-tabs provider-tabs"
          role="tablist"
          aria-label="选择集成来源"
        >
          <button
            type="button"
            role="tab"
            aria-selected={provider === "notion"}
            className={
              provider === "notion" ? "import-tab active" : "import-tab"
            }
            onClick={() => setProvider("notion")}
          >
            <Link2 size={13} aria-hidden="true" />
            Notion
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={provider === "obsidian"}
            className={
              provider === "obsidian" ? "import-tab active" : "import-tab"
            }
            onClick={() => setProvider("obsidian")}
          >
            <BookOpen size={13} aria-hidden="true" />
            Obsidian
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      {provider === "notion" ? (
        needsNotionSetup && !loading ? (
          <div className="notion-empty-setup">
            <p>
              还没有完成 Notion 连接与导入来源配置。请先在「设置 →
              内置集成」中填入 Token 并选择一个数据库或页面。
            </p>
            <div>
              <Button
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
              >
                前往设置配置 Notion
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div
              className="import-tabs"
              role="tablist"
              aria-label="Notion 导入模式"
            >
              <button
                type="button"
                role="tab"
                aria-selected={notionTab === "database"}
                className={
                  notionTab === "database" ? "import-tab active" : "import-tab"
                }
                disabled={loading || notionConfig?.importSourceType === "page"}
                onClick={() => void loadNotion("database")}
              >
                数据库待办 / 日程
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={notionTab === "page"}
                className={
                  notionTab === "page" ? "import-tab active" : "import-tab"
                }
                disabled={
                  loading || notionConfig?.importSourceType === "database"
                }
                onClick={() => void loadNotion("page")}
              >
                页面 To-do 块
              </button>
              <Button
                kind="ghost"
                icon={<RefreshCw size={13} />}
                disabled={loading}
                onClick={() => void loadNotion(notionTab)}
              >
                刷新
              </Button>
            </div>

            {loading ? (
              <p className="helper">正在读取 Notion 未完成事项…</p>
            ) : notionItems.length === 0 ? (
              <p className="helper">
                当前来源「{notionSourceTitle || notionConfig?.importSourceTitle}
                」没有新的未完成事项。
              </p>
            ) : (
              <div className="import-list">
                {notionItems.map((item) => {
                  const checked = notionSelected.has(item.externalId);
                  return (
                    <label
                      key={item.externalId}
                      className={
                        item.alreadyImported
                          ? "import-item imported"
                          : checked
                            ? "import-item selected"
                            : "import-item"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={item.alreadyImported || checked}
                        disabled={item.alreadyImported || importing}
                        onChange={() => toggleNotion(item.externalId)}
                      />
                      <div className="import-item-main">
                        <div className="import-item-title">{item.title}</div>
                        <div className="import-item-meta">
                          <span>
                            来源：{item.sourceTitle || notionSourceTitle}
                          </span>
                          {item.dueDate ? (
                            <span className="notion-badge date-pill">
                              {item.dueDate}
                            </span>
                          ) : null}
                          {item.statusLabel ? (
                            <span className="notion-badge">
                              {item.statusLabel}
                            </span>
                          ) : null}
                          {item.alreadyImported ? (
                            <span className="notion-badge synced-pill">
                              <Check size={11} aria-hidden="true" />
                              已导入
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </>
        )
      ) : needsObsidianSetup && !loading ? (
        <div className="notion-empty-setup">
          <p>
            还没有绑定 Obsidian Vault 目录。请先在「设置 → 内置集成」中选择本机
            Vault 根目录。
          </p>
          <div>
            <Button
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              前往设置配置 Obsidian
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="import-subbar">
            <span className="helper" style={{ margin: 0 }}>
              {obsidianVaultName
                ? `Vault「${obsidianVaultName}」· 已扫描 ${obsidianScanned} 篇笔记`
                : "本机 Markdown 待办"}
            </span>
            <Button
              kind="ghost"
              icon={<RefreshCw size={13} />}
              disabled={loading}
              onClick={() => void loadObsidian()}
            >
              重新扫描
            </Button>
          </div>

          {loading ? (
            <p className="helper">正在扫描 Obsidian Vault 中的未勾选待办…</p>
          ) : obsidianItems.length === 0 ? (
            <p className="helper">
              当前范围内没有找到未勾选的 `- [ ]` 待办事项。
            </p>
          ) : (
            <div className="import-list">
              {obsidianItems.map((item) => {
                const checked = obsidianSelected.has(item.externalId);
                return (
                  <label
                    key={item.externalId}
                    className={
                      item.alreadyImported
                        ? "import-item imported"
                        : checked
                          ? "import-item selected"
                          : "import-item"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={item.alreadyImported || checked}
                      disabled={item.alreadyImported || importing}
                      onChange={() => toggleObsidian(item.externalId)}
                    />
                    <div className="import-item-main">
                      <div className="import-item-title">{item.title}</div>
                      <div className="import-item-meta">
                        <span>
                          {item.filePath}:{item.lineNumber}
                        </span>
                        {item.dueDate ? (
                          <span className="notion-badge date-pill">
                            {item.dueDate}
                          </span>
                        ) : null}
                        {item.alreadyImported ? (
                          <span className="notion-badge synced-pill">
                            <Check size={11} aria-hidden="true" />
                            已导入
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="modal-actions">
        <Button kind="secondary" onClick={onClose}>
          取消
        </Button>
        {!(
          (provider === "notion" && needsNotionSetup) ||
          (provider === "obsidian" && needsObsidianSetup)
        ) ? (
          <Button
            icon={<Download size={14} />}
            disabled={importing || activeSelectedCount === 0}
            onClick={() => void handleImport()}
          >
            {importing
              ? "正在导入…"
              : `导入已选 ${activeSelectedCount} 项到待处理`}
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}
