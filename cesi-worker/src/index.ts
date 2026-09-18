import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Redis } from '@upstash/redis/cloudflare';
import { createRedis } from './db/redis';
import { createTursoClient, tursoMigrate, tursoInsert, tursoSelectByUser, tursoSelectByType, tursoSelectLeaderboard, tursoSelectById, tursoDeleteById, tursoCountByType, tursoGetMetaUsedBytes, tursoUpdateMetaUsedBytes } from './db/turso';
// 已切换为仅使用 3 个 Turso 数据库（同厂商，延迟更低），Neon 和 Supabase 暂时注释掉
// import { createClient } from '@supabase/supabase-js';
// import { createNeonPool, neonMigrate, neonInsert, neonSelectByUser, neonSelectByType, neonSelectById, neonDeleteById, neonCountByType, neonGetMetaUsedBytes, neonUpdateMetaUsedBytes } from './db/neon';
// import { createSupabasePgPool, supabasePgMigrate, supabasePgInsert, supabasePgSelectByUser, supabasePgSelectByType, supabasePgSelectById, supabasePgDeleteById, supabasePgCountByType, supabasePgGetMetaUsedBytes, supabasePgUpdateMetaUsedBytes } from './db/supabase-pg';
import { ShardService } from './services/shard';
import { createAuthMiddleware, cacheSession } from './services/auth';
import { uploadFile } from './services/storage';
import { hashPassword, verifyPassword, isLegacyPassword, needsRehash } from './utils/password';
import { rateLimit, clientIp, rlKey } from './services/ratelimit';
import { isBlocked, recordLoginFailure, recordRegisterSpike, countOpenAlerts } from './services/security';
import { writeAudit, searchAccounts, getUserDetail, flattenAccount, listContent } from './services/admin';
import { verifyAdminPassword, verifyAdminTotp, adminOtpauthUri, adminSessionTtl, recordAdminLoginFailure, isAdminLocked, lockAdminSource, clearAdminFailures, createAdminSession, resolveAdminSession, revokeAdminSession, ADMIN_FAIL_LOCK_THRESHOLD } from './services/admin';
import { renderAdminUI } from './services/admin-ui';
import type { Env } from './types/env';
import type { MixedData, DbConfig } from './types/models';

const DEFAULT_READ_LIMIT = 100;
const LOWER_IS_BETTER = new Set(['reaction', 'type', 'aim']);

/** 字符串字段统一收敛：非 string 置空、超长截断（防注入/超大 payload） */
function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : '';
}
/** 安全数值：仅接受有限数值，否则回退默认 */
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

let migrated = false;
let cachedShardService: ShardService | null = null;
let cachedRedis: Redis | null = null;

function getRedis(env: Env): Redis {
  if (!cachedRedis) cachedRedis = createRedis(env);
  return cachedRedis;
}

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

async function buildShardService(env: Env): Promise<ShardService> {
  // Return cached instance if available
  if (cachedShardService) {
    return cachedShardService;
  }

  // 诊断：列出缺少凭证的 Turso 库，便于定位"所有写入都失败"（Cloudflare Secret 未配置/已过期）
  const requiredTurso: Array<{ name: string; url?: string; token?: string }> = [
    { name: 'APEXON', url: env.TURSO_URL_APEXON, token: env.TURSO_TOKEN_APEXON },
    { name: 'APEXON_1', url: env.TURSO_URL_APEXON_1, token: env.TURSO_TOKEN_APEXON_1 },
    { name: 'APEXON_2', url: env.TURSO_URL_APEXON_2, token: env.TURSO_TOKEN_APEXON_2 },
  ];
  const missingTurso = requiredTurso.filter((d) => !d.url || !d.token).map((d) => d.name);
  if (missingTurso.length) {
    console.error(`[buildShardService] 缺失 Turso 凭证的库：${missingTurso.join(', ')}，请在 Cloudflare Worker 配置对应 Secret`);
  }

  const redis = createRedis(env);

  // Reuse a single Turso client per database across requests
  const tursoApexonClient = createTursoClient(env.TURSO_URL_APEXON, env.TURSO_TOKEN_APEXON);
  const tursoApexon1Client = createTursoClient(env.TURSO_URL_APEXON_1, env.TURSO_TOKEN_APEXON_1);
  const tursoApexon2Client = createTursoClient(env.TURSO_URL_APEXON_2, env.TURSO_TOKEN_APEXON_2);

  // 已切换为仅使用 3 个 Turso 数据库，Neon 和 Supabase 连接池注释掉
  // const neonPool = createNeonPool(env.NEON_DSN);
  // const supabasePgPool = createSupabasePgPool(env.SUPABASE_DSN);

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
    selectLeaderboard: (subtype, order, limit) => tursoSelectLeaderboard(tursoApexonClient, subtype, order, limit),
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
    selectLeaderboard: (subtype, order, limit) => tursoSelectLeaderboard(tursoApexon1Client, subtype, order, limit),
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
    selectLeaderboard: (subtype, order, limit) => tursoSelectLeaderboard(tursoApexon2Client, subtype, order, limit),
    getMetaUsedBytes: () => tursoGetMetaUsedBytes(tursoApexon2Client, 'APEXON_2'),
    updateMetaUsedBytes: (used) => tursoUpdateMetaUsedBytes(tursoApexon2Client, 'APEXON_2', 450 * 1024 * 1024, used),
  };

  // 已切换为仅使用 3 个 Turso 数据库，Neon 和 Supabase 配置注释掉
  // const neon: DbConfig = {
  //   name: 'NEON',
  //   maxBytes: 450 * 1024 * 1024,
  //   type: 'postgres',
  //   insert: (data) => neonInsert(neonPool, data),
  //   selectByUser: (userId, limit) => neonSelectByUser(neonPool, userId, limit),
  //   selectByType: (type, options) => neonSelectByType(neonPool, type, options),
  //   selectById: (id) => neonSelectById(neonPool, id),
  //   deleteById: (id) => neonDeleteById(neonPool, id),
  //   countByType: (type) => neonCountByType(neonPool, type),
  //   getMetaUsedBytes: () => neonGetMetaUsedBytes(neonPool, 'NEON'),
  //   updateMetaUsedBytes: (used) => neonUpdateMetaUsedBytes(neonPool, 'NEON', 450 * 1024 * 1024, used),
  // };
  // const supabasePg: DbConfig = {
  //   name: 'SUPABASE',
  //   maxBytes: 450 * 1024 * 1024,
  //   type: 'postgres',
  //   insert: (data) => supabasePgInsert(supabasePgPool, data),
  //   selectByUser: (userId, limit) => supabasePgSelectByUser(supabasePgPool, userId, limit),
  //   selectByType: (type, options) => supabasePgSelectByType(supabasePgPool, type, options),
  //   selectById: (id) => supabasePgSelectById(supabasePgPool, id),
  //   deleteById: (id) => supabasePgDeleteById(supabasePgPool, id),
  //   countByType: (type) => supabasePgCountByType(supabasePgPool, type),
  //   getMetaUsedBytes: () => supabasePgGetMetaUsedBytes(supabasePgPool, 'SUPABASE'),
  //   updateMetaUsedBytes: (used) => supabasePgUpdateMetaUsedBytes(supabasePgPool, 'SUPABASE', 450 * 1024 * 1024, used),
  // };

  // 仅使用 3 个 Turso 数据库（同厂商，延迟更低）
  cachedShardService = new ShardService(redis, [tursoApexon, tursoApexon1, tursoApexon2]);

  // 同步执行迁移（带超时保护）。
  // 之前是后台异步执行，导致 write() 在迁移完成前就执行，insert 因缺 subtype 列而失败。
  // 现在同步等待迁移完成，第一次请求会稍慢，但后续请求不会再有表结构问题。
  if (!migrated) {
    migrated = true;
    const withMigrateTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} migrate timed out`)), 10000)),
      ]);
    const results = await Promise.allSettled([
      withMigrateTimeout(tursoMigrate(tursoApexonClient), 'APEXON'),
      withMigrateTimeout(tursoMigrate(tursoApexon1Client), 'APEXON_1'),
      withMigrateTimeout(tursoMigrate(tursoApexon2Client), 'APEXON_2'),
      // withMigrateTimeout(neonMigrate(neonPool), 'NEON'),
      // withMigrateTimeout(supabasePgMigrate(supabasePgPool), 'SUPABASE'),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`Migration ${i} failed:`, r.reason);
      }
    });
  }

  return cachedShardService;
}

type Variables = { userId: string; adminToken?: string };
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
  // 只在来源明确时回显确切 Origin；不认识的来源一律不返回 ACAO，
  // 绝不回退成 '*'(与 Allow-Credentials 同用属于错误配置)。
  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
  }
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id');
  c.header('Vary', 'Origin');

  // 通用安全响应头（API 返回 JSON，对这些头最relevant的是 nosniff；
  // 其余按业界默认补全，不影响前端渲染）
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // API 返回动态/鉴权数据，禁止任何缓存，防止浏览器或中间代理把含会话钥匙的响应落盘
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');

  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.get('/', (c) => c.text('APEXON Worker is running'));

// Public auth endpoints (not protected by auth middleware).
app.post('/api/auth/register', async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);
  if (username.length < 2 || username.length > 30) return c.json({ error: 'Username must be 2-30 characters' }, 400);
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return c.json({ error: 'Password must be at least 8 characters and contain both letters and numbers' }, 400);

  // 频率限制：按 IP 限注册，防脚本批量灌号
  if (!(await rateLimit(getRedis(c.env), rlKey('register', clientIp(c)), 10, 60))) {
    return c.json({ error: 'Too many attempts, please try again later' }, 429);
  }

  const shard = await buildShardService(c.env);
  // Targeted query: only load accounts and check username match
  const existing = await shard.readByType('account', { limit: 1000 });
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
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

  // 登录/注册成功后立即写入 Redis 会话缓存，后续请求不再扫库
  await cacheSession(getRedis(c.env), sessionToken, userId, expiresAt);

  // 注册异常检测：单 IP 短时大量注册触发告警（fire-and-forget）
  try {
    const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
    const spike = recordRegisterSpike(getRedis(c.env), await buildShardService(c.env), waitUntil, c.env, clientIp(c));
    spike.catch((err) => console.error('recordRegisterSpike error:', err));
    try { waitUntil(spike); } catch { /* ignore */ }
  } catch (err) {
    console.error('register spike hook error:', err);
  }

  return c.json({ user_id: userId, username, token: sessionToken, expires_at: expiresAt });
});

app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);
  if (username.length < 2 || username.length > 30) return c.json({ error: 'Username must be 2-30 characters' }, 400);
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return c.json({ error: 'Password must be at least 8 characters and contain both letters and numbers' }, 400);

  // 频率限制：同时按 IP 和账号名限速，兼顾封堵脚本与防止对单一账号打爆。
  // 限制统一走 before 响应，两次校验用同一把计数，避免重复消耗 Redis 调用。
  const ip = clientIp(c);
  const ipOk = await rateLimit(getRedis(c.env), rlKey('login-ip', ip), 30, 60);
  const userOk = await rateLimit(getRedis(c.env), rlKey('login-user', username), 10, 60);
  if (!ipOk || !userOk) return c.json({ error: 'Too many attempts, please try again later' }, 429);

  // 暴破封锁：登录前先查是否因失败次数过多被临时冻结（成功则正常放行，不影响既有流程）
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  if (await isBlocked(getRedis(c.env), 'ip', ip) || await isBlocked(getRedis(c.env), 'user', username)) {
    return c.json({ error: 'Too many attempts, account temporarily locked' }, 429);
  }

  const shard = await buildShardService(c.env);
  // Targeted query: only load accounts and find matching username
  const accounts = await shard.readByType('account', { limit: 1000 });
  const account = accounts.find((r) => {
    try {
      const p = JSON.parse(r.payload);
      return p.username === username;
    } catch {
      return false;
    }
  });

  // 账号不存在：记入暴破失败计数（fire-and-forget，不拖慢登录响应）
  if (!account) {
    logLoginFailure(c, username, false);
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const payload = JSON.parse(account.payload);

  // 封禁账号拒绝登录（管理后台设置；不影响已有解锁逻辑）
  if (payload.banned === true) {
    return c.json({ error: 'Account suspended' }, 403);
  }

  const passwordHash = payload.password_hash;

  // 后端验证密码：旧版明文密码登录成功后自动迁移为新哈希格式。
  const passwordValid = await verifyPassword(password, passwordHash);
  if (!passwordValid) {
    logLoginFailure(c, username, true);
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  // 旧明文 / 旧算法(sha256) / 低迭代 → 登录成功后统一重哈希到最强参数（PBKDF2-SHA512/600k）
  if (isLegacyPassword(passwordHash) || needsRehash(passwordHash)) {
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
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

  if (!writeResult.ok) return c.json({ error: writeResult.error }, 503);
  await shard.deleteById(account.id);

  // 登录成功后写入 Redis 会话缓存
  await cacheSession(getRedis(c.env), sessionToken, account.user_id, expiresAt);

  return c.json({ user_id: account.user_id, username, token: sessionToken, expires_at: expiresAt });
});

app.post('/api/auth/merge-anon', createAuthMiddleware(buildShardService, getRedis), async (c) => {
  const userId = c.get('userId');
  const { anon_id } = await c.req.json<{ anon_id?: string }>();
  if (!anon_id || !anon_id.startsWith('anon_')) return c.json({ error: 'Invalid anon_id' }, 400);

  const shard = await buildShardService(c.env);
  const anonScores = await shard.readByUserAndType(anon_id, 'score', 1000);
  for (const row of anonScores) {
    await shard.write({ ...row, id: uuid(), user_id: userId, updated_at: new Date().toISOString() }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
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
  // 公开接口务必限流，防脚本刷反馈表单
  if (!(await rateLimit(getRedis(c.env), rlKey('feedback', clientIp(c)), 5, 60))) {
    return c.json({ ok: false, error: '太频繁了，稍后再试' }, 429);
  }
  const shard = await buildShardService(c.env);
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
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 503);
  return c.json({ ok: true });
});

app.get('/api/stats', async (c) => {
  const redis = getRedis(c.env);
  const STATS_CACHE_KEY = 'cache:stats';
  try {
    // 直接存取对象，Upstash SDK 自动序列化/反序列化
    const cached = await redis.get(STATS_CACHE_KEY);
    if (cached) return c.json(cached);
  } catch (err) {
    console.warn('stats cache read failed:', err);
  }

  const shard = await buildShardService(c.env);
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
  const body = {
    success: true,
    data: { online, total_tests: totalTests, total_comments: totalComments, total_users, dbs },
  };
  try {
    await redis.set(STATS_CACHE_KEY, body, { ex: 30 });
  } catch (err) {
    console.warn('stats cache write failed:', err);
  }
  return c.json(body);
});

// Protected API routes.
function authOrAdmin(c: Parameters<ReturnType<typeof createAuthMiddleware>>[0], next: () => Promise<void>) {
  // /api/admin/* 由 ADMIN_TOKEN 单独把关（见对应路由），不走用户登录态
  if (c.req.path.startsWith('/api/admin')) return next();
  return createAuthMiddleware(buildShardService, getRedis)(c, next);
}

/** 记录一次登录失败并依据阈值触发暴破封锁/告警（fire-and-forget，不拖慢登录响应） */
async function logLoginFailure(c: { env: Env; executionCtx: any; req: { header: (n: string) => string | undefined } }, username: string, matchedUser: boolean) {
  try {
    const shard = await buildShardService(c.env);
    const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
    const task = recordLoginFailure(getRedis(c.env), shard, waitUntil, c.env, clientIp(c), username, matchedUser);
    task.catch((err) => console.error('recordLoginFailure error:', err));
    try { waitUntil(task); } catch { /* ignore */ }
  } catch (err) {
    console.error('logLoginFailure error:', err);
  }
}
app.use('/api/*', authOrAdmin);

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
  const testType = str(c.req.query('test_type'), 40).trim();
  const leaderboard = c.req.query('leaderboard') === '1';
  const limit = Number(c.req.query('limit') || DEFAULT_READ_LIMIT);

  const shard = await buildShardService(c.env);

  if (leaderboard && testType) {
    const redis = getRedis(c.env);
    const lbCacheKey = `cache:lb:${testType}`;
    try {
      const cached = await redis.get(lbCacheKey);
      if (cached) return c.json(cached);
    } catch (err) {
      console.warn('leaderboard cache read failed:', err);
    }

    const order = LOWER_IS_BETTER.has(testType) ? 'asc' : 'desc';

    // 优先使用数据库端排行榜聚合（每用户最佳成绩，SQL ROW_NUMBER + leaderboardEligible 过滤）
    // 返回 null 时回退到旧的 readByType + 内存去重路径
    const lbLimit = Math.min(Math.max(limit, 1), 1000);
    let bestRows: MixedData[] | null = await shard.readLeaderboard(testType, order, lbLimit);

    if (!bestRows) {
      // 回退：DB 不支持 selectLeaderboard 时走旧路径
      const rows = await shard.readByType('score', { subtype: testType, limit: 1000, orderByScore: order });
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
      bestRows = Array.from(bestByUser.values());
      bestRows.sort((a, b) => LOWER_IS_BETTER.has(testType)
        ? (a.score_value ?? Infinity) - (b.score_value ?? Infinity)
        : (b.score_value ?? -Infinity) - (a.score_value ?? -Infinity));
      bestRows = bestRows.slice(0, lbLimit);
    }

    // P2-14: 过滤压测注入的测试账号（testuser/stress/perf/e2e/diag 等），正式环境不展示给用户
    // 用户名需从 payload 解析，故先 flatten 再过滤。
    const TEST_ACCOUNT_RE = /^(test|testuser|verify|stress|stresstest|perf|loadtest|e2e|diag|dummy|benchmark|failcase|placeholder)[_\-\w]*$|realtest/i;
    const body = { data: bestRows.map(flattenScore).filter((s) => {
      const name = (s.username || '').trim();
      return name && !TEST_ACCOUNT_RE.test(name);
    }) };
    try {
      await redis.set(lbCacheKey, body, { ex: 30 });
    } catch (err) {
      console.warn('leaderboard cache write failed:', err);
    }
    return c.json(body);
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

  const testType = str(body.test_type, 40).trim();
  if (!testType || !/^[\w-]{1,40}$/.test(testType)) {
    return c.json({ error: 'invalid test_type' }, 400);
  }

  const scoreValue = num(body.score_value);
  const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};
  // 前端在 payload.leaderboard_eligible 里传该标记（snake_case），
  // 也兼容直接在顶层传 body.leaderboard_eligible 的情况
  if (payload.leaderboard_eligible === false || body.leaderboard_eligible === false) {
    payload.leaderboardEligible = false;
  }

  // ===== 服务端成绩合理性校验（防止构造 HTTP 请求伪造成绩刷榜）=====
  // 分数必须是个有限正数，否则无意义。
  if (scoreValue === null || !Number.isFinite(scoreValue)) {
    return c.json({ error: 'invalid score_value' }, 400);
  }
  // 按测试类型做上下限校验：低于人类物理极限的必然伪造，超上限的必然异常。
  // 此处只给"离群值"收口。range 为 [min, max]。
  const SCORE_BOUNDS: Record<string, [number, number]> = {
    // ms，越低越好；视觉反应生理下限约 100ms，留 80ms 余量防误杀
    reaction: [80, 6000],
    visualsearch: [80, 120000],
    // reaction 类（瞄准按命中单位换算 ms 或分数，宁宽勿窄）
    aim: [1, 1000000],
    // type 输入速度相关
    type: [0.1, 6000],
    // 其余为积分/关数/点数类
    stick: [0, 1000000],
    number: [0, 1000000],
    verbal: [0, 1000000],
    visual: [0, 1000000],
    sequence: [0, 1000000],
    stroop: [0, 1000000],
    nback: [0, 1000000],
  };
  const [minV, maxV] = SCORE_BOUNDS[testType] || [0, 1000000000];
  if (scoreValue < minV || scoreValue > maxV) {
    return c.json({ error: 'score out of range' }, 400);
  }

  // 频率限制：按用户身份限速，防脚本刷榜/刷存储
  if (!(await rateLimit(getRedis(c.env), rlKey('score', userId), 90, 60))) {
    return c.json({ error: 'Too many requests, slow down' }, 429);
  }

  const shard = await buildShardService(c.env);
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'score',
    subtype: testType,
    score_value: scoreValue,
    payload: JSON.stringify({
      username: str(body.username, 60),
      test_type: testType,
      score_value: scoreValue,
      accuracy: num(body.accuracy),
      wpm: num(body.wpm),
      cpm: num(body.cpm),
      // 只保留显式声明的上榜标记，不透传客户端任意键（防批量赋值/字段注入）
      leaderboard_eligible: payload.leaderboardEligible === false ? false : true,
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

  if (!result.ok) return c.json({ error: result.error }, 503);
  const redis = getRedis(c.env);
  try {
    await redis.del(`cache:lb:${testType}`);
    await redis.del('cache:stats');
  } catch (err) {
    console.warn('scores cache invalidate failed:', err);
  }
  return c.json({ success: true });
});

app.delete('/api/scores', async (c) => {
  const userId = c.get('userId');
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id is required' }, 400);
  const shard = await buildShardService(c.env);

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
  const shard = await buildShardService(c.env);
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
  const content = str(body.content, 500).trim();
  if (!content) return c.json({ error: 'content is required' }, 400);
  const category = str(body.category, 30).trim() || 'chat';
  if (!/^[\w-]{1,30}$/.test(category)) return c.json({ error: 'invalid category' }, 400);

  // 频率限制：按用户身份限速，防刷屏/垃圾评论淹没正常内容
  if (!(await rateLimit(getRedis(c.env), rlKey('comment', userId), 12, 60))) {
    return c.json({ error: 'You are commenting too fast' }, 429);
  }

  const shard = await buildShardService(c.env);
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'comment',
    subtype: category,
    score_value: null,
    payload: JSON.stringify({
      username: str(body.username, 60) || userId,
      content,
      category,
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

  if (!result.ok) return c.json({ error: result.error }, 503);
  const redis = getRedis(c.env);
  try {
    await redis.del('cache:stats');
  } catch (err) {
    console.warn('comments cache invalidate failed:', err);
  }
  return c.json({ success: true });
});

// 批量读取多个用户的 profile（排行榜、用户卡片等展示场景）
// 同时兼容：不传 user_ids 时返回当前登录用户自身的 profile
app.get('/api/profiles', async (c) => {
  const userIdsQuery = c.req.query('user_ids');
  const shard = await buildShardService(c.env);
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
    const ids = userIdsQuery.split(',').map(s => s.trim()).filter((s) => s && s.length <= 64).slice(0, 200);
    if (!ids.length) return c.json({ data: [] });
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
  const shard = await buildShardService(c.env);
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
  // 限 profile 体积，防止注入超大 payload 拖垮存储
  const serialized = JSON.stringify(body);
  if (serialized.length > 8192) return c.json({ error: 'profile too large' }, 413);
  const shard = await buildShardService(c.env);

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
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

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
  const shard = await buildShardService(c.env);
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
    }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
    if (!result.ok) return c.json({ success: false, error: result.error }, 503);
  }
  return c.json({ success: true, username: newUsername });
});

// online_users 心跳（轻量级，失败不影响用户体验）
app.post('/api/online_users', async (c) => {
  try {
    const body = await c.req.json<{ user_id?: string; last_seen?: string; on_conflict?: boolean }>();
    const userId = str(body.user_id || c.get('userId'), 64).trim();
    if (!userId) return c.json({ ok: false, error: 'user_id 不能为空' }, 400);
    const lastSeen = str(body.last_seen, 40) || new Date().toISOString();
    const shard = await buildShardService(c.env);
    // 直接写入，不做 read-then-delete（减少 DB 压力）
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
    }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
    if (!result.ok) {
      console.warn('online_users write failed:', result.error);
      // 返回 200 而非 503，避免前端报错
      return c.json({ ok: true, db: 'fallback' });
    }
    return c.json({ ok: true, db: result.db });
  } catch (err) {
    console.error('online_users error:', err);
    return c.json({ ok: true }); // 静默失败
  }
});

// users 表 upsert（syncUser：首次登录/注册时写基础资料）
app.post('/api/users', async (c) => {
  const body = await c.req.json<{ user_id?: string; username?: string; email?: string; on_conflict?: boolean }>();
  const userId = str(body.user_id || c.get('userId'), 64).trim();
  if (!userId) return c.json({ ok: false, error: 'user_id 不能为空' }, 400);
  const shard = await buildShardService(c.env);
  const existing = await shard.readByUserAndType(userId, 'user', 1);
  if (existing.length) return c.json({ ok: true, existed: true });
  const result = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'user',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({
      username: str(body.username, 60),
      email: str(body.email, 120),
    }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 503);
  return c.json({ ok: true, db: result.db });
});

/** 图片魔数嗅探：只允许真正的图片，防止客户端伪造 contentType 上传 HTML/SVG 等可执行内容 */
function sniffImageType(bytes: Uint8Array): string | null {
  const has = (off: number, arr: number[]) => arr.every((b, i) => bytes[off + i] === b);
  if (has(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (has(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (has(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // RIFF....WEBP
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && has(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

app.post('/api/upload', async (c) => {
  const userId = c.get('userId');
  // 限流：防脚本批量灌存储
  if (!(await rateLimit(getRedis(c.env), rlKey('upload', userId), 10, 60))) {
    return c.json({ error: 'Too many uploads, slow down' }, 429);
  }
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'No file uploaded' }, 400);
  // 限制上传体积（5MB），防止超大文件耗尽 Worker/存储资源
  const size = (file as File).size || 0;
  if (!size || size > 5 * 1024 * 1024) return c.json({ error: 'File too large (max 5MB)' }, 413);

  // 只允许图片扩展名，且魔数与声明类型一致，杜绝伪装成图片上传的脚本/HTML 执行载体
  const buf = new Uint8Array(await (file as File).arrayBuffer());
  const sniffed = sniffImageType(buf);
  if (!sniffed) {
    return c.json({ error: 'Only image uploads are allowed (png/jpeg/gif/webp)' }, 400);
  }
  const declared = (file as File).type || '';
  const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  if (!allowedImageTypes.has(declared) || declared !== sniffed) {
    return c.json({ error: 'File type or content does not match an allowed image' }, 400);
  }

  const fileUrl = await uploadFile(c.env, userId, file, sniffed);

  const shard = await buildShardService(c.env);
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
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

  return c.json({ ok: true, url: fileUrl });
});

// ===== 管理后台 =====
// UI 页面（GET /admin），内联返回、无需静态资源；未配置 ADMIN_TOKEN 时仍能打开但登录会失败
app.get('/admin', (c) => c.html(renderAdminUI()));
app.get('/admin/*', (c) => c.html(renderAdminUI()));

function flattenContent(r: MixedData) {
  const p: any = safeJsonParse(r.payload) || {};
  return {
    id: r.id,
    type: r.type,
    subtype: r.subtype,
    user_id: r.user_id,
    username: p.username || p.name || r.user_id,
    content: p.content || p.message || '',
    payload: p,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function flattenAlert(r: MixedData) {
  const p: any = safeJsonParse(r.payload) || {};
  return {
    id: r.id,
    user_id: r.user_id,
    kind: p.kind || r.subtype,
    severity: p.severity || 'info',
    source_ip: p.source_ip || null,
    target: p.target || null,
    message: p.message || '',
    count: p.count != null ? Number(p.count) : (r.score_value != null ? Number(r.score_value) : null),
    detail: p.detail || null,
    resolved: Boolean(p.resolved),
    created_at: r.created_at,
  };
}

function flattenAudit(r: MixedData) {
  const p: any = safeJsonParse(r.payload) || {};
  return { id: r.id, admin: p.admin, action: p.action, target: p.target, detail: p.detail, created_at: r.created_at };
}

/** 管理接口统一入口：校验会话令牌（短期、带 TTL），通过后经 c.set 注入管理员标识供审计复用 */
async function adminGw(c: any, next: any): Promise<Response | void> {
  // 登录与注销端点不走会话校验（它们自己处理口令 + 动态码）
  if (c.req.method === 'POST' && (c.req.path === '/api/admin/login' || c.req.path === '/api/admin/logout')) {
    return next();
  }
  if (!c.env.ADMIN_TOKEN) return c.json({ error: 'admin interface disabled' }, 404 as any);

  // 从 Authorization: Bearer <session> 取会话令牌
  const authHeader = c.req.header('Authorization');
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (!token) return c.json({ error: 'missing bearer token' }, 401 as any);

  const sess = await resolveAdminSession(getRedis(c.env), token);
  if (!sess.ok) return c.json({ error: 'forbidden' }, 403 as any);

  c.set('adminToken', sess.admin);
  c.set('adminSessionIp', sess.ip);
  return next();
}
app.use('/api/admin/*', adminGw);

app.get('/api/admin/ping', async (c) => c.json({ ok: true }));

// ---- 双重验证（2FA）登录：口令 + TOTP 动态码都正确才发放会话令牌 ----
app.post('/api/admin/login', async (c) => {
  const env = c.env as Env;
  if (!env.ADMIN_TOKEN) return c.json({ error: 'admin interface disabled' }, 404 as any);

  const ip = clientIp(c);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const shard = await buildShardService(env);
  const redis = getRedis(env);

  // 1) 该来源已冻结？直接拒绝
  if (await isAdminLocked(redis, ip)) {
    return c.json({ error: 'Too many failed login attempts, temporarily locked', locked: true }, 429 as any);
  }

  const body = await c.req.json().catch(() => ({} as any));
  const password = str(body?.password, 512);
  const code = str(body?.code, 16);

  // 2) 校验口令（第一因素）
  const passOk = verifyAdminPassword(env, password);

  // 3) 校验动态码（第二因素；未配置 TOTP 时自动放行，提示 requiresTotp=false）
  const totp = await verifyAdminTotp(env, code);
  const success = passOk && totp.ok;

  if (!success) {
    // 登录失败：计数 + 审计 + （达到阈值时）冻结 + 告警
    const failCount = await recordAdminLoginFailure(redis, ip);
    writeAudit(shard, waitUntil, passOk ? 'admin#TOTPFAIL' : 'admin#NOPASS', 'admin.login.failed', passOk ? 'totp-mismatch' : 'bad-password', `ip=${ip} retries=${failCount}`);
    if (passOk && !totp.ok) {
      console.warn('admin totp mismatch at ip', ip);
    }
    if (failCount >= ADMIN_FAIL_LOCK_THRESHOLD) {
      await lockAdminSource(redis, ip);
      // 触发安全告警（可选 webhook 外发）
      try {
        const { recordAlert } = await import('./services/security');
        await recordAlert(redis, shard, waitUntil, env, {
          kind: 'admin',
          severity: 'critical',
          source_ip: ip,
          target: 'admin',
          message: `后台登录失败 ${failCount} 次，已临时冻结来源 15 分钟`,
          count: failCount,
          detail: `admin login brute force from ${ip}`,
        });
      } catch (err) {
        console.error('admin lock alert failed:', err);
      }
    }
    return c.json({ error: passOk ? 'Invalid verification code' : 'Invalid password', locked: failCount >= ADMIN_FAIL_LOCK_THRESHOLD }, 401 as any);
  }

  // 4) 成功：清失败计数、发放短期会话令牌
  await clearAdminFailures(redis, ip);
  const ttlSec = adminSessionTtl(env);
  const session = await createAdminSession(redis, `admin#${String(env.ADMIN_TOKEN).slice(-6)}`, ip, ttlSec);
  writeAudit(shard, waitUntil, `admin#${String(env.ADMIN_TOKEN).slice(-6)}`, 'admin.login.success', ip, `session_ttl=${ttlSec}s`);

  return c.json({ ok: true, session, expires_in: ttlSec, totp_enabled: totp.requiresTotp });
});

// 注销：删除会话令牌
app.post('/api/admin/logout', async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (token) await revokeAdminSession(getRedis(c.env), token);
  return c.json({ ok: true });
});

// TOTP 绑定信息（供首次配置验证器使用）：需先用口令换到的会话令牌访问
app.get('/api/admin/2fa', async (c) => {
  const env = c.env as Env;
  const uri = adminOtpauthUri(env);
  if (!uri) return c.json({ enabled: false, message: 'TOTP 未启用（未配置 ADMIN_TOTP_SECRET）' });
  return c.json({ enabled: true, otpauth: uri, secret: env.ADMIN_TOTP_SECRET, issuer: 'APEXON Admin' });
});

app.get('/api/admin/overview', async (c) => {
  const shard = await buildShardService(c.env);
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const now = Date.now();
  const [totalTests, totalComments, feedbackCount, onlineRecords, totalUsers, openAl] = await Promise.all([
    shard.countByType('score'),
    shard.countByType('comment'),
    shard.countByType('feedback'),
    shard.readByType('online', { limit: 1000 }),
    shard.countByType('account'),
    countOpenAlerts(shard),
  ]);
  let online = 0;
  for (const r of onlineRecords) {
    const payload: any = safeJsonParse(r.payload);
    const lastSeen = (payload && payload.last_seen) || r.updated_at || r.created_at;
    if (lastSeen) {
      const ts = new Date(String(lastSeen)).getTime();
      if (!isNaN(ts) && now - ts <= FIVE_MIN_MS) online += 1;
    }
  }
  const dbs = await Promise.all(
    shard.getDbs().map(async (db) => {
      try {
        const used = await shard.getUsedBytes(db.name);
        return { name: db.name, used_bytes: used, max_bytes: db.maxBytes, healthy: used < db.maxBytes };
      } catch (err) {
        return { name: db.name, used_bytes: 0, max_bytes: db.maxBytes, healthy: false, error: String(err) };
      }
    })
  );
  return c.json({ success: true, data: { online, total_users: totalUsers, total_tests: totalTests, total_comments: totalComments, feedback: feedbackCount, open_alerts: openAl, dbs } });
});

app.get('/api/admin/users', async (c) => {
  const q = str(c.req.query('q'), 100);
  const limit = Number(c.req.query('limit') || 300);
  const shard = await buildShardService(c.env);
  const rows = await searchAccounts(shard, q, limit);
  return c.json({ data: rows.map(flattenAccount) });
});

app.get('/api/admin/users/:userId', async (c) => {
  const shard = await buildShardService(c.env);
  const detail = await getUserDetail(shard, c.req.param('userId'));
  return c.json({ data: detail });
});

app.delete('/api/admin/users/:userId', async (c) => {
  const shard = await buildShardService(c.env);
  const userId = c.req.param('userId');
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const types = ['account', 'profile', 'score', 'comment', 'feedback', 'online', 'user', 'file'];
  for (const t of types) {
    const rows = await shard.readByUserAndType(userId, t, 1000);
    for (const row of rows) {
      await shard.deleteById(row.id);
    }
  }
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'user.delete', userId);
  return c.json({ success: true });
});

async function setBan(c: any, banned: boolean) {
  const shard = await buildShardService(c.env);
  const userId = c.req.param('userId');
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const account = (await shard.readByUserAndType(userId, 'account', 10))[0];
  if (!account) return c.json({ success: false, error: '账号不存在' }, 404) as any;

  const payload: any = safeJsonParse(account.payload) || {};
  payload.banned = banned;
  if (banned) {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const reason = str((body as { reason?: unknown }).reason, 300).trim();
    payload.banned_reason = reason || '管理员封禁';
  } else {
    delete payload.banned_reason;
  }

  const writeResult = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'account',
    subtype: null,
    score_value: null,
    payload: JSON.stringify(payload),
    file_url: null,
    created_at: account.created_at,
    updated_at: new Date().toISOString(),
  }, { waitUntil });
  if (!writeResult.ok) return c.json({ success: false, error: writeResult.error }, 503) as any;
  await shard.deleteById(account.id);
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', banned ? 'user.ban' : 'user.unban', userId, payload.banned_reason || null);
  return c.json({ success: true, banned });
}

app.post('/api/admin/users/:userId/ban', async (c) => setBan(c, true));
app.post('/api/admin/users/:userId/unban', async (c) => setBan(c, false));

app.get('/api/admin/content', async (c) => {
  const type = str(c.req.query('type'), 40).trim() || 'comment';
  const allowed = new Set(['comment', 'feedback', 'score', 'profile']);
  if (!allowed.has(type)) return c.json({ error: 'invalid type' }, 400);
  const q = str(c.req.query('q'), 200);
  const limit = Number(c.req.query('limit') || 200);
  const shard = await buildShardService(c.env);
  const rows = await listContent(shard, type, q, limit);
  return c.json({ data: rows.map(flattenContent) });
});

app.get('/api/admin/content/:id', async (c) => {
  const shard = await buildShardService(c.env);
  const row = await shard.readById(c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ data: flattenContent(row) });
});

app.delete('/api/admin/content/:id', async (c) => {
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const row = await shard.readById(c.req.param('id'));
  await shard.deleteById(c.req.param('id'));
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'content.delete', c.req.param('id'), row ? row.type : undefined);
  return c.json({ success: true });
});

app.get('/api/admin/alerts', async (c) => {
  const status = str(c.req.query('status'), 20).trim() || 'open';
  const q = str(c.req.query('q'), 200);
  const limit = Number(c.req.query('limit') || 300);
  const shard = await buildShardService(c.env);
  const rows = await shard.readByType('alert', { limit: 1000 });
  const needle = q.trim().toLowerCase();
  const filtered = rows
    .map(flattenAlert)
    .filter((a) => {
      if (status === 'open' && a.resolved) return false;
      if (status === 'resolved' && !a.resolved) return false;
      if (needle) {
        const hay = `${a.message} ${a.kind} ${a.source_ip || ''} ${a.target || ''}`.toLowerCase();
        return hay.includes(needle);
      }
      return true;
    });
  return c.json({ data: filtered.slice(0, Math.min(Math.max(Number.isFinite(limit) ? limit : 300, 1), 1000)) });
});

app.patch('/api/admin/alerts/:id', async (c) => {
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const id = c.req.param('id');
  const row = await shard.readById(id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { resolved?: boolean };
  const payload: any = safeJsonParse(row.payload) || {};
  payload.resolved = body.resolved !== false;
  payload.resolved_at = new Date().toISOString();
  const writeResult = await shard.write({ ...row, id: uuid(), payload: JSON.stringify(payload), updated_at: new Date().toISOString() }, { waitUntil });
  if (!writeResult.ok) return c.json({ success: false, error: writeResult.error }, 503);
  await shard.deleteById(id);
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'alert.resolve', id);
  return c.json({ success: true });
});

app.delete('/api/admin/alerts/:id', async (c) => {
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const id = c.req.param('id');
  await shard.deleteById(id);
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'alert.delete', id);
  return c.json({ success: true });
});

app.get('/api/admin/audit', async (c) => {
  const limit = Number(c.req.query('limit') || 200);
  const shard = await buildShardService(c.env);
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 200, 1), 1000);
  const rows = await shard.readByType('audit', { limit: safeLimit });
  return c.json({ data: rows.map(flattenAudit) });
});

// ===== 全局 404 与内部错误兜底（修复 4xx/5xx 大量堆积）=====
// - 不存在的路由统一返回结构化 JSON 404，避免无效路径进数据库/耗 CPU
// - 未捕获的接口异常统一记录日志并返回 500，杜绝 Worker 静默崩溃
app.notFound((c) => {
  return c.json({ success: false, error: 'Not found', path: c.req.path }, 404);
});
app.onError((err, c) => {
  console.error(`[onError] ${c.req.method} ${c.req.path}`, err instanceof Error ? err.message : String(err));
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

export default app;
