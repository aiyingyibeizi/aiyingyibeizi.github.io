-- Run this against both Neon and Supabase SQL (PostgreSQL) databases.

CREATE TABLE IF NOT EXISTS mixed_data (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  file_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mixed_data_user_id_created_at
  ON mixed_data (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  db_name TEXT PRIMARY KEY,
  used_bytes BIGINT DEFAULT 0,
  max_bytes BIGINT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert/upsert meta rows for the two Postgres backends.
INSERT INTO meta (db_name, used_bytes, max_bytes, updated_at)
VALUES
  ('neon', 0, 536870912, NOW()),          -- 0.5 GB
  ('supabase_pg', 0, 524288000, NOW())    -- 500 MB
ON CONFLICT (db_name) DO UPDATE SET
  max_bytes = EXCLUDED.max_bytes,
  updated_at = EXCLUDED.updated_at;
