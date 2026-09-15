import { createClient, type Client } from '@libsql/client/web';
import type { MixedData, Meta, SelectOptions } from '../types/models';

export function createTursoClient(url: string, authToken: string): Client {
  return createClient({ url, authToken });
}

export async function tursoMigrate(client: Client): Promise<void> {
  // Create mixed_data table if not exists
  await client.execute(`
    CREATE TABLE IF NOT EXISTS mixed_data (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      score_value REAL,
      payload TEXT NOT NULL,
      file_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 用 PRAGMA 检查所有必要的列是否存在，逐个补齐。
  // 之前只检查 subtype，导致 APEXON_1 缺 score_value 列时 insert 失败。
  const requiredColumns: Record<string, string> = {
    subtype: 'TEXT',
    score_value: 'REAL',
    file_url: 'TEXT',
  };
  const columns = await client.execute(`PRAGMA table_info(mixed_data)`);
  const existingCols = new Set(
    columns.rows.map((row: unknown) => (row as { name?: string }).name)
  );
  for (const [colName, colType] of Object.entries(requiredColumns)) {
    if (!existingCols.has(colName)) {
      await client.execute(`ALTER TABLE mixed_data ADD COLUMN ${colName} ${colType}`);
    }
  }

  // Create meta table if not exists
  await client.execute(`
    CREATE TABLE IF NOT EXISTS meta (
      db_name TEXT PRIMARY KEY,
      used_bytes INTEGER DEFAULT 0,
      max_bytes INTEGER DEFAULT 0,
      updated_at TEXT
    )
  `);

  // Create indexes for common query patterns (Bug4: SQL performance)
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_mixed_type_created ON mixed_data(type, created_at DESC)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_mixed_type_user ON mixed_data(type, user_id)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_mixed_user_id ON mixed_data(user_id)`);
  // 账号按用户名（subtype）精确查询 / 排行榜按 (subtype, score) 聚合的高频查询路径
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_mixed_type_subtype ON mixed_data(type, subtype)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_mixed_type_subtype_score ON mixed_data(type, subtype, score_value)`);
}

export async function tursoInsert(client: Client, data: MixedData): Promise<void> {
  await client.execute({
    // ON CONFLICT DO NOTHING：后台补写副本遇到同 id 已存在（如上次超时但实际写入成功）时幂等跳过，
    // 不再报错导致副本静默丢失
    sql: `INSERT INTO mixed_data (id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [
      data.id,
      data.user_id,
      data.type,
      data.subtype,
      data.score_value,
      data.payload,
      data.file_url,
      data.created_at,
      data.updated_at,
    ],
  });
}

export async function tursoSelectByUser(
  client: Client,
  userId: string,
  limit: number
): Promise<MixedData[]> {
  const result = await client.execute({
    sql: `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
          FROM mixed_data
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [userId, limit],
  });
  return result.rows as unknown as MixedData[];
}

export async function tursoSelectByType(
  client: Client,
  type: string,
  options: SelectOptions
): Promise<MixedData[]> {
  const conditions = ['type = ?'];
  const args: (string | number)[] = [type];

  if (options.userId) {
    conditions.push('user_id = ?');
    args.push(options.userId);
  }
  if (options.userIds && options.userIds.length) {
    // 批量按用户查询（如 profiles?user_ids=a,b,c）：一次 IN 查询替代"读最新1000条再内存过滤"
    conditions.push(`user_id IN (${options.userIds.map(() => '?').join(', ')})`);
    args.push(...options.userIds);
  }
  if (options.subtype) {
    conditions.push('subtype = ?');
    args.push(options.subtype);
  }
  if (options.orderByScore) {
    // 按分数排序时排除 NULL 行：SQLite 中 NULL 在 ASC 排最前，会占掉 LIMIT 名额把真实成绩挤掉
    conditions.push('score_value IS NOT NULL');
  }

  const orderBy =
    options.orderByScore === 'asc'
      ? 'score_value ASC, created_at DESC'
      : options.orderByScore === 'desc'
      ? 'score_value DESC, created_at DESC'
      : 'created_at DESC';

  const rawLimit = Number(options.limit);
  const safeLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 100;

  const result = await client.execute({
    sql: `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
          FROM mixed_data
          WHERE ${conditions.join(' AND ')}
          ORDER BY ${orderBy}
          LIMIT ?`,
    args: [...args, safeLimit],
  });
  return result.rows as unknown as MixedData[];
}

/**
 * 数据库端排行榜聚合：每个用户只取最佳成绩后再排序。
 * 修复"先取全局 top-1000 再按用户去重"的缺陷——单个用户刷分可占满全部名额，把其他用户挤出榜单。
 * 同时在 SQL 层过滤 leaderboardEligible=false 的记录（reaction 3+ 犯规不参与排名）。
 */
export async function tursoSelectLeaderboard(
  client: Client,
  subtype: string,
  order: 'asc' | 'desc',
  limit: number
): Promise<MixedData[]> {
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  const rawLimit = Number(limit);
  const safeLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 100;

  const result = await client.execute({
    sql: `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
          FROM (
            SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at,
                   ROW_NUMBER() OVER (
                     PARTITION BY user_id
                     ORDER BY score_value ${dir}, created_at DESC
                   ) AS rn
            FROM mixed_data
            WHERE type = 'score' AND subtype = ? AND score_value IS NOT NULL
              AND CASE
                    WHEN json_valid(payload) = 1
                      THEN COALESCE(json_extract(payload, '$.leaderboardEligible'), 1) != 0
                    ELSE 1
                  END
          )
          WHERE rn = 1
          ORDER BY score_value ${dir}, created_at DESC
          LIMIT ?`,
    args: [subtype, safeLimit],
  });
  return result.rows as unknown as MixedData[];
}

/**
 * 删除某类型中早于指定时间的记录（用于 online 心跳等易膨胀数据的清理）。
 */
export async function tursoDeleteOldByType(
  client: Client,
  type: string,
  beforeIso: string
): Promise<number> {
  const result = await client.execute({
    sql: `DELETE FROM mixed_data WHERE type = ? AND created_at < ?`,
    args: [type, beforeIso],
  });
  return Number((result as unknown as { rowsAffected?: number }).rowsAffected) || 0;
}

export async function tursoSelectById(client: Client, id: string): Promise<MixedData | undefined> {
  const result = await client.execute({
    sql: `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
          FROM mixed_data
          WHERE id = ?
          LIMIT 1`,
    args: [id],
  });
  return (result.rows[0] as unknown as MixedData) ?? undefined;
}

export async function tursoDeleteById(client: Client, id: string): Promise<void> {
  await client.execute({
    sql: `DELETE FROM mixed_data WHERE id = ?`,
    args: [id],
  });
}

export async function tursoCountByType(client: Client, type: string): Promise<number> {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS count FROM mixed_data WHERE type = ?`,
    args: [type],
  });
  const row = result.rows[0] as unknown as { count: number } | undefined;
  return row ? Number(row.count) : 0;
}

export async function tursoGetMetaUsedBytes(client: Client, dbName: string): Promise<number> {
  const result = await client.execute({
    sql: `SELECT used_bytes FROM meta WHERE db_name = ?`,
    args: [dbName],
  });
  const row = result.rows[0] as unknown as Pick<Meta, 'used_bytes'> | undefined;
  return row?.used_bytes ?? 0;
}

export async function tursoUpdateMetaUsedBytes(
  client: Client,
  dbName: string,
  maxBytes: number,
  usedBytes: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO meta (db_name, used_bytes, max_bytes, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(db_name) DO UPDATE SET
            used_bytes = excluded.used_bytes,
            max_bytes = excluded.max_bytes,
            updated_at = excluded.updated_at`,
    args: [dbName, usedBytes, maxBytes],
  });
}
