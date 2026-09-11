
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('todo','doing','paused','waiting','done','cancelled')),
  wait_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL,
  status_revision INTEGER NOT NULL CHECK (status_revision >= 1),
  ended_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((status IN ('done','cancelled') AND ended_at IS NOT NULL)
      OR (status NOT IN ('done','cancelled') AND ended_at IS NULL))
);
CREATE UNIQUE INDEX ux_one_doing ON tasks(status) WHERE status = 'doing';
CREATE INDEX ix_tasks_state_order ON tasks(status, status_changed_at DESC, status_revision DESC);
CREATE INDEX ix_tasks_created ON tasks(status, created_at, id);
CREATE INDEX ix_tasks_ended ON tasks(status, ended_at DESC);

CREATE TABLE breakpoints (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  progress TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  reference_text TEXT NOT NULL DEFAULT '',
  saved_at INTEGER NOT NULL,
  CHECK (length(trim(progress)) + length(trim(next_step)) + length(trim(reference_text)) > 0)
);
CREATE INDEX ix_breakpoints_task ON breakpoints(task_id, seq DESC);

CREATE TABLE task_transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  from_status TEXT CHECK (from_status IN ('todo','doing','paused','waiting','done','cancelled')),
  to_status TEXT NOT NULL CHECK (to_status IN ('todo','doing','paused','waiting','done','cancelled')),
  changed_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);
CREATE INDEX ix_transitions_task ON task_transitions(task_id, seq DESC);

CREATE TABLE app_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  next_up_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  next_up_version INTEGER NOT NULL DEFAULT 0,
  draft_title TEXT NOT NULL DEFAULT '',
  draft_note TEXT NOT NULL DEFAULT '',
  draft_version INTEGER NOT NULL DEFAULT 0,
  preferences_json TEXT NOT NULL DEFAULT '{}',
  preferences_version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO app_state(singleton) VALUES (1);

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY NOT NULL,
  command_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);