import pg from 'pg';
import type { MixedData, Meta, SelectOptions } from '../types/models';

const { Pool } = pg;

export function createSupabasePgPool(dsn: string): pg.Pool {
  return new Pool({
    connectionString: dsn,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function supabasePgInsert(pool: pg.Pool, data: MixedData): Promise<void> {
  await pool.query(
    `INSERT INTO mixed_data (id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      data.id,
      data.user_id,
      data.type,
      data.subtype,
      data.score_value,
      data.payload,
      data.file_url,
      data.created_at,
      data.updated_at,
    ]
  );
}

export async function supabasePgSelectByUser(
  pool: pg.Pool,
  userId: string,
  limit: number
): Promise<MixedData[]> {
  const result = await pool.query<MixedData>(
    `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
     FROM mixed_data
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

export async function supabasePgSelectByType(
  pool: pg.Pool,
  type: string,
  options: SelectOptions
): Promise<MixedData[]> {
  const conditions: string[] = ['type = $1'];
  const args: (string | number)[] = [type];
  let idx = 2;

  if (options.userId) {
    conditions.push(`user_id = $${idx++}`);
    args.push(options.userId);
  }
  if (options.subtype) {
    conditions.push(`subtype = $${idx++}`);
    args.push(options.subtype);
  }

  const orderBy =
    options.orderByScore === 'asc'
      ? 'score_value ASC, created_at DESC'
      : options.orderByScore === 'desc'
      ? 'score_value DESC, created_at DESC'
      : 'created_at DESC';

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);

  const result = await pool.query<MixedData>(
    `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
     FROM mixed_data
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${idx++}`,
    [...args, limit]
  );
  return result.rows;
}

export async function supabasePgSelectById(pool: pg.Pool, id: string): Promise<MixedData | undefined> {
  const result = await pool.query<MixedData>(
    `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
     FROM mixed_data
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0];
}

export async function supabasePgDeleteById(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM mixed_data WHERE id = $1`, [id]);
}

export async function supabasePgCountByType(pool: pg.Pool, type: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM mixed_data WHERE type = $1`,
    [type]
  );
  return result.rows[0] ? Number(result.rows[0].count) : 0;
}

export async function supabasePgGetMetaUsedBytes(pool: pg.Pool, dbName: string): Promise<number> {
  const result = await pool.query<Pick<Meta, 'used_bytes'>>(
    `SELECT used_bytes FROM meta WHERE db_name = $1`,
    [dbName]
  );
  return result.rows[0]?.used_bytes ?? 0;
}

export async function supabasePgUpdateMetaUsedBytes(
  pool: pg.Pool,
  dbName: string,
  maxBytes: number,
  usedBytes: number
): Promise<void> {
  await pool.query(
    `INSERT INTO meta (db_name, used_bytes, max_bytes, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (db_name) DO UPDATE SET
       used_bytes = EXCLUDED.used_bytes,
       updated_at = EXCLUDED.updated_at`,
    [dbName, usedBytes, maxBytes]
  );
}
