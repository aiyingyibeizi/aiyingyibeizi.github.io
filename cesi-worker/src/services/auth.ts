import { createClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { ShardService } from './shard';

type Variables = { userId: string };

export function createAuthMiddleware(
  buildShardService: (env: Env) => ShardService
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

    // 1. Try Supabase Auth JWT first.
    try {
      const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data.user) {
        c.set('userId', data.user.id);
        await next();
        return;
      }
    } catch (err) {
      console.error('Supabase auth error:', err);
    }

    // 2. Fall back to custom username/session token stored in mixed_data (type='account').
    try {
      const shard = buildShardService(c.env);
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
        await next();
        return;
      }
    } catch (err) {
      console.error('Custom token verification error:', err);
    }

    // 3. Allow anonymous IDs (matches frontend anon_xxx behavior for unauthenticated actions).
    if (typeof token === 'string' && token.startsWith('anon_') && token.length >= 10) {
      c.set('userId', token);
      await next();
      return;
    }

    return c.json({ error: 'Invalid or expired token' }, 401);
  };
}
