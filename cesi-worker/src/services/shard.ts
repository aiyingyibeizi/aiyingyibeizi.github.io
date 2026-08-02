import type { Redis } from '@upstash/redis/cloudflare';
import type { MixedData, DbConfig, SelectOptions } from '../types/models';

const USED_BYTES_PREFIX = 'used_bytes:';
const DB_TIMEOUT_MS = 8000; // 8 second timeout per DB operation

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

export class ShardService {
  constructor(
    private redis: Redis,
    private dbs: DbConfig[]
  ) {}

  getDbs(): readonly DbConfig[] {
    return this.dbs;
  }

  async getUsedBytes(dbName: string): Promise<number> {
    try {
      const cached = await this.redis.get<number>(`${USED_BYTES_PREFIX}${dbName}`);
      if (cached !== null && cached !== undefined) {
        return cached;
      }
    } catch (err) {
      console.error(`Redis GET ${USED_BYTES_PREFIX}${dbName} failed`, err);
    }

    const db = this.dbs.find((d) => d.name === dbName);
    if (!db) return 0;

    try {
      const used = await withTimeout(db.getMetaUsedBytes(), DB_TIMEOUT_MS, `getUsedBytes(${dbName})`);
      await this.redis.set(`${USED_BYTES_PREFIX}${dbName}`, used);
      return used;
    } catch (err) {
      console.error(`Meta lookup for ${dbName} failed`, err);
      return 0;
    }
  }

  async write(data: MixedData): Promise<{ ok: true; db: string } | { ok: false; error: string }> {
    const estimatedSize = this.estimateSize(data);
    const errors: string[] = [];

    for (const db of this.dbs) {
      try {
        const used = await this.getUsedBytes(db.name);
        if (used + estimatedSize > db.maxBytes) {
          console.log(`DB ${db.name} would exceed capacity: ${used} + ${estimatedSize} > ${db.maxBytes}`);
          errors.push(`${db.name}: full`);
          continue;
        }

        await withTimeout(db.insert(data), DB_TIMEOUT_MS, `insert(${db.name})`);

        try {
          await this.redis.incrby(`${USED_BYTES_PREFIX}${db.name}`, estimatedSize);
        } catch (err) {
          console.error(`Redis INCRBY ${USED_BYTES_PREFIX}${db.name} failed`, err);
        }

        // Update meta asynchronously; failures are logged but do not fail the request.
        this.updateMeta(db, used + estimatedSize).catch((err) => {
          console.error(`Async meta update for ${db.name} failed`, err);
        });

        return { ok: true, db: db.name };
      } catch (err) {
        const errMsg = `${db.name}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`Write to ${db.name} failed:`, errMsg);
        errors.push(errMsg);
      }
    }

    return { ok: false, error: `All databases failed: ${errors.join('; ')}` };
  }

  async readByType(type: string, options: SelectOptions = {}): Promise<MixedData[]> {
    const queries = this.dbs.map(async (db) => {
      try {
        return await withTimeout(db.selectByType(type, options), DB_TIMEOUT_MS, `readByType(${db.name})`);
      } catch (err) {
        console.error(`Fan-out readByType failed for ${db.name}`, err);
        return [] as MixedData[];
      }
    });

    const results = await Promise.allSettled(queries);
    const merged = results
      .filter((r): r is PromiseFulfilledResult<MixedData[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (options.orderByScore === 'asc') {
      merged.sort((a, b) => (a.score_value ?? Infinity) - (b.score_value ?? Infinity));
    } else if (options.orderByScore === 'desc') {
      merged.sort((a, b) => (b.score_value ?? -Infinity) - (a.score_value ?? -Infinity));
    }

    const limit = options.limit;
    return limit && limit > 0 ? merged.slice(0, limit) : merged;
  }

  async readByUserAndType(userId: string, type: string, limit = 100): Promise<MixedData[]> {
    return this.readByType(type, { userId, limit });
  }

  async readById(id: string): Promise<MixedData | undefined> {
    for (const db of this.dbs) {
      try {
        const row = await withTimeout(db.selectById(id), DB_TIMEOUT_MS, `readById(${db.name})`);
        if (row) return row;
      } catch (err) {
        console.error(`readById failed for ${db.name}`, err);
      }
    }
    return undefined;
  }

  async deleteById(id: string): Promise<boolean> {
    let deleted = false;
    for (const db of this.dbs) {
      try {
        await withTimeout(db.deleteById(id), DB_TIMEOUT_MS, `deleteById(${db.name})`);
        deleted = true;
      } catch (err) {
        console.error(`deleteById failed for ${db.name}`, err);
      }
    }
    return deleted;
  }

  async countByType(type: string): Promise<number> {
    const queries = this.dbs.map(async (db) => {
      try {
        return await withTimeout(db.countByType(type), DB_TIMEOUT_MS, `countByType(${db.name})`);
      } catch (err) {
        console.error(`countByType failed for ${db.name}`, err);
        return 0;
      }
    });
    const results = await Promise.allSettled(queries);
    return results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
      .reduce((sum, r) => sum + r.value, 0);
  }

  async countDistinctUsers(type: string): Promise<number> {
    const queries = this.dbs.map(async (db) => {
      try {
        const dbAny = db as any;
        if (typeof dbAny.countDistinctUsersByType === 'function') {
          return await dbAny.countDistinctUsersByType(type);
        }
        // Fallback: read a sample and count unique user_ids
        const rows = await withTimeout(db.selectByType(type, { limit: 2000 }), DB_TIMEOUT_MS, `countDistinctUsers(${db.name})`);
        const users = new Set(rows.map(r => r.user_id));
        return users.size;
      } catch (err) {
        console.error(`countDistinctUsers failed for ${db.name}`, err);
        return 0;
      }
    });
    const results = await Promise.allSettled(queries);
    return results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
      .reduce((sum, r) => sum + r.value, 0);
  }

  private estimateSize(data: MixedData): number {
    // Rough byte estimate of the stored row, including some overhead.
    const payload = new TextEncoder().encode(data.payload).length;
    const type = new TextEncoder().encode(data.type).length;
    const subtype = data.subtype ? new TextEncoder().encode(data.subtype).length : 0;
    const id = new TextEncoder().encode(data.id).length;
    const userId = new TextEncoder().encode(data.user_id).length;
    const fileUrl = data.file_url ? new TextEncoder().encode(data.file_url).length : 0;
    return payload + type + subtype + id + userId + fileUrl + 256;
  }

  private async updateMeta(db: DbConfig, usedBytes: number): Promise<void> {
    await db.updateMetaUsedBytes(usedBytes);
  }
}
