ALTER TABLE tasks ADD COLUMN check_back_at INTEGER
  CHECK (check_back_at IS NULL OR status = 'waiting');

UPDATE app_state
SET next_up_task_id = NULL, next_up_version = next_up_version + 1
WHERE singleton = 1
  AND next_up_task_id IN (SELECT id FROM tasks WHERE status = 'waiting');
