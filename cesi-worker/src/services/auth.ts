import { createClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';

export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: { userId: string } }> = async (
  c,
  next
) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return c.json({ error: 'Empty Bearer token' }, 401);
  }

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    console.error('Supabase auth error:', error);
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  c.set('userId', data.user.id);
  await next();
};
