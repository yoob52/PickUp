-- 010: 内置集成开关、Obsidian 本机 Vault 配置与通用外部链接扩展（均不进同步队列）

CREATE TABLE IF NOT EXISTS integration_settings (
  provider TEXT PRIMARY KEY CHECK (provider IN ('notion', 'obsidian')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO integration_settings(provider, enabled, updated_at) VALUES ('notion', 0, 0);
INSERT OR IGNORE INTO integration_settings(provider, enabled, updated_at) VALUES ('obsidian', 0, 0);

CREATE TABLE IF NOT EXISTS obsidian_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  vault_path TEXT NOT NULL DEFAULT '',
  daily_folder TEXT NOT NULL DEFAULT 'Daily',
  daily_filename_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
  todo_source_path TEXT NOT NULL DEFAULT '',
  todo_tag TEXT NOT NULL DEFAULT '',
  auto_writeback INTEGER NOT NULL DEFAULT 0 CHECK (auto_writeback IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO obsidian_config(singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS integration_daily_exports (
  provider TEXT NOT NULL CHECK (provider IN ('notion', 'obsidian')),
  day_key TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  target_path TEXT NOT NULL DEFAULT '',
  exported_at INTEGER NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day_key)
);

CREATE TABLE IF NOT EXISTS external_links_next (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('notion', 'obsidian')),
  external_id TEXT NOT NULL,
  external_type TEXT NOT NULL CHECK (external_type IN ('database_item', 'todo_block', 'markdown_todo')),
  external_url TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  last_synced_at INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);

INSERT OR IGNORE INTO external_links_next(
  task_id, provider, external_id, external_type, external_url, source_title, due_date, last_synced_at
)
SELECT
  task_id, provider, external_id, external_type, external_url, source_title, due_date, last_synced_at
FROM external_links;

DROP TABLE external_links;
ALTER TABLE external_links_next RENAME TO external_links;
CREATE INDEX IF NOT EXISTS ix_external_links_provider ON external_links(provider, external_id);
