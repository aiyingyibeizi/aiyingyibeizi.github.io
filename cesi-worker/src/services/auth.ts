import { createClient } from '@supabase/supabase-js';
import type { Redis } from '@upstash/redis/cloudflare';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { ShardService } from './shard';

type Variables = { userId: string };

const SESSION_PREFIX = 'sess:';

// ---------------------------------------------------------------------------
// 匿名 token 签名（H1 修复）
// 此前任何 anon_xxxxxxxxxx 都被直接放行，可伪造任意匿名身份刷分。
// 现在由服务端签发 anon_<raw>.<hmac>，中间件校验签名后才认。密钥从服务端已有密钥派生，
// 无需新增配置；客户端永远拿不到密钥。
// ---------------------------------------------------------------------------
const ANON_PREFIX = 'anon_';
const ANON_SIG_LEN = 32;

/** 派生匿名签名密钥：优先专用变量，否则从服务端既有密钥回退（均不出现在前端） */
function anonSecret(env: Env): string {
  return (
    env.ANON_HMAC_SECRET ||
    env.ADMIN_TOKEN ||
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.UPSTASH_REDIS_TOKEN ||
    env.TURSO_TOKEN_APEXON ||
    ''
  );
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  let out = '';
  for (const b of new Uint8Array(sig)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 常数时间字符串比较（防时序旁路） */
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** 用服务端密钥为原始匿名 ID 签名，返回可直接下发给前端的完整 token */
export async function signAnonId(env: Env, raw: string): Promise<string> {
  const secret = anonSecret(env);
  if (!secret) return `${ANON_PREFIX}${raw}`; // 未配置任何密钥：退回未签名（极端兜底）
  const sig = (await hmacHex(secret, raw)).slice(0, ANON_SIG_LEN);
  return `${ANON_PREFIX}${raw}.${sig}`;
}

/** 校验结果：ok=通过；stale=旧格式未签名需刷新；bad=签名非法；disabled=服务端未配置密钥（放行并保持旧行为） */
type AnonVerdict = 'ok' | 'stale' | 'bad' | 'disabled';

async function verifyAnonId(env: Env, token: string): Promise<AnonVerdict> {
  const secret = anonSecret(env);
  if (!secret) return 'disabled';

  const body = token.slice(ANON_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot < 0) return 'stale'; // 旧格式（无签名）
  const raw = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  if (!raw || raw.length < 8 || sig.length !== ANON_SIG_LEN) return 'bad';
  const expected = (await hmacHex(secret, raw)).slice(0, ANON_SIG_LEN);
  return constantTimeEqual(sig, expected) ? 'ok' : 'bad';
}

export function createAuthMiddleware(
  buildShardService: (env: Env) => Promise<ShardService>,
  getRedis: (env: Env) => Redis
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return c.json({ error: 'Empty Bearer token' }, 401);
    }

    // 1. Fast path: anonymous IDs are instantly recognisable and the most common case.
    //    Skip all network/DB work — every POST from a guest used to trigger a Supabase
    //    round-trip + a full account scan across all DBs before reaching this check.
    //    H1 修复：匿名 token 必须带服务端 HMAC 签名，杜绝伪造 anon_ 前缀刷分。
    if (token.startsWith('anon_') && token.length >= 10) {
      const verdict = await verifyAnonId(c.env, token);
      if (verdict === 'ok' || verdict === 'disabled') {
        c.set('userId', token);
        await next();
        return;
      }
      // stale（旧的无签名 token）→ 前端据此重新领取签名 token 并重试
      return c.json({ error: 'Invalid anonymous token', anon_refresh: true }, 401);
    }

    // 2. Redis session cache（修复认证热路径性能问题）：
    //    此前每个携带自定义 token 的请求都要 fan-out 查询 3 个 Turso 库、
    //    各拉取全部账号记录（含密码哈希）再逐条 JSON.parse。现在命中缓存直接放行。
    try {
      const cached = await getRedis(c.env).get<{ user_id: string; expires_at?: string }>(`${SESSION_PREFIX}${token}`);
      if (cached && cached.user_id) {
        const expiresAt = cached.expires_at ? new Date(cached.expires_at).getTime() : 0;
        if (expiresAt > Date.now()) {
          c.set('userId', cached.user_id);
          await next();
          return;
        }
      }
    } catch {
      /* Redis 不可用时降级到数据库校验 */
    }

    // 3. Try Supabase Auth JWT (only for tokens that are not anon IDs).
    //    Fully wrapped in try-catch to silently skip if SUPABASE env vars are missing
    //    or createClient/getUser throws for any reason — must never crash the middleware.
    try {
      if (c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY) {
        const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data.user) {
          c.set('userId', data.user.id);
          await next();
          return;
        }
      }
    } catch (_err) {
      // Silently ignore — fall through to custom session token check.
    }

    // 4. Fall back to custom session token stored in mixed_data (type='account').
    //    H4 修复：改为按 session_token 在数据库层精确查询，不再拉取全部账号逐条比对。
    try {
      const shard = await buildShardService(c.env);
      const account = await shard.findAccount('session_token', token);
      if (account) {
        let payload: any = {};
        try {
          payload = JSON.parse(account.payload);
        } catch {
          payload = {};
        }
        const expiresAt = payload.session_expires_at ? new Date(payload.session_expires_at).getTime() : 0;
        // 过期时间缺失时按「不过期」处理会放大风险；这里要求必须有未过期的到期时间
        if (expiresAt > Date.now()) {
          c.set('userId', account.user_id);
          // 回填 Redis 缓存，后续请求不再扫库
          try {
            await cacheSession(getRedis(c.env), token, account.user_id, payload.session_expires_at);
          } catch {
            /* 缓存回填失败不影响本次认证 */
          }
          await next();
          return;
        }
      }
    } catch (err) {
      console.error('Custom token verification error:', err);
    }

    return c.json({ error: 'Invalid or expired token' }, 401);
  };
}

/** 登录/注册成功后写入 session 缓存（失败静默，不影响登录流程） */
export async function cacheSession(redis: Redis, token: string, userId: string, expiresAtIso?: string): Promise<void> {
  try {
    const expiresAt = expiresAtIso ? new Date(expiresAtIso).getTime() : Date.now() + 7 * 24 * 3600 * 1000;
    const ttlSec = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
    await redis.set(
      `${SESSION_PREFIX}${token}`,
      { user_id: userId, expires_at: expiresAtIso },
      { ex: Math.min(ttlSec, 7 * 24 * 3600) }
    );
  } catch {
    /* 缓存失败可接受 */
  }
}

/** 重新登录后吊销旧 token 的缓存（保持与数据库校验一致的失效语义） */
export async function revokeSession(redis: Redis, token: string): Promise<void> {
  try {
    await redis.del(`${SESSION_PREFIX}${token}`);
  } catch {
    /* 缓存失败可接受 */
  }
}
