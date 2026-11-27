import { useEffect, useState } from "react";
import { Download, RefreshCw, SlidersHorizontal } from "lucide-react";
import type {
  NotionConfig,
  NotionImportCandidate,
} from "../../../shared/notion-contracts";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/Modal";

type Props = {
  onClose: () => void;
  onOpenSettings: () => void;
  onImported: () => Promise<boolean>;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function NotionImportModal({
  onClose,
  onOpenSettings,
  onImported,
  onNotice,
}: Props) {
  const [config, setConfig] = useState<NotionConfig | null>(null);
  const [tab, setTab] = useState<"database" | "page">("database");
  const [items, setItems] = useState<NotionImportCandidate[]>([]);
  const [sourceTitle, setSourceTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");

  async function fetchList(nextTab: "database" | "page") {
    setLoading(true);
    setError("");
    try {
      const res = await window.pickup.notion({
        action: "fetchImportItems",
        tab: nextTab,
      });
      if (!res.ok || res.value.action !== "fetchImportItems") {
        setItems([]);
        setSelected(new Set());
        setError(!res.ok ? res.message : "读取 Notion 待办失败。");
        return;
      }
      setItems(res.value.items);
      setSourceTitle(res.value.sourceTitle);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function init() {
      setLoading(true);
      const cfgRes = await window.pickup.notion({ action: "getConfig" });
      if (!active) return;
      if (!cfgRes.ok || cfgRes.value.action !== "getConfig") {
        setError(!cfgRes.ok ? cfgRes.message : "无法读取 Notion 配置。");
        setLoading(false);
        return;
      }
      const cfg = cfgRes.value.config;
      setConfig(cfg);
      if (!cfg.hasToken || !cfg.importSourceId) {
        setLoading(false);
        return;
      }
      const initialTab = cfg.importSourceType === "page" ? "page" : "database";
      setTab(initialTab);
      await fetchList(initialTab);
    }
    void init();
    return () => {
      active = false;
    };
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleImport() {
    if (importing || selected.size === 0) return;
    const chosen = items.filter(
      (item) => selected.has(item.externalId) && !item.alreadyImported,
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
          ? `已导入 ${totalImported} 项，跳过 ${totalSkipped} 项重复记录。`
          : `已从 Notion 导入 ${totalImported} 项到待处理。`,
      );
      onClose();
    } finally {
      setImporting(false);
    }
  }

  const needsSetup = !config?.hasToken || !config.importSourceId;

  return (
    <Modal
      eyebrow="NOTION 导入"
      title="把待办或日程拉进工作台。"
      onClose={onClose}
    >
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      {needsSetup && !loading ? (
        <div className="notion-empty-setup">
          <p>
            {!config?.hasToken
              ? "尚未连接 Notion。请先在设置中填入 Internal Integration Token 并选择待办或日程来源。"
              : "已连接 Notion，但尚未选择待办/日程导入来源。请先在设置中绑定一个数据库或页面。"}
          </p>
          <div className="modal-actions">
            <Button kind="secondary" onClick={onClose}>
              稍后
            </Button>
            <Button
              icon={<SlidersHorizontal size={14} />}
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              前往设置
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="import-tabs" role="tablist" aria-label="导入来源类型">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "database"}
              className={
                tab === "database" ? "import-tab active" : "import-tab"
              }
              disabled={loading || importing}
              onClick={() => {
                setTab("database");
                void fetchList("database");
              }}
            >
              数据库待办 / 今日日程
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "page"}
              className={tab === "page" ? "import-tab active" : "import-tab"}
              disabled={loading || importing}
              onClick={() => {
                setTab("page");
                void fetchList("page");
              }}
            >
              页面 To-do 块
            </button>
          </div>

          <div className="import-list">
            {loading ? (
              <div className="empty">正在从 Notion 读取待办列表…</div>
            ) : items.length === 0 ? (
              <div className="empty">
                {sourceTitle
                  ? `「${sourceTitle}」当前没有可导入的未完成事项。`
                  : "当前没有可导入的未完成事项。"}
              </div>
            ) : (
              items.map((item) => {
                const isSelected = selected.has(item.externalId);
                return (
                  <label
                    key={item.externalId}
                    className={
                      item.alreadyImported
                        ? "import-item imported"
                        : isSelected
                          ? "import-item selected"
                          : "import-item"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={item.alreadyImported || importing}
                      onChange={() => toggle(item.externalId)}
                    />
                    <div className="import-item-main">
                      <div className="import-item-title">{item.title}</div>
                      <div className="import-item-meta">
                        <span>{item.sourceTitle || sourceTitle}</span>
                        {item.dueDate ? (
                          <span className="notion-badge date-pill">
                            {item.dueDate}
                          </span>
                        ) : null}
                        {item.alreadyImported ? (
                          <span className="notion-badge synced-pill">
                            已导入 PickUp
                          </span>
                        ) : (
                          <span>状态：{item.statusLabel}</span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          <p className="helper" style={{ margin: "0 0 12px" }}>
            按外部 ID
            自动去重；导入后将创建为本机待处理任务，并随端到端加密同步到其他设备。
          </p>

          <div className="modal-actions">
            <Button kind="secondary" onClick={onClose} disabled={importing}>
              取消
            </Button>
            <Button
              kind="secondary"
              icon={<RefreshCw size={14} />}
              disabled={loading || importing}
              onClick={() => void fetchList(tab)}
            >
              刷新列表
            </Button>
            <Button
              icon={<Download size={14} />}
              disabled={selected.size === 0 || importing}
              onClick={() => void handleImport()}
            >
              {importing ? "正在导入…" : `导入已选 ${selected.size} 项`}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
