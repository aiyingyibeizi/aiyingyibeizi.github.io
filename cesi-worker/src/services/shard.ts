import type { Redis } from '@upstash/redis/cloudflare';
import type { MixedData, DbConfig } from '../types/models';

const USED_BYTES_PREFIX = 'used_bytes:';

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
      const used = await db.getMetaUsedBytes();
      await this.redis.set(`${USED_BYTES_PREFIX}${dbName}`, used);
      return used;
    } catch (err) {
      console.error(`Meta lookup for ${dbName} failed`, err);
      return 0;
    }
  }

  async write(data: MixedData): Promise<{ ok: true; db: string } | { ok: false; error: string }> {
    const estimatedSize = this.estimateSize(data);

    for (const db of this.dbs) {
      try {
        const used = await this.getUsedBytes(db.name);
        if (used + estimatedSize > db.maxBytes) {
          console.log(`DB ${db.name} would exceed capacity: ${used} + ${estimatedSize} > ${db.maxBytes}`);
          continue;
        }

        await db.insert(data);

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
        console.error(`Write to ${db.name} failed`, err);
      }
    }

    return { ok: false, error: 'All databases are full or unavailable' };
  }

  private estimateSize(data: MixedData): number {
    // Rough byte estimate of the stored row, including some overhead.
    const payload = new TextEncoder().encode(data.payload).length;
    const type = new TextEncoder().encode(data.type).length;
    const id = new TextEncoder().encode(data.id).length;
    const userId = new TextEncoder().encode(data.user_id).length;
    const fileUrl = data.file_url ? new TextEncoder().encode(data.file_url).length : 0;
    return payload + type + id + userId + fileUrl + 256;
  }

  private async updateMeta(db: DbConfig, usedBytes: number): Promise<void> {
    await db.updateMetaUsedBytes(usedBytes);
  }
}
