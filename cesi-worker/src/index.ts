import { Hono } from 'hono';
import type { Env } from './types/env';
import type { MixedData, DbConfig } from './types/models';

import { createRedis } from './db/redis';
import {
  createTursoClient,
  tursoInsert,
  tursoSelectByUser,
  tursoGetMetaUsedBytes,
  tursoUpdateMetaUsedBytes,
} from './db/turso';
import {
  createNeonPool,
  neonInsert,
  neonSelectByUser,
  neonGetMetaUsedBytes,
  neonUpdateMetaUsedBytes,
} from './db/neon';
import {
  createSupabasePgPool,
  supabasePgInsert,
  supabasePgSelectByUser,
  supabasePgGetMetaUsedBytes,
  supabasePgUpdateMetaUsedBytes,
} from './db/supabase-pg';

import { authMiddleware } from './services/auth';
import { ShardService } from './services/shard';
import { uploadFile } from './services/storage';

const TURSO_MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const NEON_MAX_BYTES = 512 * 1024 * 1024; // 0.5 GB
const SUPABASE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_READ_LIMIT = 100;

type Variables = { userId: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', (c) => c.json({ status: 'ok' }));

app.use('/api/*', authMiddleware);

app.get('/api/data', async (c) => {
  const userId = c.get('userId');
  const shard = buildShardService(c.env);

  const queries = shard.getDbs().map(async (db) => {
    try {
      return await db.selectByUser(userId, DEFAULT_READ_LIMIT);
    } catch (err) {
      console.error(`Fan-out read failed for ${db.name}`, err);
      return [] as MixedData[];
    }
  });

  const results = await Promise.allSettled(queries);
  const merged = results
    .filter((r): r is PromiseFulfilledResult<MixedData[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, DEFAULT_READ_LIMIT);

  return c.json({ data: merged });
});

app.post('/api/data', async (c) => {
  const body = await c.req.json<{ type?: unknown; payload?: unknown; file_url?: unknown }>();
  if (typeof body.type !== 'string' || typeof body.payload === 'undefined') {
    return c.json({ error: 'type and payload are required' }, 400);
  }

  const now = new Date().toISOString();
  const data: MixedData = {
    id: crypto.randomUUID(),
    user_id: c.get('userId'),
    type: body.type,
    payload: JSON.stringify(body.payload),
    file_url: typeof body.file_url === 'string' ? body.file_url : null,
    created_at: now,
    updated_at: now,
  };

  const shard = buildShardService(c.env);
  const result = await shard.write(data);

  if (!result.ok) {
    return c.json({ error: result.error }, 507);
  }

  return c.json({ id: data.id, db: result.db }, 201);
});

app.post('/api/upload', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    return c.json({ error: 'Missing or invalid file field' }, 400);
  }

  const url = await uploadFile(c.env, c.get('userId'), file);
  return c.json({ url });
});

function buildShardService(env: Env): ShardService {
  const tursoApexon = createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON);
  const tursoApexon1 = createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1);
  const tursoApexon2 = createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2);
  const neonPool = createNeonPool(env.NEON_DSN);
  const supabasePool = createSupabasePgPool(env.SUPABASE_DSN);

  const dbs: DbConfig[] = [
    {
      name: 'turso_apexon',
      maxBytes: TURSO_MAX_BYTES,
      type: 'turso',
      insert: (data) => tursoInsert(tursoApexon, data),
      selectByUser: (userId, limit) => tursoSelectByUser(tursoApexon, userId, limit),
      getMetaUsedBytes: () => tursoGetMetaUsedBytes(tursoApexon, 'turso_apexon'),
      updateMetaUsedBytes: (used) =>
        tursoUpdateMetaUsedBytes(tursoApexon, 'turso_apexon', TURSO_MAX_BYTES, used),
    },
    {
      name: 'turso_apexon_1',
      maxBytes: TURSO_MAX_BYTES,
      type: 'turso',
      insert: (data) => tursoInsert(tursoApexon1, data),
      selectByUser: (userId, limit) => tursoSelectByUser(tursoApexon1, userId, limit),
      getMetaUsedBytes: () => tursoGetMetaUsedBytes(tursoApexon1, 'turso_apexon_1'),
      updateMetaUsedBytes: (used) =>
        tursoUpdateMetaUsedBytes(tursoApexon1, 'turso_apexon_1', TURSO_MAX_BYTES, used),
    },
    {
      name: 'turso_apexon_2',
      maxBytes: TURSO_MAX_BYTES,
      type: 'turso',
      insert: (data) => tursoInsert(tursoApexon2, data),
      selectByUser: (userId, limit) => tursoSelectByUser(tursoApexon2, userId, limit),
      getMetaUsedBytes: () => tursoGetMetaUsedBytes(tursoApexon2, 'turso_apexon_2'),
      updateMetaUsedBytes: (used) =>
        tursoUpdateMetaUsedBytes(tursoApexon2, 'turso_apexon_2', TURSO_MAX_BYTES, used),
    },
    {
      name: 'neon',
      maxBytes: NEON_MAX_BYTES,
      type: 'postgres',
      insert: (data) => neonInsert(neonPool, data),
      selectByUser: (userId, limit) => neonSelectByUser(neonPool, userId, limit),
      getMetaUsedBytes: () => neonGetMetaUsedBytes(neonPool, 'neon'),
      updateMetaUsedBytes: (used) => neonUpdateMetaUsedBytes(neonPool, 'neon', NEON_MAX_BYTES, used),
    },
    {
      name: 'supabase_pg',
      maxBytes: SUPABASE_MAX_BYTES,
      type: 'postgres',
      insert: (data) => supabasePgInsert(supabasePool, data),
      selectByUser: (userId, limit) => supabasePgSelectByUser(supabasePool, userId, limit),
      getMetaUsedBytes: () => supabasePgGetMetaUsedBytes(supabasePool, 'supabase_pg'),
      updateMetaUsedBytes: (used) =>
        supabasePgUpdateMetaUsedBytes(supabasePool, 'supabase_pg', SUPABASE_MAX_BYTES, used),
    },
  ];

  return new ShardService(createRedis(env), dbs);
}

export default app;
