import { createClient } from '@supabase/supabase-js';
import type { Redis } from '@upstash/redis/cloudflare';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { ShardService } from './shard';

type Variables = { userId: string };

const SESSION_PREFIX = 'sess:';

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
    if (token.startsWith('anon_') && token.length >= 10) {
      c.set('userId', token);
      await next();
      return;
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
    try {
      const shard = await buildShardService(c.env);
      // limit 提升到 1000（此前 300：账号超过 300 后老用户的 token 校验会直接失败）
      const accounts = await shard.readByType('account', { limit: 1000 });
      const account = accounts.find((row) => {
        try {
          const payload = JSON.parse(row.payload);
          const expiresAt = payload.session_expires_at ? new Date(payload.session_expires_at).getTime() : 0;
          return payload.session_token === token && expiresAt > Date.now();
        } catch {
          return false;
        }
      });

      if (account) {
        c.set('userId', account.user_id);
        // 回填 Redis 缓存，后续请求不再扫库
        try {
          const payload = JSON.parse(account.payload);
          await cacheSession(getRedis(c.env), token, account.user_id, payload.session_expires_at);
        } catch {
          /* 缓存回填失败不影响本次认证 */
        }
        await next();
        return;
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
