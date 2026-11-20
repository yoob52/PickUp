CREATE TABLE sync_device (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL UNIQUE,
  last_hlc TEXT
);

ALTER TABLE tasks ADD COLUMN content_hlc TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN status_hlc TEXT NOT NULL DEFAULT '';
ALTER TABLE app_state ADD COLUMN next_up_hlc TEXT NOT NULL DEFAULT '';
ALTER TABLE breakpoints ADD COLUMN id TEXT;
ALTER TABLE breakpoints ADD COLUMN hlc TEXT NOT NULL DEFAULT '';
ALTER TABLE task_transitions ADD COLUMN id TEXT;
ALTER TABLE task_transitions ADD COLUMN hlc TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX ux_breakpoints_id ON breakpoints(id);
CREATE UNIQUE INDEX ux_transitions_id ON task_transitions(id);
CREATE INDEX ix_breakpoints_sync_order ON breakpoints(task_id, hlc DESC, id DESC);
CREATE INDEX ix_transitions_sync_order ON task_transitions(task_id, hlc DESC, id DESC);

CREATE TABLE sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  hlc TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('task-content','task-status','breakpoint','transition','next-up')),
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_sync_entity ON sync_changes(entity, entity_id, hlc DESC, id DESC);
CREATE INDEX ix_sync_parent ON sync_changes(entity, json_extract(payload, '$.task_id'), hlc, id);

CREATE TABLE sync_dirty (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id)
);

CREATE TRIGGER sync_task_insert AFTER INSERT ON tasks BEGIN
  INSERT OR IGNORE INTO sync_dirty VALUES ('task-content', NEW.id);
  INSERT OR IGNORE INTO sync_dirty VALUES ('task-status', NEW.id);
END;
CREATE TRIGGER sync_content_update AFTER UPDATE OF title, note ON tasks
WHEN OLD.title IS NOT NEW.title OR OLD.note IS NOT NEW.note BEGIN
  INSERT OR IGNORE INTO sync_dirty VALUES ('task-content', NEW.id);
END;
CREATE TRIGGER sync_status_update AFTER UPDATE OF status, wait_reason, check_back_at, status_changed_at, ended_at ON tasks
WHEN OLD.status IS NOT NEW.status OR OLD.wait_reason IS NOT NEW.wait_reason
  OR OLD.check_back_at IS NOT NEW.check_back_at OR OLD.status_changed_at IS NOT NEW.status_changed_at
  OR OLD.ended_at IS NOT NEW.ended_at BEGIN
  INSERT OR IGNORE INTO sync_dirty VALUES ('task-status', NEW.id);
END;
CREATE TRIGGER sync_breakpoint_insert AFTER INSERT ON breakpoints BEGIN
  INSERT OR IGNORE INTO sync_dirty VALUES ('breakpoint', CAST(NEW.seq AS TEXT));
END;
CREATE TRIGGER sync_transition_insert AFTER INSERT ON task_transitions BEGIN
  INSERT OR IGNORE INTO sync_dirty VALUES ('transition', CAST(NEW.seq AS TEXT));
END;
CREATE TRIGGER sync_next_up_update AFTER UPDATE OF next_up_task_id ON app_state
WHEN OLD.next_up_task_id IS NOT NEW.next_up_task_id BEGIN
  INSERT OR IGNORE INTO sync_dirty VALUES ('next-up', 'singleton');
END;
