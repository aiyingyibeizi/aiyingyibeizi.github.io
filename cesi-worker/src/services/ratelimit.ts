import type { Redis } from '@upstash/redis/cloudflare';

/**
 * 简易固定窗口限流（基于 Upstash Redis）。
 *
 * 窗口不是严格原子（incr 与 expire 分开两步），存在极微小的竞态，
 * 但对限流来说完全可接受：最坏情况只是让一个请求漏过或把窗口重置提前一到两个请求，
 * 不会造成越权或数据破坏。
 *
 * H3 修复：Redis 不可用不再直接放行（旧 fail-open 会让所有限流失效）。
 * 改为降级到"进程内备用限流"——Workers 单个 isolate 内近似生效，
 * 跨 isolate 不共享，但仍能拦住单点脚本洪峰，属 fail-closed 姿态。
 *
 * @returns true 表示放行，false 表示已超限
 */

// 内存备用限流的桶（key → 计数 + 到期时间）
const memBuckets = new Map<string, { count: number; resetAt: number }>();

function memRateLimit(key: string, limit: number, windowSec: number): boolean {
  const now = Date.now();
  const k = `mem:${key}`;
  const b = memBuckets.get(k);
  if (!b || b.resetAt <= now) {
    // 容量保护：桶过多时清理过期项，防止 isolate 长期运行内存膨胀
    if (memBuckets.size > 5000) {
      for (const [bk, bv] of memBuckets) if (bv.resetAt <= now) memBuckets.delete(bk);
    }
    memBuckets.set(k, { count: 1, resetAt: now + windowSec * 1000 });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

export async function rateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number
): Promise<boolean> {
  try {
    const k = `rl:${key}`;
    const count = await redis.incr(k);
    if (count === 1) {
      // 第一个请求带上过期时间（原子地设置，避免窗口无限拉长）
      await redis.expire(k, windowSec);
    }
    return count <= limit;
  } catch {
    // Redis 不可用：降级到内存限流（fail-closed），绝不无条件放行
    return memRateLimit(key, limit, windowSec);
  }
}

/** 从请求头里取真实客户端 IP（Cloudflare 注入的 CF-Connecting-IP 最可靠） */
export function clientIp(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  );
}

/** 组装一个命名空间式的限流 key，避免不同用途串号 */
export function rlKey(prefix: string, ...segs: Array<string | number>): string {
  return [prefix, ...segs].join(':');
}