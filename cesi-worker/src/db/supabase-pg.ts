import pg from 'pg';
import type { MixedData, Meta } from '../types/models';

const { Pool } = pg;

export function createSupabasePgPool(dsn: string): pg.Pool {
  return new Pool({ connectionString: dsn });
}

export async function supabasePgInsert(pool: pg.Pool, data: MixedData): Promise<void> {
  await pool.query(
    `INSERT INTO mixed_data (id, user_id, type, payload, file_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [data.id, data.user_id, data.type, data.payload, data.file_url, data.created_at, data.updated_at]
  );
}

export async function supabasePgSelectByUser(
  pool: pg.Pool,
  userId: string,
  limit: number
): Promise<MixedData[]> {
  const result = await pool.query<MixedData>(
    `SELECT id, user_id, type, payload, file_url, created_at, updated_at
     FROM mixed_data
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
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
