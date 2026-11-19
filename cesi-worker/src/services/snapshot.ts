/**
 * 榜单快照与回放：把「某个时刻」的排行榜状态固化下来，供事后回放与追溯。
 *
 * 动机：在线排行榜是实时聚合结果，随新成绩不断变化。当出现排名争议时，
 * 可以通过快照查看「在 T 时刻谁是第几名」，为判定提供依据。
 *
 * 实现：一次扫描所有成绩，按题型分组、每用户取最佳、排序取前 N，固化为 type='lbsnapshot' 的行。
 * 快照体积受 SNAPSHOT_TOP_N（默认 20）约束，不影响在线榜单。
 */

import type { Redis } from '@upstash/redis/cloudflare';
import type { Env } from '../types/env';
import type { MixedData } from '../types/models';
import type { ShardService } from './shard';

const SNAPSHOT_TYPE = 'lbsnapshot';

const TEST_ACCOUNT_RE = /^(test|testuser|verify|stress|stresstest|perf|loadtest|e2e|diag|dummy|benchmark|failcase|placeholder)[_\-\w]*$|realtest/i;

function safeJsonParse(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

function isLowerBetter(testType: string): boolean {
  return ['reaction', 'type', 'aim'].includes(testType);
}

export interface SnapshotMeta {
  id: string;
  created_at: string;
  type_count: number;
  entry_count: number;
}

export interface SnapshotRow {
  rank: number;
  username: string;
  user_id: string;
  score_value: number | null;
}

export interface SnapshotDetail {
  id: string;
  created_at: string;
  summary: string;
  per_type: Record<string, SnapshotRow[]>;
}

/** 扫描全部成绩并生成快照（一次读库，内存聚合） */
export async function createSnapshot(
  shard: ShardService,
  redis: Redis,
  env: Env
): Promise<SnapshotMeta | null> {
  const topN = Math.min(Math.max(Number(env.SNAPSHOT_TOP_N) || 20, 3), 100);
  let rows: MixedData[];
  try {
    rows = await shard.readByType('score', { limit: 1000 });
  } catch (err) {
    console.error('snapshot read scores failed:', err);
    return null;
  }

  // 按题型聚合行
  const byType = new Map<string, MixedData[]>();
  for (const r of rows) {
    const key = r.subtype || '';
    if (!key) continue;
    const arr = byType.get(key);
    if (arr) arr.push(r);
    else byType.set(key, [r]);
  }

  const perType: Record<string, SnapshotRow[]> = {};
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let entries = 0;

  for (const [type, ts] of byType) {
    const lower = isLowerBetter(type);
    // 过滤不可上榜成绩 + 压测账号
    const eligible = ts.filter((r) => {
      const p: any = safeJsonParse(r.payload || '{}');
      if (p.leaderboard_eligible === false || p.validity === 'invalid') return false;
      if (p.flagged || p.validity === 'suspicious') return false;
      const name = typeof p.username === 'string' ? p.username.trim() : '';
      return !name || !TEST_ACCOUNT_RE.test(name);
    });
    const bestByUser = new Map<string, MixedData>();
    for (const r of eligible) {
      const cur = bestByUser.get(r.user_id);
      if (!cur) { bestByUser.set(r.user_id, r); continue; }
      const better = lower
        ? (r.score_value ?? Infinity) < (cur.score_value ?? Infinity)
        : (r.score_value ?? -Infinity) > (cur.score_value ?? -Infinity);
      if (better) bestByUser.set(r.user_id, r);
    }
    const list = Array.from(bestByUser.values()).sort((a, b) =>
      lower
        ? (a.score_value ?? Infinity) - (b.score_value ?? Infinity)
        : (b.score_value ?? -Infinity) - (a.score_value ?? -Infinity)
    ).slice(0, topN);

    perType[type] = list.map((r, i) => {
      const p: any = safeJsonParse(r.payload || '{}');
      return { rank: i + 1, username: p.username || r.user_id, user_id: r.user_id, score_value: r.score_value };
    });
    entries += perType[type].length;
  }

  const meta: SnapshotMeta = { id, created_at: now, type_count: byType.size, entry_count: entries };

  const writeResult = await shard.write(
    {
      id,
      user_id: 'system',
      type: SNAPSHOT_TYPE,
      subtype: 'snapshot',
      score_value: byType.size,
      payload: JSON.stringify({ id, created_at: now, per_type: perType }),
      file_url: null,
      created_at: now,
      updated_at: now,
    },
    {}
  );
  if (!writeResult.ok) {
    console.error('snapshot persist failed:', writeResult.error);
    return null;
  }

  await recordSnapshotRedis(redis, meta, now);
  return meta;
}

/** 在 Redis 里额外维护一份「最近快照 id 索引」，方便列表快速返回而不依赖全库扫描 */
async function recordSnapshotRedis(redis: Redis, meta: SnapshotMeta, now: string): Promise<void> {
  try {
    await redis.lpush('snap:index', JSON.stringify(meta));
    await redis.expire('snap:index', 30 * 86400);
    const len = await redis.llen('snap:index');
    if (len > 200) {
      for (let i = 0; i < len - 200; i++) await redis.rpop('snap:index');
    }
  } catch (err) {
    console.error('snapshot redis index failed:', err);
  }
}

/** 列出快照元信息（优先走 Redis 索引；缺失时回退扫描库） */
export async function listSnapshots(shard: ShardService, redis: Redis): Promise<SnapshotMeta[]> {
  try {
    const cached = await redis.lrange('snap:index', 0, 199);
    if (Array.isArray(cached) && cached.length) {
      return (cached as string[])
        .map((s) => { try { return JSON.parse(s) as SnapshotMeta; } catch { return null; } })
        .filter((x): x is SnapshotMeta => !!x)
        .slice(0, 200);
    }
  } catch (err) {
    console.warn('snapshot redis index read failed:', err);
  }
  // 回退：扫描库
  try {
    const rows = await shard.readByType(SNAPSHOT_TYPE, { limit: 200 });
    return rows
      .map((r) => {
        const p: any = safeJsonParse(r.payload || '{}');
        return { id: r.id, created_at: r.created_at, type_count: r.score_value ?? 0, entry_count: p.entry_count ?? 0 };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 200);
  } catch (err) {
    console.error('snapshot list scan failed:', err);
    return [];
  }
}

/** 取一个快照详情（含各题型榜单） */
export async function getSnapshot(shard: ShardService, id: string): Promise<SnapshotDetail | null> {
  const row = await shard.readById(id);
  if (!row || row.type !== SNAPSHOT_TYPE) return null;
  const p: any = safeJsonParse(row.payload || '{}');
  const perType = p.per_type || {};
  const entries = Object.values(perType).reduce((sum: number, arr: any) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  return { id: row.id, created_at: row.created_at, summary: `类型 ${Object.keys(perType).length}，上榜 ${entries}`, per_type: perType };
}