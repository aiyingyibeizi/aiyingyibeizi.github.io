import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { createRedis } from './db/redis';
import { createTursoClient, tursoInsert, tursoSelectByUser, tursoSelectByType, tursoSelectById, tursoDeleteById, tursoCountByType, tursoGetMetaUsedBytes, tursoUpdateMetaUsedBytes } from './db/turso';
import { createNeonPool, neonInsert, neonSelectByUser, neonSelectByType, neonSelectById, neonDeleteById, neonCountByType, neonGetMetaUsedBytes, neonUpdateMetaUsedBytes } from './db/neon';
import { createSupabasePgPool, supabasePgInsert, supabasePgSelectByUser, supabasePgSelectByType, supabasePgSelectById, supabasePgDeleteById, supabasePgCountByType, supabasePgGetMetaUsedBytes, supabasePgUpdateMetaUsedBytes } from './db/supabase-pg';
import { ShardService } from './services/shard';
import { createAuthMiddleware } from './services/auth';
import { uploadFile } from './services/storage';
import { hashPassword, verifyPassword, isLegacyPassword } from './utils/password';
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

  // Reuse a single Turso client per database across requests
  const tursoApexonClient = createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON);
  const tursoApexon1Client = createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1);
  const tursoApexon2Client = createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2);

  // Reuse a single pg Pool per database
  const neonPool = createNeonPool(env.NEON_DSN);
  const supabasePgPool = createSupabasePgPool(env.SUPABASE_DSN);

  const tursoApexon: DbConfig = {
    name: 'APEXON',
    maxBytes: 450 * 1024 * 1024,
    type: 'turso',
    insert: (data) => tursoInsert(tursoApexonClient, data),
    selectByUser: (userId, limit) => tursoSelectByUser(tursoApexonClient, userId, limit),
    selectByType: (type, options) => tursoSelectByType(tursoApexonClient, type, options),
    selectById: (id) => tursoSelectById(tursoApexonClient, id),
    deleteById: (id) => tursoDeleteById(tursoApexonClient, id),
    countByType: (type) => tursoCountByType(tursoApexonClient, type),
    getMetaUsedBytes: () => tursoGetMetaUsedBytes(tursoApexonClient, 'APEXON'),
    updateMetaUsedBytes: (used) => tursoUpdateMetaUsedBytes(tursoApexonClient, 'APEXON', 450 * 1024 * 1024, used),
  };

  const tursoApexon1: DbConfig = {
    name: 'APEXON_1',
    maxBytes: 450 * 1024 * 1024,
    type: 'turso',
    insert: (data) => tursoInsert(tursoApexon1Client, data),
    selectByUser: (userId, limit) => tursoSelectByUser(tursoApexon1Client, userId, limit),
    selectByType: (type, options) => tursoSelectByType(tursoApexon1Client, type, options),
    selectById: (id) => tursoSelectById(tursoApexon1Client, id),
    deleteById: (id) => tursoDeleteById(tursoApexon1Client, id),
    countByType: (type) => tursoCountByType(tursoApexon1Client, type),
    getMetaUsedBytes: () => tursoGetMetaUsedBytes(tursoApexon1Client, 'APEXON_1'),
    updateMetaUsedBytes: (used) => tursoUpdateMetaUsedBytes(tursoApexon1Client, 'APEXON_1', 450 * 1024 * 1024, used),
  };

  const tursoApexon2: DbConfig = {
    name: 'APEXON_2',
    maxBytes: 450 * 1024 * 1024,
    type: 'turso',
    insert: (data) => tursoInsert(tursoApexon2Client, data),
    selectByUser: (userId, limit) => tursoSelectByUser(tursoApexon2Client, userId, limit),
    selectByType: (type, options) => tursoSelectByType(tursoApexon2Client, type, options),
    selectById: (id) => tursoSelectById(tursoApexon2Client, id),
    deleteById: (id) => tursoDeleteById(tursoApexon2Client, id),
    countByType: (type) => tursoCountByType(tursoApexon2Client, type),
    getMetaUsedBytes: () => tursoGetMetaUsedBytes(tursoApexon2Client, 'APEXON_2'),
    updateMetaUsedBytes: (used) => tursoUpdateMetaUsedBytes(tursoApexon2Client, 'APEXON_2', 450 * 1024 * 1024, used),
  };

  const neon: DbConfig = {
    name: 'NEON',
    maxBytes: 450 * 1024 * 1024,
    type: 'postgres',
    insert: (data) => neonInsert(neonPool, data),
    selectByUser: (userId, limit) => neonSelectByUser(neonPool, userId, limit),
    selectByType: (type, options) => neonSelectByType(neonPool, type, options),
    selectById: (id) => neonSelectById(neonPool, id),
    deleteById: (id) => neonDeleteById(neonPool, id),
    countByType: (type) => neonCountByType(neonPool, type),
    getMetaUsedBytes: () => neonGetMetaUsedBytes(neonPool, 'NEON'),
    updateMetaUsedBytes: (used) => neonUpdateMetaUsedBytes(neonPool, 'NEON', 450 * 1024 * 1024, used),
  };

  const supabasePg: DbConfig = {
    name: 'SUPABASE',
    maxBytes: 450 * 1024 * 1024,
    type: 'postgres',
    insert: (data) => supabasePgInsert(supabasePgPool, data),
    selectByUser: (userId, limit) => supabasePgSelectByUser(supabasePgPool, userId, limit),
    selectByType: (type, options) => supabasePgSelectByType(supabasePgPool, type, options),
    selectById: (id) => supabasePgSelectById(supabasePgPool, id),
    deleteById: (id) => supabasePgDeleteById(supabasePgPool, id),
    countByType: (type) => supabasePgCountByType(supabasePgPool, type),
    getMetaUsedBytes: () => supabasePgGetMetaUsedBytes(supabasePgPool, 'SUPABASE'),
    updateMetaUsedBytes: (used) => supabasePgUpdateMetaUsedBytes(supabasePgPool, 'SUPABASE', 450 * 1024 * 1024, used),
  };

  return new ShardService(redis, [tursoApexon, tursoApexon1, tursoApexon2, neon, supabasePg]);
}

type Variables = { userId: string };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') || '';
  const allowedOrigins = [
    'https://apexon.qzz.io',
    'https://www.apexon.qzz.io',
    'https://api.apexon.qzz.io',
    'http://localhost:3000',
    'http://localhost:5173',
  ];
  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
  } else {
    c.header('Access-Control-Allow-Origin', '*');
  }
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
  // Targeted query: only load accounts and check username match
  const existing = await shard.readByType('account', { limit: 500 });
  const duplicate = existing.find((r) => {
    try {
      return JSON.parse(r.payload).username === username;
    } catch {
      return false;
    }
  });
  if (duplicate) {
    return c.json({ error: 'Username already exists' }, 409);
  }

  const userId = uuid();
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // 密码哈希必须在后端完成，严禁在前端暴露哈希算法、盐值或迭代次数。
  const passwordHash = await hashPassword(password);

  await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'account',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({
      username,
      password_hash: passwordHash,
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
  // Targeted query: only load accounts and find matching username
  const accounts = await shard.readByType('account', { limit: 500 });
  const account = accounts.find((r) => {
    try {
      const p = JSON.parse(r.payload);
      return p.username === username;
    } catch {
      return false;
    }
  });

  if (!account) return c.json({ error: 'Invalid username or password' }, 401);

  const payload = JSON.parse(account.payload);
  const passwordHash = payload.password_hash;

  // 后端验证密码：旧版明文密码登录成功后自动迁移为新哈希格式。
  const passwordValid = await verifyPassword(password, passwordHash);
  if (!passwordValid) return c.json({ error: 'Invalid username or password' }, 401);

  // 若是旧版明文密码，立即重哈希并更新存储。
  if (isLegacyPassword(passwordHash)) {
    payload.password_hash = await hashPassword(password);
  }

  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  payload.session_token = sessionToken;
  payload.session_expires_at = expiresAt;

  // Atomic-ish: write new record first, then delete old one.
  // If write succeeds but delete fails, we have a duplicate (harmless).
  // If delete succeeds but write fails, the old record is gone (mitigated by writing first).
  const writeResult = await shard.write({
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

  if (!writeResult.ok) return c.json({ error: writeResult.error }, 503);
  await shard.deleteById(account.id);

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

// feedback 提交（公开接口，不需要认证）
app.post('/api/feedback', async (c) => {
  const body = await c.req.json<{ name?: string; email?: string; content?: string }>();
  const name = (body.name || '').toString().trim().slice(0, 60);
  const email = (body.email || '').toString().trim().slice(0, 120);
  const content = (body.content || '').toString().trim().slice(0, 2000);
  if (!name || !email || !content) return c.json({ ok: false, error: '所有字段必填' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ ok: false, error: '邮箱格式不正确' }, 400);
  const shard = buildShardService(c.env);
  const result = await shard.write({
    id: uuid(),
    user_id: 'feedback@public',
    type: 'feedback',
    subtype: 'contact',
    score_value: null,
    payload: JSON.stringify({ name, email, content }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 503);
  return c.json({ ok: true });
});

app.get('/api/stats', async (c) => {
  const shard = buildShardService(c.env);
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const now = Date.now();

  const [totalTests, totalComments, onlineRecords] = await Promise.all([
    shard.countByType('score'),
    shard.countByType('comment'),
    shard.readByType('online', { limit: 1000 }),
  ]);

  // 统计在线人数：last_seen 在 5 分钟内
  let online = 0;
  try {
    for (const r of onlineRecords) {
      const payload = safeJsonParse(r.payload);
      const lastSeenStr = (payload && (payload as any).last_seen) || r.updated_at || r.created_at;
      if (lastSeenStr) {
        const ts = new Date(String(lastSeenStr)).getTime();
        if (!isNaN(ts) && now - ts <= FIVE_MIN_MS) online += 1;
      }
    }
  } catch {
    online = onlineRecords.length;
  }

  // 总用户数：使用 account 类型的 count（每个注册账号一条记录）
  const total_users = await shard.countByType('account');

  const dbs = shard.getDbs().map((db) => ({ name: db.name, maxBytes: db.maxBytes }));
  return c.json({
    success: true,
    data: { online, total_tests: totalTests, total_comments: totalComments, total_users, dbs },
  });
});

// Protected API routes.
app.use('/api/*', createAuthMiddleware(buildShardService));

type FlatScore = {
  id: string;
  user_id: string;
  username: string;
  test_type: string;
  score_value: number | null;
  accuracy: number | null;
  wpm: number | null;
  cpm: number | null;
  created_at: string;
  updated_at: string;
  payload: unknown;
};

function flattenScore(r: MixedData): FlatScore {
  const payload: any = safeJsonParse(r.payload) || {};
  return {
    id: r.id,
    user_id: r.user_id,
    username: payload.username || r.user_id,
    test_type: payload.test_type || r.subtype || '',
    score_value: r.score_value != null ? Number(r.score_value) : (payload.score_value != null ? Number(payload.score_value) : null),
    accuracy: payload.accuracy != null ? Number(payload.accuracy) : null,
    wpm: payload.wpm != null ? Number(payload.wpm) : null,
    cpm: payload.cpm != null ? Number(payload.cpm) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    payload,
  };
}

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
    return c.json({ data: bestRows.map(flattenScore) });
  }

  const options: { userId?: string; subtype?: string; limit: number } = { limit: Math.min(Math.max(limit, 1), 1000) };
  if (userId) options.userId = userId;
  if (testType) options.subtype = testType;

  const rows = await shard.readByType('score', options);
  return c.json({ data: rows.map(flattenScore) });
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
  return c.json({ success: true });
});

app.delete('/api/scores', async (c) => {
  const userId = c.get('userId');
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id is required' }, 400);
  const shard = buildShardService(c.env);

  // Permission check: only the owner can delete their own score
  const row = await shard.readById(id);
  if (!row) return c.json({ error: 'Score not found' }, 404);
  if (row.user_id !== userId) return c.json({ error: 'Forbidden' }, 403);

  await shard.deleteById(id);
  return c.json({ success: true });
});

app.get('/api/comments', async (c) => {
  const category = c.req.query('category');
  const limit = Number(c.req.query('limit') || DEFAULT_READ_LIMIT);
  const shard = buildShardService(c.env);
  const options: { subtype?: string; limit: number } = { limit: Math.min(Math.max(limit, 1), 1000) };
  if (category) options.subtype = category;
  const rows = await shard.readByType('comment', options);
  return c.json({
    data: rows.map((r) => {
      const payload: any = safeJsonParse(r.payload) || {};
      return {
        id: r.id,
        user_id: r.user_id,
        username: payload.username || r.user_id,
        category: payload.category || r.subtype || 'chat',
        content: payload.content || '',
        created_at: r.created_at,
        updated_at: r.updated_at,
        payload,
      };
    }),
  });
});

app.post('/api/comments', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ username?: string; content?: string; category?: string }>();
  if (!body.content || !body.content.trim()) return c.json({ error: 'content is required' }, 400);

  const shard = buildShardService(c.env);
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'comment',
    subtype: body.category || 'chat',
    score_value: null,
    payload: JSON.stringify({
      username: body.username || userId,
      content: body.content.trim(),
      category: body.category || 'chat',
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (!result.ok) return c.json({ error: result.error }, 503);
  return c.json({ success: true });
});

// 批量读取多个用户的 profile（排行榜、用户卡片等展示场景）
// 同时兼容：不传 user_ids 时返回当前登录用户自身的 profile
app.get('/api/profiles', async (c) => {
  const userIdsQuery = c.req.query('user_ids');
  const shard = buildShardService(c.env);
  const flattenProfile = (r: MixedData) => {
    const payload: any = safeJsonParse(r.payload) || {};
    return {
      id: r.id,
      user_id: r.user_id,
      username: payload.username || r.user_id,
      bio: payload.bio || '',
      location: payload.location || '',
      website: payload.website || '',
      social_links: payload.social_links || '',
      avatar_url: payload.avatar_url || null,
      gender: payload.gender || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      payload,
    };
  };
  if (userIdsQuery) {
    const ids = userIdsQuery.split(',').map(s => s.trim()).filter(Boolean);
    const rows = await shard.readByType('profile', { limit: Math.min(ids.length * 2, 1000) });
    const filtered = rows.filter(r => ids.includes(r.user_id));
    return c.json({ data: filtered.map(flattenProfile) });
  }
  // 默认行为：返回当前登录用户自身的 profile
  const userId = c.get('userId');
  const rows = await shard.readByUserAndType(userId, 'profile', 1);
  if (!rows.length) return c.json({ data: null });
  return c.json({ data: flattenProfile(rows[0]) });
});

app.get('/api/profiles/:userId', async (c) => {
  const userId = c.req.param('userId');
  const shard = buildShardService(c.env);
  const rows = await shard.readByUserAndType(userId, 'profile', 1);
  if (!rows.length) return c.json({ success: true, data: null });
  const r = rows[0];
  const payload: any = safeJsonParse(r.payload) || {};
  return c.json({
    success: true,
    data: {
      id: r.id,
      user_id: r.user_id,
      username: payload.username || r.user_id,
      bio: payload.bio || '',
      location: payload.location || '',
      website: payload.website || '',
      social_links: payload.social_links || '',
      avatar_url: payload.avatar_url || null,
      gender: payload.gender || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      payload,
    },
  });
});

app.post('/api/profiles', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<Record<string, unknown>>();
  const shard = buildShardService(c.env);

  // Atomic-ish: write new profile first, then delete old ones
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

  // Delete old profiles after successful write
  const existing = await shard.readByUserAndType(userId, 'profile', 10);
  for (const row of existing) {
    if (row.payload !== JSON.stringify(body)) {
      await shard.deleteById(row.id);
    }
  }

  return c.json({ success: true });
});

// 修改用户名（原先走 Supabase RPC change_username，现统一走 Worker）
app.post('/api/profiles/username', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ old_username?: string; new_username?: string; token?: string }>();
  if (!body.new_username || typeof body.new_username !== 'string') {
    return c.json({ success: false, error: '新用户名不能为空' }, 400);
  }
  const newUsername = body.new_username.trim().slice(0, 40);
  const shard = buildShardService(c.env);
  const existing = await shard.readByUserAndType(userId, 'profile', 1);
  if (existing.length) {
    const prev = existing[0];
    await shard.deleteById(prev.id);
    const result = await shard.write({
      ...prev,
      id: uuid(),
      payload: JSON.stringify({
        ...(safeJsonParse(prev.payload) || {}),
        username: newUsername,
        updated_at: new Date().toISOString(),
      }),
      updated_at: new Date().toISOString(),
    });
    if (!result.ok) return c.json({ success: false, error: result.error }, 503);
  }
  return c.json({ success: true, username: newUsername });
});

// online_users 心跳（替代原来的 Supabase online_users 表直连）
app.post('/api/online_users', async (c) => {
  const body = await c.req.json<{ user_id?: string; last_seen?: string; on_conflict?: boolean }>();
  const userId = (body.user_id || c.get('userId') || '').toString().trim();
  if (!userId) return c.json({ ok: false, error: 'user_id 不能为空' }, 400);
  const lastSeen = body.last_seen || new Date().toISOString();
  const shard = buildShardService(c.env);
  // upsert：删除旧的再写新的，保证同一用户只有一条在线记录
  const existing = await shard.readByUserAndType(userId, 'online', 1);
  for (const row of existing) await shard.deleteById(row.id);
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'online',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({ last_seen: lastSeen }),
    file_url: null,
    created_at: lastSeen,
    updated_at: lastSeen,
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 503);
  return c.json({ ok: true, db: result.db });
});

// users 表 upsert（syncUser：首次登录/注册时写基础资料）
app.post('/api/users', async (c) => {
  const body = await c.req.json<{ user_id?: string; username?: string; email?: string; on_conflict?: boolean }>();
  const userId = (body.user_id || c.get('userId') || '').toString().trim();
  if (!userId) return c.json({ ok: false, error: 'user_id 不能为空' }, 400);
  const shard = buildShardService(c.env);
  const existing = await shard.readByUserAndType(userId, 'user', 1);
  if (existing.length) return c.json({ ok: true, existed: true });
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'user',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({
      username: body.username || '',
      email: body.email || '',
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 503);
  return c.json({ ok: true, db: result.db });
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
