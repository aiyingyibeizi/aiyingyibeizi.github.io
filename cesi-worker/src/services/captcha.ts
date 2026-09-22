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
 * 注意：任何 Redis 异常都返回 true，绝不因验证码子系统故障把正常用户挡在登录外。
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
    console.error('verifyCaptcha failed:', err);
    return true; // fail-open
  }
}

// ---- IP 黑名单（累积式）----
const IPBLACK_PREFIX = 'ipblack:';

/** 记录一次登录失败（按 IP 累积）；返回该 IP 在窗口内的累计失败次数 */
export async function countIpFailure(redis: Redis, ip: string, windowSec: number): Promise<number> {
  try {
    const k = `${IPBLACK_PREFIX}${safeKey(ip)}`;
    const n = await redis.incr(k);
    if (n <= 1) await redis.expire(k, windowSec);
    return n;
  } catch (err) {
    console.error('countIpFailure failed:', err);
    return 0;
  }
}

/** 该 IP 是否已进入黑名单（黑名单 key 存活期间即视为拉黑） */
export async function isIpBlacklisted(redis: Redis, ip: string): Promise<boolean> {
  try {
    return !!(await redis.get(`${IPBLACK_PREFIX}${safeKey(ip)}`));
  } catch (err) {
    console.error('isIpBlacklisted failed:', err);
    return false;
  }
}

/** 当累计失败达到阈值时，把该 IP 拉黑 durationSec 秒（在现有计数 key 上直接续命） */
export async function blacklistIp(redis: Redis, ip: string, durationSec: number): Promise<void> {
  try {
    const k = `${IPBLACK_PREFIX}${safeKey(ip)}`;
    const n = await redis.incr(k);
    if (n <= 1) await redis.expire(k, durationSec);
    else await redis.expire(k, durationSec); // 延长
  } catch (err) {
    console.error('blacklistIp failed:', err);
  }
}

/** 取黑名单计数（供面板展示失败次数） */
export async function ipBlacklistCount(redis: Redis, ip: string): Promise<number> {
  try {
    return (await redis.get<number>(`${IPBLACK_PREFIX}${safeKey(ip)}`)) || 0;
  } catch (err) {
    console.error('ipBlacklistCount failed:', err);
    return 0;
  }
}

/** 手动解除某个 IP 的黑名单 */
export async function clearIpBlacklist(redis: Redis, ip: string): Promise<void> {
  try {
    await redis.del(`${IPBLACK_PREFIX}${safeKey(ip)}`);
  } catch (err) {
    console.error('clearIpBlacklist failed:', err);
  }
}