CREATE TABLE IF NOT EXISTS notion_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token_enc TEXT NOT NULL DEFAULT '',
  token_hint TEXT NOT NULL DEFAULT '',
  workspace_name TEXT NOT NULL DEFAULT '',
  daily_parent_id TEXT NOT NULL DEFAULT '',
  daily_parent_title TEXT NOT NULL DEFAULT '',
  import_source_id TEXT NOT NULL DEFAULT '',
  import_source_title TEXT NOT NULL DEFAULT '',
  import_source_type TEXT NOT NULL DEFAULT '' CHECK (import_source_type IN ('', 'database', 'page')),
  auto_writeback INTEGER NOT NULL DEFAULT 0 CHECK (auto_writeback IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO notion_config(singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS external_links (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('notion')),
  external_id TEXT NOT NULL,
  external_type TEXT NOT NULL CHECK (external_type IN ('database_item', 'todo_block')),
  external_url TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  last_synced_at INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);
CREATE INDEX IF NOT EXISTS ix_external_links_provider ON external_links(provider, external_id);

CREATE TABLE IF NOT EXISTS notion_daily_exports (
  day_key TEXT PRIMARY KEY NOT NULL,
  parent_page_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_url TEXT NOT NULL DEFAULT '',
  exported_at INTEGER NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0
);
