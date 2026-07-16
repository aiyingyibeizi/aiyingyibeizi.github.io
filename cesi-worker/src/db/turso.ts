import { createClient, type Client } from '@libsql/client/web';
import type { MixedData, Meta } from '../types/models';

export function createTursoClient(url: string, authToken: string): Client {
  return createClient({ url, authToken });
}

export async function tursoInsert(client: Client, data: MixedData): Promise<void> {
  await client.execute({
    sql: `INSERT INTO mixed_data (id, user_id, type, payload, file_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [data.id, data.user_id, data.type, data.payload, data.file_url, data.created_at, data.updated_at],
  });
}

export async function tursoSelectByUser(
  client: Client,
  userId: string,
  limit: number
): Promise<MixedData[]> {
  const result = await client.execute({
    sql: `SELECT id, user_id, type, payload, file_url, created_at, updated_at
          FROM mixed_data
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [userId, limit],
  });
  return result.rows as unknown as MixedData[];
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
            updated_at = excluded.updated_at`,
    args: [dbName, usedBytes, maxBytes],
  });
}
