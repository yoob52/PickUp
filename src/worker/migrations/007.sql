ALTER TABLE sync_config ADD COLUMN session_token TEXT;
ALTER TABLE sync_config ADD COLUMN account_email TEXT;
CREATE TABLE account_signup(server_url TEXT NOT NULL,email TEXT NOT NULL,root_key TEXT NOT NULL,recovery_code TEXT NOT NULL,PRIMARY KEY(server_url,email));
