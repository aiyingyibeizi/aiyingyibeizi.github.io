/**
 * 登录安全再加固：算数验证码 + 累积式 IP 黑名单。
 *
 * 目标：不破坏正常用户体验的前提下，显著提高"纯脚本撞口令 / 灌号"的落地成本。
 *
 * 一、算数验证码（CAPTCHA）
 *  - 由后端下发挑战：两个 1~9 的数做加法/减法，答案是一个整数。
 *  - Answer 短期存 Redis（TTL 5 分钟），一次性。不依赖任何第三方服务、无需图片。
 *  - 是否要求验证码由 login 路由决定：正常首次登录不打扰，仅在该来源已累积多次失败
 *    或 env 强制开启（CAPTCHA_ALWAYS=on）时才下发，做到"平时无感、可疑时上锁"。
 *
 * 二、IP 黑名单（累积式）
 *  - 与 security.ts 里"15 分钟窗口封锁"不同：这里是更长时间、可人工管理的黑名单。
 *  - 同一 IP 在窗口内（默认 1 小时）登录失败累计达到阈值（默认 20 次）→ 拉黑 24 小时。
 *  - 管理员可查询/手动解除（面板"登录加固"）。
 *  - 全程 fail-open：Redis 异常时放行，绝不影响登录主流程。
 */

import type { Redis } from '@upstash/redis/cloudflare';

// ---- CAPTCHA ----
const CAP_PREFIX = 'cap:';
const CAP_TTL_SEC = 5 * 60;

export interface CaptchaChallenge {
  id: string;
  question: string; // 形如 "8 + 5 = ?"
}

function safeKey(v: string): string {
  return v.replace(/[^\w.-]/g, '_').slice(0, 64) || 'anon';
}

/** 下发一道算数验证码挑战（answer 存 Redis，返回 id + 题目） */
export async function issueCaptcha(redis: Redis): Promise<CaptchaChallenge | null> {
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  // 减法保证结果 >= 0：被减数不小于减数
  const plus = Math.random() < 0.5;
  const answer = plus ? a + b : Math.max(a, b) - Math.min(a, b);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  try {
    await redis.set(`${CAP_PREFIX}${id}`, String(answer), { ex: CAP_TTL_SEC });
  } catch (err) {
    console.error('issueCaptcha set failed:', err);
    return null; // 无法存储则不下发（调用方按"不需验证码"处理）
  }
  const question = plus ? `${a} + ${b} = ?` : `${Math.max(a, b)} - ${Math.min(a, b)} = ?`;
  return { id, question };
}

/**
 * 校验验证码：命中即删除（一次性）。返回 true 表示通过。
 * 注意：Redis 异常时返回 false（fail-closed，见 H3 修复说明）。
 */
export async function verifyCaptcha(redis: Redis, id: string, answer: string): Promise<boolean> {
  if (!id || !answer) return false;
  const expect = answer.trim();
  if (!/^\d+$/.test(expect)) return false;
  try {
    const stored = await redis.get<string>(`${CAP_PREFIX}${safeKey(id)}`);
    if (!stored) return false;
    const ok = stored === expect;
    await redis.del(`${CAP_PREFIX}${safeKey(id)}`);
    return ok;
  } catch (err) {
    // H3 修复：验证码子系统故障时不再无条件放行（fail-closed）。
    // 说明：仅在"该来源已被判定需要验证码"时才会走到这里，因此不会影响正常用户。
    console.error('verifyCaptcha failed:', err);
    return false;
  }
}

// ---- IP 黑名单（累积式）----
// M7 修复：IP 不再做字符替换+截断当 key（IPv6 会碰撞），改用 SHA-256 哈希定长做 key。
// 同时拆分为「失败计数」与「黑名单标记」两个独立命名空间——
// 此前两者共用同一个 key，导致任何一次登录失败都会让 isIpBlacklisted 立即返回 true（误封）。
const IPFAIL_PREFIX = 'ipfail:';
const IPBLACK_PREFIX = 'ipblack:';
const IPBLACK_MAP_PREFIX = 'ipblackmap:';

/** SHA-256(ip) 取前 40 位十六进制（160-bit），彻底消除碰撞且不泄露原始 IP */
async function ipHash(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out.slice(0, 40);
}

/** 记录一次登录失败（按 IP 累积）；返回该 IP 在窗口内的累计失败次数 */
export async function countIpFailure(redis: Redis, ip: string, windowSec: number): Promise<number> {
  try {
    const k = `${IPFAIL_PREFIX}${await ipHash(ip)}`;
    const n = await redis.incr(k);
    if (n <= 1) await redis.expire(k, windowSec);
    return n;
  } catch (err) {
    console.error('countIpFailure failed:', err);
    return 0;
  }
}

/** 该 IP 是否已进入黑名单（仅黑名单标记 key 存活期间视为拉黑） */
export async function isIpBlacklisted(redis: Redis, ip: string): Promise<boolean> {
  try {
    const h = await ipHash(ip);
    return !!(await redis.get(`${IPBLACK_PREFIX}${h}`));
  } catch (err) {
    console.error('isIpBlacklisted failed:', err);
    return false;
  }
}

/** 把该 IP 拉黑 durationSec 秒；同时写入哈希→原始 IP 的映射供面板展示 */
export async function blacklistIp(redis: Redis, ip: string, durationSec: number): Promise<void> {
  try {
    const h = await ipHash(ip);
    await redis.set(`${IPBLACK_PREFIX}${h}`, '1', { ex: durationSec });
    await redis.set(`${IPBLACK_MAP_PREFIX}${h}`, ip, { ex: durationSec });
  } catch (err) {
    console.error('blacklistIp failed:', err);
  }
}

/** 取该 IP 在窗口内的失败计数（供面板展示/验证码阈值判断） */
export async function ipBlacklistCount(redis: Redis, ip: string): Promise<number> {
  try {
    return (await redis.get<number>(`${IPFAIL_PREFIX}${await ipHash(ip)}`)) || 0;
  } catch (err) {
    console.error('ipBlacklistCount failed:', err);
    return 0;
  }
}

/** 手动解除某个 IP 的黑名单（同时清理失败计数与映射） */
export async function clearIpBlacklist(redis: Redis, ip: string): Promise<void> {
  try {
    const h = await ipHash(ip);
    await redis.del(`${IPBLACK_PREFIX}${h}`);
    await redis.del(`${IPFAIL_PREFIX}${h}`);
    await redis.del(`${IPBLACK_MAP_PREFIX}${h}`);
  } catch (err) {
    console.error('clearIpBlacklist failed:', err);
  }
}

/**
 * 列出所有已拉黑的 IP（供管理面板展示）。
 * 返回原始 IP（经哈希→IP 映射还原）与 TTL；映射缺失时回退展示哈希前缀。
 */
export async function listIpBlacklist(
  redis: Redis
): Promise<Array<{ ip: string; ttl: number }>> {
  let keys: string[] = [];
  try {
    keys = await redis.keys(`${IPBLACK_PREFIX}*`);
  } catch (err) {
    console.error('listIpBlacklist keys scan failed:', err);
    return [];
  }
  const out: Array<{ ip: string; ttl: number }> = [];
  for (const k of keys.slice(0, 200)) {
    const h = k.replace(/^ipblack:/, '');
    let ip = h.slice(0, 12) + '…';
    let ttl = 0;
    try {
      const mapped = await redis.get<string>(`${IPBLACK_MAP_PREFIX}${h}`);
      if (mapped) ip = mapped;
    } catch { /* 映射读取失败则回退哈希 */ }
    try { ttl = await redis.ttl(k); } catch { /* */ }
    out.push({ ip, ttl });
  }
  return out;
}