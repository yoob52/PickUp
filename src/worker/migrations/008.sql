CREATE TABLE sync_destination (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  space_id TEXT,
  upload_device_id TEXT NOT NULL,
  pushed_cursor INTEGER NOT NULL DEFAULT 0,
  pulled_cursor INTEGER NOT NULL DEFAULT 0,
  pulled_device_id TEXT,
  pulled_client_seq INTEGER
);
INSERT INTO sync_destination
SELECT 1,NULL,coalesce(upload_device_id,(SELECT id FROM sync_device WHERE singleton=1)),
       pushed_cursor,pulled_cursor,pulled_device_id,pulled_client_seq FROM sync_config;

CREATE TABLE sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL CHECK (origin IN ('local','snapshot')),
  change_json TEXT NOT NULL CHECK (json_valid(change_json))
);
INSERT INTO sync_outbox(seq,origin,change_json)
SELECT seq,'local',json_object('id',id,'hlc',hlc,'entity',entity,'entityId',entity_id,'payload',json(payload))
FROM sync_changes WHERE substr(hlc,29)=(SELECT id FROM sync_device WHERE singleton=1);
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT max(seq) FROM sync_changes),0)) WHERE name='sync_outbox';

CREATE TABLE sync_uploads_new (
  seq INTEGER PRIMARY KEY REFERENCES sync_outbox(seq),
  blob TEXT NOT NULL
);
INSERT INTO sync_uploads_new SELECT seq,blob FROM sync_uploads WHERE seq IN (SELECT seq FROM sync_outbox);
DROP TABLE sync_uploads;
ALTER TABLE sync_uploads_new RENAME TO sync_uploads;
