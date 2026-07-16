import { Redis } from '@upstash/redis/cloudflare';
import type { Env } from '../types/env';

export function createRedis(env: Env): Redis {
  return new Redis({
    url: env.UPSTASH_REDIS_URL,
    token: env.UPSTASH_REDIS_TOKEN,
  });
}
