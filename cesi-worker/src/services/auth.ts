import { createClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { ShardService } from './shard';

type Variables = { userId: string };

export function createAuthMiddleware(
  buildShardService: (env: Env) => Promise<ShardService>
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
    //    round-trip + a full account scan across 5 DBs before reaching this check.
    if (token.startsWith('anon_') && token.length >= 10) {
      c.set('userId', token);
      await next();
      return;
    }

    // 2. Try Supabase Auth JWT (only for tokens that are not anon IDs).
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

    // 3. Fall back to custom session token stored in mixed_data (type='account').
    try {
      const shard = await buildShardService(c.env);
      const accounts = await shard.readByType('account', { limit: 300 });
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
        await next();
        return;
      }
    } catch (err) {
      console.error('Custom token verification error:', err);
    }

    return c.json({ error: 'Invalid or expired token' }, 401);
  };
}
