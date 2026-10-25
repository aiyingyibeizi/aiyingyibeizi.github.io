import type { Redis } from '@upstash/redis/cloudflare';
import type { ShardService } from './shard';

/**
 * 访客 IP 台账。
 *
 * 目的：把「进过站就留下痕迹」变成可查数据——哪怕对方从没注册账号。
 * 存储：Upstash Redis
 *   - `vis:ip:<ip>`  HASH：ip / first / last / hits / path / ua / country / city
 *   - `vis:index`    ZSET：score = 最后活跃毫秒，member = IP（按时间倒序取）
 *
 * 设计取舍：
 *   - 30 秒进程内节流，避免爬虫/高频轮询把 Redis 写爆；同一 IP 的访问次数仍然累计。
 *   - 索引只保留最近 MAX_IPS 个 IP，超出按时间淘汰，防止免费额度被无限撑大。
 *   - 全程 fail-safe：任何 Redis 异常都静默吞掉，绝不影响正常请求。
 */

const IDX = 'vis:index';
const keyOf = (ip: string) => `vis:ip:${ip}`;
const TTL_SEC = 90 * 86400;
const MAX_IPS = 5000;
const THROTTLE_MS = 30_000;

/** isolate 内节流表：ip → 上次写入毫秒 */
const lastWrite = new Map<string, number>();

export type VisitInput = {
  ip: string;
  path: string;
  ua: string;
  country: string;
  city: string;
};

export type VisitorRow = {
  ip: string;
  first_seen: string;
  last_seen: string;
  hits: number;
  country: string;
  city: string;
  ua: string;
  last_path: string;
};

function iso(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 记录一次访问（fire-and-forget，调用方用 waitUntil 挂起） */
export async function recordVisit(redis: Redis, v: VisitInput): Promise<void> {
  const ip = (v.ip || '').trim();
  if (!ip || ip === 'unknown') return;

  const now = Date.now();
  const prev = lastWrite.get(ip) || 0;
  if (now - prev < THROTTLE_MS) return;
  lastWrite.set(ip, now);

  // 容量保护：isolate 长期存活时清掉一轮过期条目
  if (lastWrite.size > 20000) {
    for (const [k, t] of lastWrite) if (now - t > THROTTLE_MS * 4) lastWrite.delete(k);
  }

  const key = keyOf(ip);
  try {
    const first = await redis.hget(key, 'first');
    const fields: Record<string, string> = {
      ip,
      last: String(now),
      path: (v.path || '').slice(0, 160),
      ua: (v.ua || '').slice(0, 200),
      country: v.country || '',
      city: v.city || '',
    };
    if (first === null || first === undefined || first === '') {
      fields.first = String(now);
      fields.hits = '1';
    }
    await redis.hset(key, fields);
    if (first !== null && first !== undefined && first !== '') {
      await redis.hincrby(key, 'hits', 1);
    }
    await redis.expire(key, TTL_SEC);

    await redis.zadd(IDX, { score: now, member: ip });
    // 保留最近 MAX_IPS 个，rank 从旧到新，删掉多余的头部
    await redis.zremrangebyrank(IDX, 0, -(MAX_IPS + 1));
    await redis.expire(IDX, TTL_SEC);
  } catch {
    // 台账不可用不影响业务
  }
}

/** 按最后活跃时间倒序取访客，附带每行全部 IP 明细 */
export async function listVisitors(redis: Redis, limit = 500): Promise<VisitorRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 500, 1), MAX_IPS);
  try {
    // 正序取回再反转：不同版本的 Upstash 客户端对 zrange 的 rev 参数支持不一致，
    // 这里用最基础的签名，避免整个台账因一个可选参数静默变成空数组。
    const raw = await redis.zrange(IDX, 0, n - 1);
    const ips = (raw || []).map((x: unknown) => String(x)).filter(Boolean).reverse();
    if (!ips.length) return [];

    const hs = await Promise.all(
      ips.map((ip) => redis.hgetall(keyOf(ip)).catch(() => null as Record<string, unknown> | null))
    );

    const rows: VisitorRow[] = [];
    for (let i = 0; i < ips.length; i++) {
      const h = (hs[i] || {}) as Record<string, unknown>;
      if (!h || typeof h !== 'object') continue;
      rows.push({
        ip: str(h.ip) || ips[i],
        first_seen: iso(num(h.first)),
        last_seen: iso(num(h.last)),
        hits: num(h.hits) || 1,
        country: str(h.country),
        city: str(h.city),
        ua: str(h.ua),
        last_path: str(h.path),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/** 取访客 IP 集合（用于把「账号登录 IP」和「匿名访问 IP」对齐） */
export async function visitorIpSet(redis: Redis, limit = MAX_IPS): Promise<Set<string>> {
  const rows = await listVisitors(redis, limit);
  return new Set(rows.map((r) => r.ip));
}

/**
 * 访客落库（Turso，type=visit）。
 *
 * 为什么还要写库：Redis 台账依赖 Upstash 绑定，一旦该绑定异常，
 * 后台就只剩注册账号的 IP，匿名路人会整片消失。落库后两者互为兜底。
 * 写入放在 waitUntil 里，不占响应时间；同一 IP 的重复写入由上游 30 秒节流拦住。
 */
export async function recordVisitDb(
  shard: ShardService,
  v: VisitInput,
  waitUntil?: (p: Promise<unknown>) => void
): Promise<void> {
  const ip = (v.ip || '').trim();
  if (!ip || ip === 'unknown') return;
  const now = new Date().toISOString();
  const r = await shard.write(
    {
      id: crypto.randomUUID(),
      user_id: `ip#${ip}`,
      type: 'visit',
      subtype: ip,
      score_value: null,
      payload: JSON.stringify({
        ip,
        path: (v.path || '').slice(0, 160),
        ua: (v.ua || '').slice(0, 200),
        country: v.country || '',
        city: v.city || '',
        at: now,
      }),
      file_url: null,
      created_at: now,
      updated_at: now,
    },
    waitUntil ? { waitUntil } : undefined
  );
  if (!r.ok) throw new Error(r.error);
}

/** 从 Turso 的 visit 记录按 IP 聚合出访客台账（每个 IP 一行） */
export async function listVisitsFromDb(shard: ShardService, limit = 1000): Promise<VisitorRow[]> {
  const rows = await shard.readByType('visit', { limit });
  const map = new Map<string, { row: VisitorRow; lastMs: number; firstMs: number }>();

  for (const r of rows) {
    let p: any = {};
    try {
      p = JSON.parse(r.payload);
    } catch {
      p = {};
    }
    const ip = String(p.ip || r.subtype || '').trim();
    if (!ip) continue;
    const at = Date.parse(String(p.at || '')) || Date.parse(r.created_at) || 0;
    const prev = map.get(ip);
    if (!prev) {
      map.set(ip, {
        row: {
          ip,
          first_seen: iso(at),
          last_seen: iso(at),
          hits: 1,
          country: str(p.country),
          city: str(p.city),
          ua: str(p.ua),
          last_path: str(p.path),
        },
        lastMs: at,
        firstMs: at,
      });
      continue;
    }
    prev.row.hits += 1;
    if (at > prev.lastMs) {
      prev.lastMs = at;
      prev.row.last_seen = iso(at);
      prev.row.last_path = str(p.path);
      prev.row.ua = str(p.ua);
      prev.row.country = str(p.country);
      prev.row.city = str(p.city);
    }
    if (at && at < prev.firstMs) {
      prev.firstMs = at;
      prev.row.first_seen = iso(at);
    }
  }

  return [...map.values()]
    .sort((a, b) => b.lastMs - a.lastMs)
    .map((x) => x.row);
}
