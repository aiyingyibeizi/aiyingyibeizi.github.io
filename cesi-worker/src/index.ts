import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { createRedis } from './db/redis';
import { createTursoClient, tursoInsert, tursoSelectByUser, tursoSelectByType, tursoSelectById, tursoDeleteById, tursoCountByType, tursoGetMetaUsedBytes, tursoUpdateMetaUsedBytes } from './db/turso';
import { createNeonPool, neonInsert, neonSelectByUser, neonSelectByType, neonSelectById, neonDeleteById, neonCountByType, neonGetMetaUsedBytes, neonUpdateMetaUsedBytes } from './db/neon';
import { createSupabasePgPool, supabasePgInsert, supabasePgSelectByUser, supabasePgSelectByType, supabasePgSelectById, supabasePgDeleteById, supabasePgCountByType, supabasePgGetMetaUsedBytes, supabasePgUpdateMetaUsedBytes } from './db/supabase-pg';
import { ShardService } from './services/shard';
import { createAuthMiddleware } from './services/auth';
import { uploadFile } from './services/storage';
import type { Env } from './types/env';
import type { MixedData, DbConfig } from './types/models';

const DEFAULT_READ_LIMIT = 100;
const LOWER_IS_BETTER = new Set(['reaction', 'type', 'aim']);

function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function uuid(): string {
  return crypto.randomUUID();
}

function buildShardService(env: Env): ShardService {
  const redis = createRedis(env);

  const tursoApexon: DbConfig = {
    name: 'APEXON',
    maxBytes: 450 * 1024 * 1024, // 450 MB
    type: 'turso',
    insert: (data) => tursoInsert(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), data),
    selectByUser: (userId, limit) => tursoSelectByUser(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), userId, limit),
    selectByType: (type, options) => tursoSelectByType(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), type, options),
    selectById: (id) => tursoSelectById(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), id),
    deleteById: (id) => tursoDeleteById(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), id),
    countByType: (type) => tursoCountByType(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), type),
    getMetaUsedBytes: () => tursoGetMetaUsedBytes(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), 'APEXON'),
    updateMetaUsedBytes: (used) => tursoUpdateMetaUsedBytes(createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON), 'APEXON', 450 * 1024 * 1024, used),
  };

  const tursoApexon1: DbConfig = {
    name: 'APEXON_1',
    maxBytes: 450 * 1024 * 1024,
    type: 'turso',
    insert: (data) => tursoInsert(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), data),
    selectByUser: (userId, limit) => tursoSelectByUser(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), userId, limit),
    selectByType: (type, options) => tursoSelectByType(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), type, options),
    selectById: (id) => tursoSelectById(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), id),
    deleteById: (id) => tursoDeleteById(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), id),
    countByType: (type) => tursoCountByType(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), type),
    getMetaUsedBytes: () => tursoGetMetaUsedBytes(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), 'APEXON_1'),
    updateMetaUsedBytes: (used) => tursoUpdateMetaUsedBytes(createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1), 'APEXON_1', 450 * 1024 * 1024, used),
  };

  const tursoApexon2: DbConfig = {
    name: 'APEXON_2',
    maxBytes: 450 * 1024 * 1024,
    type: 'turso',
    insert: (data) => tursoInsert(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), data),
    selectByUser: (userId, limit) => tursoSelectByUser(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), userId, limit),
    selectByType: (type, options) => tursoSelectByType(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), type, options),
    selectById: (id) => tursoSelectById(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), id),
    deleteById: (id) => tursoDeleteById(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), id),
    countByType: (type) => tursoCountByType(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), type),
    getMetaUsedBytes: () => tursoGetMetaUsedBytes(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), 'APEXON_2'),
    updateMetaUsedBytes: (used) => tursoUpdateMetaUsedBytes(createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2), 'APEXON_2', 450 * 1024 * 1024, used),
  };

  const neon: DbConfig = {
    name: 'NEON',
    maxBytes: 450 * 1024 * 1024,
    type: 'postgres',
    insert: (data) => neonInsert(createNeonPool(env.NEON_DSN), data),
    selectByUser: (userId, limit) => neonSelectByUser(createNeonPool(env.NEON_DSN), userId, limit),
    selectByType: (type, options) => neonSelectByType(createNeonPool(env.NEON_DSN), type, options),
    selectById: (id) => neonSelectById(createNeonPool(env.NEON_DSN), id),
    deleteById: (id) => neonDeleteById(createNeonPool(env.NEON_DSN), id),
    countByType: (type) => neonCountByType(createNeonPool(env.NEON_DSN), type),
    getMetaUsedBytes: () => neonGetMetaUsedBytes(createNeonPool(env.NEON_DSN), 'NEON'),
    updateMetaUsedBytes: (used) => neonUpdateMetaUsedBytes(createNeonPool(env.NEON_DSN), 'NEON', 450 * 1024 * 1024, used),
  };

  const supabasePg: DbConfig = {
    name: 'SUPABASE',
    maxBytes: 450 * 1024 * 1024,
    type: 'postgres',
    insert: (data) => supabasePgInsert(createSupabasePgPool(env.SUPABASE_DSN), data),
    selectByUser: (userId, limit) => supabasePgSelectByUser(createSupabasePgPool(env.SUPABASE_DSN), userId, limit),
    selectByType: (type, options) => supabasePgSelectByType(createSupabasePgPool(env.SUPABASE_DSN), type, options),
    selectById: (id) => supabasePgSelectById(createSupabasePgPool(env.SUPABASE_DSN), id),
    deleteById: (id) => supabasePgDeleteById(createSupabasePgPool(env.SUPABASE_DSN), id),
    countByType: (type) => supabasePgCountByType(createSupabasePgPool(env.SUPABASE_DSN), type),
    getMetaUsedBytes: () => supabasePgGetMetaUsedBytes(createSupabasePgPool(env.SUPABASE_DSN), 'SUPABASE'),
    updateMetaUsedBytes: (used) => supabasePgUpdateMetaUsedBytes(createSupabasePgPool(env.SUPABASE_DSN), 'SUPABASE', 450 * 1024 * 1024, used),
  };

  return new ShardService(redis, [tursoApexon, tursoApexon1, tursoApexon2, neon, supabasePg]);
}

type Variables = { userId: string };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.get('/', (c) => c.text('APEXON Worker is running'));

// Public auth endpoints (not protected by auth middleware).
app.post('/api/auth/register', async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);
  if (username.length < 3 || username.length > 32) return c.json({ error: 'Username must be 3-32 characters' }, 400);
  if (password.length < 6) return c.json({ error: 'Password must be at least 6 characters' }, 400);

  const shard = buildShardService(c.env);
  const existing = await shard.readByType('account', { limit: 1000 });
  if (existing.find((r) => JSON.parse(r.payload).username === username)) {
    return c.json({ error: 'Username already exists' }, 409);
  }

  const userId = uuid();
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'account',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({
      username,
      password_hash: password, // In production, hash the password before storing.
      session_token: sessionToken,
      session_expires_at: expiresAt,
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return c.json({ user_id: userId, username, token: sessionToken, expires_at: expiresAt });
});

app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);

  const shard = buildShardService(c.env);
  const accounts = await shard.readByType('account', { limit: 1000 });
  const account = accounts.find((r) => {
    try {
      const p = JSON.parse(r.payload);
      return p.username === username && p.password_hash === password;
    } catch {
      return false;
    }
  });

  if (!account) return c.json({ error: 'Invalid username or password' }, 401);

  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Update session token in place.
  const payload = JSON.parse(account.payload);
  payload.session_token = sessionToken;
  payload.session_expires_at = expiresAt;

  // Delete old account record and insert updated one (mixed_data is append-only by design).
  await shard.deleteById(account.id);
  await shard.write({
    id: uuid(),
    user_id: account.user_id,
    type: 'account',
    subtype: null,
    score_value: null,
    payload: JSON.stringify(payload),
    file_url: null,
    created_at: account.created_at,
    updated_at: new Date().toISOString(),
  });

  return c.json({ user_id: account.user_id, username, token: sessionToken, expires_at: expiresAt });
});

app.post('/api/auth/merge-anon', createAuthMiddleware(buildShardService), async (c) => {
  const userId = c.get('userId');
  const { anon_id } = await c.req.json<{ anon_id?: string }>();
  if (!anon_id || !anon_id.startsWith('anon_')) return c.json({ error: 'Invalid anon_id' }, 400);

  const shard = buildShardService(c.env);
  const anonScores = await shard.readByUserAndType(anon_id, 'score', 1000);
  for (const row of anonScores) {
    await shard.write({ ...row, id: uuid(), user_id: userId, updated_at: new Date().toISOString() });
  }

  return c.json({ merged: anonScores.length });
});

// Protected API routes.
app.use('/api/*', createAuthMiddleware(buildShardService));

app.get('/api/scores', async (c) => {
  const userId = c.req.query('user_id');
  const testType = c.req.query('test_type');
  const leaderboard = c.req.query('leaderboard') === '1';
  const limit = Number(c.req.query('limit') || DEFAULT_READ_LIMIT);

  const shard = buildShardService(c.env);

  if (leaderboard && testType) {
    const order = LOWER_IS_BETTER.has(testType) ? 'asc' : 'desc';
    const rows = await shard.readByType('score', { subtype: testType, limit: 1000, orderByScore: order });

    // Filter out scores that are explicitly not leaderboard-eligible (e.g. reaction with 3+ fouls).
    const eligibleRows = rows.filter((r) => {
      try {
        const payload = JSON.parse(r.payload);
        return payload.leaderboardEligible !== false;
      } catch {
        return true;
      }
    });

    const bestByUser = new Map<string, MixedData>();
    for (const row of eligibleRows) {
      const existing = bestByUser.get(row.user_id);
      if (!existing) {
        bestByUser.set(row.user_id, row);
        continue;
      }
      const isBetter = LOWER_IS_BETTER.has(testType)
        ? (row.score_value ?? Infinity) < (existing.score_value ?? Infinity)
        : (row.score_value ?? -Infinity) > (existing.score_value ?? -Infinity);
      if (isBetter) bestByUser.set(row.user_id, row);
    }

    let bestRows = Array.from(bestByUser.values());
    bestRows.sort((a, b) => LOWER_IS_BETTER.has(testType)
      ? (a.score_value ?? Infinity) - (b.score_value ?? Infinity)
      : (b.score_value ?? -Infinity) - (a.score_value ?? -Infinity));
    bestRows = bestRows.slice(0, Math.min(Math.max(limit, 1), 1000));
    return c.json({ data: bestRows.map((r) => ({ ...r, payload: safeJsonParse(r.payload) })) });
  }

  const options: { userId?: string; subtype?: string; limit: number } = { limit: Math.min(Math.max(limit, 1), 1000) };
  if (userId) options.userId = userId;
  if (testType) options.subtype = testType;

  const rows = await shard.readByType('score', options);
  return c.json({ data: rows.map((r) => ({ ...r, payload: safeJsonParse(r.payload) })) });
});

app.post('/api/scores', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    username?: string;
    test_type?: string;
    score_value?: number;
    accuracy?: number;
    wpm?: number;
    cpm?: number;
    leaderboard_eligible?: boolean;
    payload?: Record<string, unknown>;
  }>();

  if (!body.test_type) return c.json({ error: 'test_type is required' }, 400);

  const scoreValue = body.score_value != null ? Number(body.score_value) : null;
  const payload = body.payload || {};
  if (body.leaderboard_eligible === false) payload.leaderboardEligible = false;

  const shard = buildShardService(c.env);
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'score',
    subtype: body.test_type,
    score_value: scoreValue,
    payload: JSON.stringify({
      username: body.username || '',
      test_type: body.test_type,
      score_value: scoreValue,
      accuracy: body.accuracy ?? null,
      wpm: body.wpm ?? null,
      cpm: body.cpm ?? null,
      ...payload,
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (!result.ok) return c.json({ error: result.error }, 503);
  return c.json({ ok: true, db: result.db });
});

app.delete('/api/scores', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id is required' }, 400);
  const shard = buildShardService(c.env);
  await shard.deleteById(id);
  return c.json({ ok: true });
});

app.get('/api/comments', async (c) => {
  const category = c.req.query('category');
  const limit = Number(c.req.query('limit') || DEFAULT_READ_LIMIT);
  const shard = buildShardService(c.env);
  const options: { subtype?: string; limit: number } = { limit: Math.min(Math.max(limit, 1), 1000) };
  if (category) options.subtype = category;
  const rows = await shard.readByType('comment', options);
  return c.json({ data: rows.map((r) => ({ ...r, payload: safeJsonParse(r.payload) })) });
});

app.post('/api/comments', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ content?: string; category?: string }>();
  if (!body.content || !body.content.trim()) return c.json({ error: 'content is required' }, 400);

  const shard = buildShardService(c.env);
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'comment',
    subtype: body.category || 'chat',
    score_value: null,
    payload: JSON.stringify({
      content: body.content.trim(),
      category: body.category || 'chat',
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (!result.ok) return c.json({ error: result.error }, 503);
  return c.json({ ok: true, db: result.db });
});

app.get('/api/profiles', async (c) => {
  const userId = c.get('userId');
  const shard = buildShardService(c.env);
  const rows = await shard.readByUserAndType(userId, 'profile', 1);
  if (!rows.length) return c.json({ data: null });
  return c.json({ data: { ...rows[0], payload: safeJsonParse(rows[0].payload) } });
});

app.get('/api/profiles/:userId', async (c) => {
  const userId = c.req.param('userId');
  const shard = buildShardService(c.env);
  const rows = await shard.readByUserAndType(userId, 'profile', 1);
  if (!rows.length) return c.json({ data: null });
  return c.json({ data: { ...rows[0], payload: safeJsonParse(rows[0].payload) } });
});

app.post('/api/profiles', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<Record<string, unknown>>();
  const shard = buildShardService(c.env);

  // Overwrite previous profile for this user.
  const existing = await shard.readByUserAndType(userId, 'profile', 1);
  for (const row of existing) await shard.deleteById(row.id);

  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'profile',
    subtype: null,
    score_value: null,
    payload: JSON.stringify(body),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (!result.ok) return c.json({ error: result.error }, 503);
  return c.json({ ok: true, db: result.db });
});

app.get('/api/stats', async (c) => {
  const shard = buildShardService(c.env);
  const [totalTests, totalComments, totalUsers] = await Promise.all([
    shard.countByType('score'),
    shard.countByType('comment'),
    (async () => {
      const scores = await shard.readByType('score', { limit: 10000 });
      const users = new Set(scores.map((r) => r.user_id));
      return users.size;
    })(),
  ]);

  const dbs = shard.getDbs().map((db) => ({ name: db.name, maxBytes: db.maxBytes }));
  return c.json({ total_tests: totalTests, total_comments: totalComments, total_users: totalUsers, dbs });
});

app.post('/api/upload', async (c) => {
  const userId = c.get('userId');
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'No file uploaded' }, 400);

  const fileUrl = await uploadFile(c.env, userId, file);

  const shard = buildShardService(c.env);
  await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'file',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({ filename: file.name, url: fileUrl }),
    file_url: fileUrl,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return c.json({ ok: true, url: fileUrl });
});

app.get('/api/admin/dbs', async (c) => {
  const shard = buildShardService(c.env);
  const statuses = await Promise.all(
    shard.getDbs().map(async (db) => {
      try {
        const used = await shard.getUsedBytes(db.name);
        return { name: db.name, used_bytes: used, max_bytes: db.maxBytes, healthy: used < db.maxBytes };
      } catch (err) {
        return { name: db.name, used_bytes: 0, max_bytes: db.maxBytes, healthy: false, error: String(err) };
      }
    })
  );
  return c.json({ data: statuses });
});

export default app;
