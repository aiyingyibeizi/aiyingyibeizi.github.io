export interface MixedData {
  id: string;
  user_id: string;
  type: string;
  subtype: string | null;
  score_value: number | null;
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
  selectByType: (type: string, options: SelectOptions) => Promise<MixedData[]>;
  selectById: (id: string) => Promise<MixedData | undefined>;
  deleteById: (id: string) => Promise<void>;
  countByType: (type: string) => Promise<number>;
  getMetaUsedBytes: () => Promise<number>;
  updateMetaUsedBytes: (usedBytes: number) => Promise<void>;
}

export interface SelectOptions {
  userId?: string;
  subtype?: string;
  limit?: number;
  orderByScore?: 'asc' | 'desc';
}
