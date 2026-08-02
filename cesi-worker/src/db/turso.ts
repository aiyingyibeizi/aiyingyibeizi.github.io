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
}

export async function tursoInsert(client: Client, data: MixedData): Promise<void> {
  await client.execute({
    sql: `INSERT INTO mixed_data (id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  if (options.subtype) {
    conditions.push('subtype = ?');
    args.push(options.subtype);
  }

  const orderBy =
    options.orderByScore === 'asc'
      ? 'score_value ASC, created_at DESC'
      : options.orderByScore === 'desc'
      ? 'score_value DESC, created_at DESC'
      : 'created_at DESC';

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);

  const result = await client.execute({
    sql: `SELECT id, user_id, type, subtype, score_value, payload, file_url, created_at, updated_at
          FROM mixed_data
          WHERE ${conditions.join(' AND ')}
          ORDER BY ${orderBy}
          LIMIT ?`,
    args: [...args, limit],
  });
  return result.rows as unknown as MixedData[];
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
            updated_at = excluded.updated_at`,
    args: [dbName, usedBytes, maxBytes],
  });
}
