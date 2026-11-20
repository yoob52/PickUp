CREATE TABLE sync_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  server_url TEXT NOT NULL,
  root_key TEXT NOT NULL,
  pushed_cursor INTEGER NOT NULL DEFAULT 0,
  pulled_cursor INTEGER NOT NULL DEFAULT 0,
  last_success INTEGER,
  last_error TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER
);

CREATE TABLE sync_uploads (
  seq INTEGER PRIMARY KEY REFERENCES sync_changes(seq),
  blob TEXT NOT NULL
);
