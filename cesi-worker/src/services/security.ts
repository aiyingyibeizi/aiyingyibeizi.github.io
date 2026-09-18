import type { Redis } from '@upstash/redis/cloudflare';
import type { ShardService } from './shard';
import type { Env } from '../types/env';

/**
 * 安全检测与告警（暴破 / 异常行为）
 *
 * 目标：不强化现有限流的情况下，把"暴力破解 / 异常刷量"检测出来并留痕，
 * 让后台管理面板能查到、也能主动外发通知（可选 webhook）。
 *
 * 存储：
 *  - Redis：实时计数(sliding/fixed)、封锁标记、告警去重冷却；(低延迟、易过期)
 *  - Shard(mixed_data, type='alert')：告警历史落库，供后台面板长期查看/审计。
 *
 * 设计要点：
 *  1) 告警写入前先查 Redis 冷却 key，同一事件源在窗口内只记一条，防止被攻击者反手刷爆存储。
 *  2) 封锁逻辑只在"失败次数超阈值"后触发，不影响正常登录，也不改变既有登录响应体。
 *  3) 所有 Redis 读写 fail-open：任何异常都不让登录/注册流程崩溃。
 */

export type SecurityKind =
  | 'bruteforce'     // 登录失败超阈值（疑似暴力破解）
  | 'credential'     // 有效用户名+错误密码（撞库命中，仅高优先级事件）
  | 'register'       // 注册异常（单 IP 短时大量注册）
  | 'comment'        // 内容滥发告警（可选）
  | 'admin'          // 管理后台相关告警（如连续错误的口令）
  | 'anomaly';       // 通用异常兜底

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export interface SecurityAlert {
  kind: SecurityKind;
  severity: SecuritySeverity;
  source_ip?: string;
  target?: string;          // 用户名 / user_id
  message: string;
  count: number;            // 命中的累计次数（写入 score_value）
  detail?: string;
  created_at?: string;
}

const LOCK_PREFIX = 'sec:block:';
const FAIL_PREFIX = 'sec:fail:';
const ALERT_COOLDOWN_PREFIX = 'sec:alertcd:';
const RESOLVED_FLAG = 'resolved';

export const SECURITY_LOCK_WINDOW_SEC = 15 * 60;      // 触发封锁后冻结 15 分钟
export const SECURITY_ALERT_WINDOW_SEC = 15 * 60;     // 失败统计窗口
export const SECURITY_FAIL_THRESHOLD = 8;             // 同源失败 >= 8 次即判定暴破
export const SECURITY_ALERT_COOLDOWN_SEC = 10 * 60;   // 同一事件源 10 分钟最多记一条告警

function safeKeyPart(v: string): string {
  return v.replace(/[^\w.\-@:]/g, '_').slice(0, 64) || 'anon';
}

/** 计数器自增并带过期（首见即设 TTL），返回最新计数值；Redis 异常时返回 0（不阻断流程） */
async function countAndExpire(redis: Redis, key: string, windowSec: number): Promise<number> {
  try {
    const k = `rl:${key}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowSec);
    return n;
  } catch (err) {
    console.error('security countAndExpire failed:', err);
    return 0;
  }
}

/** 是否被封锁 */
export async function isBlocked(redis: Redis, group: 'ip' | 'user', value: string): Promise<boolean> {
  try {
    const hit = await redis.get(`${LOCK_PREFIX}${group}:${safeKeyPart(value)}`);
    return Boolean(hit);
  } catch (err) {
    console.error('security isBlocked failed:', err);
    return false;
  }
}

/**
 * 记录一次登录失败。当 IP 或用户名的失败次数超过阈值时：
 *  - 封锁该源(LOCK_WINDOW)
 *  - 落一条 critical 暴破告警(带去重)并返回 { locked, alertWritten }
 */
export async function recordLoginFailure(
  redis: Redis,
  shard: ShardService,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  env: Env,
  ip: string,
  username: string,
  matchedUser: boolean // 该用户存在且被成功查找到（撞库信号）
): Promise<{ locked: boolean; alertWritten: boolean }> {
  const ipCount = await countAndExpire(redis, FAIL_PREFIX + 'ip:' + safeKeyPart(ip), SECURITY_ALERT_WINDOW_SEC);
  const userCount = await countAndExpire(redis, FAIL_PREFIX + 'user:' + safeKeyPart(username), SECURITY_ALERT_WINDOW_SEC);

  // 命中阈值才触发封锁 + 告警（8 次）。撞库命中的有效用户名提前到 3 次即告警但不封锁。
  const userBreach = matchedUser && userCount >= 3 && userCount < SECURITY_FAIL_THRESHOLD;
  const brute = ipCount >= SECURITY_FAIL_THRESHOLD || userCount >= SECURITY_FAIL_THRESHOLD;

  let locked = false;
  let alertWritten = false;

  if (brute) {
    try {
      await redis.set(`${LOCK_PREFIX}ip:${safeKeyPart(ip)}`, '1', { ex: SECURITY_LOCK_WINDOW_SEC });
      await redis.set(`${LOCK_PREFIX}user:${safeKeyPart(username)}`, '1', { ex: SECURITY_LOCK_WINDOW_SEC });
      locked = true;
    } catch (err) {
      console.error('security lock set failed:', err);
    }
    alertWritten = await recordAlert(redis, shard, waitUntil, env, {
      kind: 'bruteforce',
      severity: 'critical',
      source_ip: ip,
      target: username,
      message: `暴力破解：IP 在 ${SECURITY_ALERT_WINDOW_SEC / 60} 分钟内累计失败 ${Math.max(ipCount, userCount)} 次，已临时封锁 15 分钟`,
      count: Math.max(ipCount, userCount),
      detail: `matchedUser=${matchedUser} ipFail=${ipCount} userFail=${userCount}`,
    });
  } else if (userBreach) {
    alertWritten = await recordAlert(redis, shard, waitUntil, env, {
      kind: 'credential',
      severity: 'warning',
      source_ip: ip,
      target: username,
      message: `疑似撞库：有效账号"${username}"连续 ${userCount} 次密码错误`,
      count: userCount,
    });
  }

  return { locked, alertWritten };
}

/**
 * 写一条告警。先去重冷却：Redis 存在同源冷却 key 就跳过（返回 false）。
 * 落库后再可选外发 webhook。写库失败不影响调用方。
 */
export async function recordAlert(
  redis: Redis,
  shard: ShardService,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  env: Env,
  alert: SecurityAlert
): Promise<boolean> {
  const cdKey = `${ALERT_COOLDOWN_PREFIX}${safeKeyPart(alert.kind + ':' + (alert.source_ip || '') + ':' + (alert.target || '') + ':' + alert.message)}`;
  try {
    const seen = await redis.get(cdKey);
    if (seen) return false;
    await redis.set(cdKey, '1', { ex: SECURITY_ALERT_COOLDOWN_SEC });
  } catch (err) {
    console.error('security alert cooldown check failed:', err);
  }

  const createdAt = alert.created_at || new Date().toISOString();
  const result = await shard.write(
    {
      id: crypto.randomUUID(),
      user_id: alert.target ? alert.target : (alert.source_ip ? `ip:${safeKeyPart(alert.source_ip)}` : 'system'),
      type: 'alert',
      subtype: alert.kind,
      score_value: alert.count,
      payload: JSON.stringify({
        kind: alert.kind,
        severity: alert.severity,
        source_ip: alert.source_ip || null,
        target: alert.target || null,
        message: alert.message,
        count: alert.count,
        detail: alert.detail || null,
        resolved: false,
        created_at: createdAt,
      }),
      file_url: null,
      created_at: createdAt,
      updated_at: createdAt,
    },
    { waitUntil }
  );
  if (!result.ok) {
    console.error('alert persist failed:', result.error);
  }

  // 可选外发通知：仅未禁用时发送（fire-and-forget，经 waitUntil 确保在 Worker 生命周期内送达，不阻塞接口）
  const webhook = env.ADMIN_ALERT_WEBHOOK;
  if (webhook) {
    sendWebhook(webhook, {
      ...alert,
      alert_id: crypto.randomUUID(),
      created_at: createdAt,
      _title: 'APEXON 安全告警',
    }, waitUntil);
  }
  return true;
}

/** 外发安全告警到通知 webhook（异常时仅记日志，绝不影响主流程） */
function sendWebhook(
  webhook: string,
  payload: unknown,
  waitUntil?: ((p: Promise<unknown>) => void) | undefined
): void {
  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) console.warn('alert webhook non-2xx:', res.status);
    } catch (err) {
      console.error('alert webhook failed:', err);
    } finally {
      clearTimeout(timer);
    }
  })();
  task.catch(() => {});
  if (waitUntil) {
    try {
      waitUntil(task);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 注册异常检测：单 IP 在窗口内注册超过阈值，记一条 warning 告警。
 */
export async function recordRegisterSpike(
  redis: Redis,
  shard: ShardService,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  env: Env,
  ip: string
): Promise<void> {
  const REGISTER_WINDOW_SEC = 60;
  const REGISTER_THRESHOLD = 12;
  const count = await countAndExpire(redis, 'reg:' + safeKeyPart(ip), REGISTER_WINDOW_SEC);
  if (count >= REGISTER_THRESHOLD) {
    await recordAlert(redis, shard, waitUntil, env, {
      kind: 'register',
      severity: 'warning',
      source_ip: ip,
      message: `单一 IP 在 ${REGISTER_WINDOW_SEC / 60} 分钟内注册 ${count} 个账号（疑似脚本灌号）`,
      count,
    });
  }
}

/** 读取未解决告警数量（供面板角标/仪表盘显示） */
export async function countOpenAlerts(shard: ShardService): Promise<number> {
  try {
    const alerts = await shard.readByType('alert', { limit: 1000 });
    let open = 0;
    for (const r of alerts) {
      try {
        const p = JSON.parse(r.payload);
        if (!p.resolved) open += 1;
      } catch {
        open += 1;
      }
    }
    return open;
  } catch {
    return 0;
  }
}

/** 判断告警记录是否已解决 */
export function isAlertResolved(payload: any): boolean {
  return Boolean(payload && payload[RESOLVED_FLAG] === true);
}