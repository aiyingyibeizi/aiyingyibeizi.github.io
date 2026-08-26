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
  // 可选：数据库端排行榜聚合（每个用户只取最佳成绩再排序）；不支持时回退到通用 readByType 路径
  selectLeaderboard?: (subtype: string, order: 'asc' | 'desc', limit: number) => Promise<MixedData[]>;
  // 可选：删除某类型中早于指定时间的记录（用于 online 心跳等易膨胀数据的清理）
  deleteOldByType?: (type: string, beforeIso: string) => Promise<number>;
}

export interface SelectOptions {
  userId?: string;
  userIds?: string[];
  subtype?: string;
  limit?: number;
  orderByScore?: 'asc' | 'desc';
}
