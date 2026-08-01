CREATE TABLE IF NOT EXISTS mixed_data (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  score_value REAL,
  payload TEXT NOT NULL,
  file_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meta (
  db_name TEXT PRIMARY KEY,
  used_bytes BIGINT DEFAULT 0,
  max_bytes BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mixed_data_type_created_at
  ON mixed_data (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mixed_data_type_subtype_created_at
  ON mixed_data (type, subtype, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mixed_data_user_id_type
  ON mixed_data (user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mixed_data_score_value
  ON mixed_data (type, subtype, score_value);
