export interface MixedData {
  id: string;
  user_id: string;
  type: string;
  payload: string;
  file_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Meta {
  db_name: string;
  used_bytes: number;
  max_bytes: number;
  updated_at: string;
}

export interface DbConfig {
  name: string;
  maxBytes: number;
  type: 'turso' | 'postgres';
  insert: (data: MixedData) => Promise<void>;
  selectByUser: (userId: string, limit: number) => Promise<MixedData[]>;
  getMetaUsedBytes: () => Promise<number>;
  updateMetaUsedBytes: (usedBytes: number) => Promise<void>;
}
