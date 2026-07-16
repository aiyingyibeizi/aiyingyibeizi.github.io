-- Run this against each Turso database (APEXON, APEXON_1, APEXON_2).

CREATE TABLE IF NOT EXISTS mixed_data (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  file_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meta (
  db_name TEXT PRIMARY KEY,
  used_bytes INTEGER DEFAULT 0,
  max_bytes INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO meta (db_name, max_bytes) VALUES
  ('turso_apexon', 8589934592),
  ('turso_apexon_1', 8589934592),
  ('turso_apexon_2', 8589934592);
