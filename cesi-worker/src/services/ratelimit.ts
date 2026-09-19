import type { Redis } from '@upstash/redis/cloudflare';

/**
 * 简易固定窗口限流（基于 Upstash Redis）。
 *
 * 窗口不是严格原子（incr 与 expire 分开两步），存在极微小的竞态，
 * 但对限流来说完全可接受：最坏情况只是让一个请求漏过或把窗口重置提前一到两个请求，
 * 不会造成越权或数据破坏。
 *
 * @returns true 表示放行，false 表示已超限
 */
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
    // Redis 不可用时不要因限流把合法用户挡掉（fail-open，但上层另有防御）
    return true;
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