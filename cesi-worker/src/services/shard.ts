import type { Redis } from '@upstash/redis/cloudflare';
import type { MixedData, DbConfig, SelectOptions } from '../types/models';

const USED_BYTES_PREFIX = 'used_bytes:';
const DB_TIMEOUT_MS = 8000; // 8 second timeout per DB operation

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  // 修复：竞态结束后清理定时器（此前每次操作都悬挂一个 8s 定时器）
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface WriteOptions {
  /**
   * Cloudflare Workers 在响应返回后会终止未注册的后台任务。
   * 传入 executionCtx.waitUntil，确保副本补写、计数更新等后台任务真正执行完毕。
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export class ShardService {
  constructor(
    private redis: Redis,
    private dbs: DbConfig[]
  ) {}

  getDbs(): readonly DbConfig[] {
    return this.dbs;
  }

  /** 后台任务调度：优先经 waitUntil 注册（Workers 环境），否则尽力执行 */
  private defer(task: Promise<unknown>, waitUntil?: (p: Promise<unknown>) => void): void {
    const guarded = task.catch((err) => console.error('Background task failed:', err));
    if (waitUntil) {
      try {
        waitUntil(guarded as Promise<unknown>);
        return;
      } catch {
        /* waitUntil 不可用时回退到尽力执行 */
      }
    }
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

  /**
   * 写入数据（低延迟优先策略）：
   *  - 按 DB 列表顺序逐个尝试写，第一个成功立刻返回——避免 Promise.all 等所有慢库
   *  - 成功返回后通过 waitUntil 后台补写剩余副本，保证最终一致性
   *  - 任何单个 DB 失败都不会让 write 整体崩
   */
  async write(data: MixedData, options?: WriteOptions): Promise<{ ok: true; db: string } | { ok: false; error: string }> {
    const estimatedSize = this.estimateSize(data);
    const waitUntil = options?.waitUntil;

    const writeOne = async (db: DbConfig): Promise<string> => {
      await withTimeout(db.insert(data), DB_TIMEOUT_MS, `insert(${db.name})`);

      // 写入成功后更新 Redis 与 meta 计数（后台任务，失败不影响写入结果）
      const counters = (async () => {
        try {
          await this.redis.incrby(`${USED_BYTES_PREFIX}${db.name}`, estimatedSize);
        } catch (err) {
          console.error(`Redis INCRBY ${USED_BYTES_PREFIX}${db.name} failed`, err);
        }
        // 修复容量计数双倍膨胀：incrby 之后的 getUsedBytes 已包含本次增量，
        // meta 直接写入该值即可（此前再 +estimatedSize 导致每次写入容量翻倍虚增）
        let used = 0;
        try {
          used = await this.getUsedBytes(db.name);
        } catch {
          used = 0;
        }
        try {
          await this.updateMeta(db, used);
        } catch (err) {
          console.error(`Async meta update for ${db.name} failed`, err);
        }
      })();
      this.defer(counters, waitUntil);

      return db.name;
    };

    // 步骤1：按顺序逐个尝试写，第一个成功立刻返回
    const errors: string[] = [];
    let successDb: string | null = null;
    let successIdx = -1;
    for (let i = 0; i < this.dbs.length; i++) {
      const db = this.dbs[i];
      try {
        const name = await writeOne(db);
        successDb = name;
        successIdx = i;
        break;
      } catch (err) {
        errors.push(`${db.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (successDb == null) {
      return { ok: false, error: `All databases failed: ${errors.join('; ')}` };
    }

    // 步骤2：后台补写剩余副本。
    // 修复：此前用 queueMicrotask/setTimeout 调度，Workers 在响应返回后会直接取消这些任务，
    // 副本长期缺失；现在必须经 waitUntil 注册才能保证执行。
    const remainingDBs = this.dbs.filter((_, idx) => idx !== successIdx);
    if (remainingDBs.length > 0) {
      const replicas = Promise.allSettled(remainingDBs.map((db) => writeOne(db)));
      this.defer(replicas, waitUntil);
    }

    return { ok: true, db: successDb };
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
      .flatMap((r) => r.value);

    // 去重：3 个数据库都写入了相同数据，按 id 去重避免重复记录
    const seen = new Set<string>();
    const deduped = merged.filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });

    // 默认按创建时间倒序
    deduped.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (options.orderByScore === 'asc') {
      deduped.sort((a, b) => (a.score_value ?? Infinity) - (b.score_value ?? Infinity));
    } else if (options.orderByScore === 'desc') {
      deduped.sort((a, b) => (b.score_value ?? -Infinity) - (a.score_value ?? -Infinity));
    }

    // 修复 NaN limit：?limit=abc 会让 Number() 产生 NaN，此前 NaN>0 为 false 直接返回全部数据（全表扫描）
    const limit = options.limit;
    return Number.isFinite(limit) && limit && limit > 0 ? deduped.slice(0, limit) : deduped;
  }

  async readByUserAndType(userId: string, type: string, limit = 100): Promise<MixedData[]> {
    return this.readByType(type, { userId, limit });
  }

  /**
   * 数据库端排行榜聚合（每用户最佳成绩）。任一 DB 支持即启用；
   * 返回 null 表示所有 DB 都不支持，调用方回退到 readByType 旧路径。
   */
  async readLeaderboard(subtype: string, order: 'asc' | 'desc', limit: number): Promise<MixedData[] | null> {
    if (!this.dbs.some((db) => typeof db.selectLeaderboard === 'function')) {
      return null;
    }

    const queries = this.dbs.map(async (db) => {
      if (!db.selectLeaderboard) return [] as MixedData[];
      try {
        return await withTimeout(db.selectLeaderboard(subtype, order, limit), DB_TIMEOUT_MS, `readLeaderboard(${db.name})`);
      } catch (err) {
        console.error(`readLeaderboard failed for ${db.name}`, err);
        return [] as MixedData[];
      }
    });

    const results = await Promise.allSettled(queries);
    const merged = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    // 跨库去重（同一条记录的副本 id 相同）；不同库数据不一致时按用户取最优
    const seen = new Set<string>();
    const bestByUser = new Map<string, MixedData>();
    for (const row of merged) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const existing = bestByUser.get(row.user_id);
      if (!existing) {
        bestByUser.set(row.user_id, row);
        continue;
      }
      const isBetter = order === 'asc'
        ? (row.score_value ?? Infinity) < (existing.score_value ?? Infinity)
        : (row.score_value ?? -Infinity) > (existing.score_value ?? -Infinity);
      if (isBetter) bestByUser.set(row.user_id, row);
    }

    const rows = Array.from(bestByUser.values());
    rows.sort((a, b) => order === 'asc'
      ? (a.score_value ?? Infinity) - (b.score_value ?? Infinity)
      : (b.score_value ?? -Infinity) - (a.score_value ?? -Infinity));

    return rows.slice(0, limit);
  }

  async readById(id: string): Promise<MixedData | undefined> {
    // 修复：并行查询所有库（此前串行循环，单库故障时最坏 3×8s=24s）
    const results = await Promise.allSettled(
      this.dbs.map((db) => withTimeout(db.selectById(id), DB_TIMEOUT_MS, `readById(${db.name})`))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) return r.value;
    }
    return undefined;
  }

  async deleteById(id: string): Promise<boolean> {
    // 修复：并行删除所有副本（此前串行循环最坏 24s；任何一库删成功即视为成功）
    const results = await Promise.allSettled(
      this.dbs.map((db) => withTimeout(db.deleteById(id), DB_TIMEOUT_MS, `deleteById(${db.name})`))
    );
    return results.some((r) => r.status === 'fulfilled');
  }

  /** 删除某类型中早于指定时间的记录（清理 online 心跳等易膨胀数据），返回删除总数 */
  async deleteOldByType(type: string, beforeIso: string): Promise<number> {
    const queries = this.dbs.map(async (db) => {
      if (!db.deleteOldByType) return 0;
      try {
        return await withTimeout(db.deleteOldByType(type, beforeIso), DB_TIMEOUT_MS, `deleteOldByType(${db.name})`);
      } catch (err) {
        console.error(`deleteOldByType failed for ${db.name}`, err);
        return 0;
      }
    });
    const results = await Promise.allSettled(queries);
    return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
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
    // 3 个数据库数据相同，取最大值（而非求和），避免 3 倍计数
    return results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
      .reduce((max, r) => Math.max(max, r.value), 0);
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
    // 3 个数据库数据相同，取最大值（而非求和），避免 3 倍计数
    return results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
      .reduce((max, r) => Math.max(max, r.value), 0);
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
