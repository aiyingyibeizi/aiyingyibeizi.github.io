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
import { isBlocked, recordLoginFailure, recordRegisterSpike, countOpenAlerts, userFailCount, accountRisk, recordAlert } from './services/security';
import { writeAudit, searchAccounts, getUserDetail, flattenAccount, listContent } from './services/admin';
import { verifyAdminPassword, verifyAdminTotp, adminOtpauthUri, adminSessionTtl, recordAdminLoginFailure, isAdminLocked, lockAdminSource, clearAdminFailures, createAdminSession, resolveAdminSession, revokeAdminSession, ADMIN_FAIL_LOCK_THRESHOLD } from './services/admin';
import { sendNotify } from './services/notify';
import { toCsv, csvDownload, csvFilename } from './services/export';
import { emailConfig, sendMail } from './services/email';
import { renderAdminUI } from './services/admin-ui';
import { parseCsv } from './services/csv';
import { issueCaptcha, verifyCaptcha, countIpFailure, isIpBlacklisted, blacklistIp, ipBlacklistCount, clearIpBlacklist } from './services/captcha';
import { checkScoreAnomaly } from './services/anomaly';
import { analyzeContent } from './services/spam';
import { createSnapshot, listSnapshots, getSnapshot } from './services/snapshot';
import { sampleRequest, reportError } from './services/observability';
import { setSubscription, readMySubscription, subscribersForType, sendPublishNotification, flattenSubscription } from './services/subscribe';
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

// 成绩合理性上下限（按测试类型收口离群值，min/max）
const SCORE_BOUNDS: Record<string, [number, number]> = {
  reaction: [80, 6000],
  visualsearch: [80, 120000],
  aim: [1, 1000000],
  type: [0.1, 6000],
  stick: [0, 1000000],
  number: [0, 1000000],
  verbal: [0, 1000000],
  visual: [0, 1000000],
  sequence: [0, 1000000],
  stroop: [0, 1000000],
  nback: [0, 1000000],
};
function scoreInBounds(testType: string, v: number): boolean {
  const [minV, maxV] = SCORE_BOUNDS[testType] || [0, 1000000000];
  return v >= minV && v <= maxV;
}
function scoreLowerIsBetter(testType: string): boolean {
  return LOWER_IS_BETTER.has(testType);
}

// ---------------------------------------------------------------------------
// 邮箱验证码辅助（Redis 存储，短期 TTL；全部 fail-open）
// ---------------------------------------------------------------------------
const MAIL_CODE_PREFIX = 'mailver:code:';
const MAIL_CODE_TTL_SEC = 10 * 60;

function mailKey(email: string): string {
  return MAIL_CODE_PREFIX + email.replace(/[^a-z0-9@._+-]/gi, '_').slice(0, 120);
}

/** 天级计数器（key 含日期并按 2 天 TTL 过期），返回当日最新计数值；Redis 异常返回 0（不阻断） */
async function mailDayCount(redis: Redis, namespace: string, value: string): Promise<number> {
  const k = `day:${namespace}:${value}:${new Date().toISOString().slice(0, 10)}`;
  try {
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 2 * 24 * 60 * 60);
    return n;
  } catch (err) {
    console.error('mailDayCount failed:', err);
    return 0;
  }
}

/** 生成 6 位数字验证码并写入 Redis（带 TTL）；Redis 异常返回 null（调用方视为生成失败） */
async function issueMailCode(redis: Redis, email: string): Promise<string | null> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await redis.set(mailKey(email), code, { ex: MAIL_CODE_TTL_SEC });
    return code;
  } catch (err) {
    console.error('issueMailCode failed:', err);
    return null;
  }
}

/** 校验验证码：命中则删除（一次性），防止同一验证码被反复使用 */
async function verifyMailCode(redis: Redis, email: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const expect = await redis.get<string>(mailKey(email));
    if (!expect) return false;
    if (expect !== code) return false;
    await redis.del(mailKey(email));
    return true;
  } catch (err) {
    console.error('verifyMailCode failed:', err);
    return false;
  }
}

/** 校验邮箱格式（宽松：local@domain.tld） */
function isValidEmail(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const e = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;
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

type Variables = { userId: string; adminToken?: string; adminSessionIp?: string };
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
  const __start = Date.now();
  await next();
  // 采样访问日志（需 OBSERVABILITY_SAMPLE > 0，默认关闭）
  const envSample = (c.env as Env).OBSERVABILITY_SAMPLE;
  if (Number(envSample) > 0) {
    sampleRequest({
      method: c.req.method,
      path: c.req.path,
      status: c.res ? c.res.status : 0,
      durationMs: Date.now() - __start,
      sample: Number(envSample),
      ip: clientIp(c),
      ua: c.req.header('User-Agent'),
    });
  }
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
  const env = c.env as Env;
  const body = await c.req.json<{ username?: string; password?: string; captcha_id?: string; captcha_answer?: string }>().catch((): { username?: string; password?: string; captcha_id?: string; captcha_answer?: string } => ({}));
  const username = str(body.username, 30);
  const password = str(body.password, 512);
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);
  if (username.length < 2 || username.length > 30) return c.json({ error: 'Username must be 2-30 characters' }, 400);
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return c.json({ error: 'Password must be at least 8 characters and contain both letters and numbers' }, 400);

  const ip = clientIp(c);
  const redis = getRedis(env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);

  // 累积式 IP 黑名单：命中直接拒绝登录（正常用户不误伤，触及该名单的基本可判定为脚本）
  if (await isIpBlacklisted(redis, ip)) {
    return c.json({ error: 'Too many attempts, IP temporarily blocked', locked: true }, 429);
  }

  // 频率限制：同时按 IP 和账号名限速，兼顾封堵脚本与防止对单一账号打爆。
  // 限制统一走 before 响应，两次校验用同一把计数，避免重复消耗 Redis 调用。
  const ipOk = await rateLimit(redis, rlKey('login-ip', ip), 30, 60);
  const userOk = await rateLimit(redis, rlKey('login-user', username), 10, 60);
  if (!ipOk || !userOk) return c.json({ error: 'Too many attempts, please try again later' }, 429);

  // 暴破封锁：登录前先查是否因失败次数过多被临时冻结（成功则正常放行，不影响既有流程）。
  // 只冻结「IP」与本请求所属「IP+账号」组合，绝不因匿名错误尝试冻结裸用户名，
  // 防止未认证攻击者对任意账号远程触发封锁(DoS)。
  const srcLock = await isBlocked(redis, 'user', ip + ':' + username);
  if (await isBlocked(redis, 'ip', ip) || srcLock) {
    return c.json({ error: 'Too many attempts, account temporarily locked' }, 429);
  }

  // 算数验证码：平时无感（不要求），可疑来源（累计失败 >= 阈值）或强制开启时要求。
  const requireCaptcha = env.CAPTCHA_ALWAYS === 'on' ||
    (await ipBlacklistCount(redis, ip)) >= (Number(env.CAPTCHA_REQUIRE_AFTER_FAIL) || 3);
  if (requireCaptcha) {
    const capOk = await verifyCaptcha(redis, str(body.captcha_id, 64), str(body.captcha_answer, 16));
    if (!capOk) {
      // 未通过：即使答案是空的也返回统一校验失败，避免这边枚举「是否首次尝试」的差异。
      const fresh = await issueCaptcha(redis);
      return c.json({
        error: 'Invalid CAPTCHA, please retry',
        captcha_required: true,
        captcha_question: fresh ? fresh.question : undefined,
        captcha_id: fresh ? fresh.id : undefined,
      }, 400);
    }
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
    recordCumulativeIpFailure(c);
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const payload = JSON.parse(account.payload);

  // 封禁账号拒绝登录；错误文案与"密码错误"保持一致，避免暴露账号是否存在/是否被封
  if (payload.banned === true) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const passwordHash = payload.password_hash;

  // 后端验证密码：旧版明文密码登录成功后自动迁移为新哈希格式。
  const passwordValid = await verifyPassword(password, passwordHash);
  if (!passwordValid) {
    logLoginFailure(c, username, true);
    recordCumulativeIpFailure(c);
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  // 旧明文 / 旧算法(sha256) / 低迭代 → 登录成功后统一重哈希到最强参数（PBKDF2-SHA512/600k）
  if (isLegacyPassword(passwordHash) || needsRehash(passwordHash)) {
    payload.password_hash = await hashPassword(password);
  }

  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const loginIp = clientIp(c);
  const prevLoginIp = typeof payload.last_login_ip === 'string' ? payload.last_login_ip : '';

  payload.session_token = sessionToken;
  payload.session_expires_at = expiresAt;
  payload.last_login_ip = loginIp;

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

  // 异地登录提醒：来源 IP 变化且配置了通知渠道时推送（可选开关 GEO_DIFF_LOGIN_NOTIFY='off' 关闭）
  const env2 = c.env as Env;
  if (prevLoginIp && prevLoginIp !== loginIp && env2.ADMIN_ALERT_WEBHOOK && env2.GEO_DIFF_LOGIN_NOTIFY !== 'off') {
    sendNotify(env2.ADMIN_ALERT_WEBHOOK, {
      title: 'APEXON · 异地登录提醒',
      theme: 'orange',
      lines: [
        { label: '账号', value: account.user_id },
        { label: '新 IP', value: loginIp },
        { label: '此前 IP', value: prevLoginIp },
      ],
    }, c.executionCtx.waitUntil.bind(c.executionCtx));
  }

  return c.json({ user_id: account.user_id, username, token: sessionToken, expires_at: expiresAt });
});

// ---------------------------------------------------------------------------
// 邮箱验证码登录/注册（供应商无关，见 services/email.ts）。未配置 MAIL_API_KEY 时禁用。
// 注意：这些路由必须在 app.use('/api/*') 的鉴权中间件之前注册，保持公开。
// ---------------------------------------------------------------------------

// ① 发送验证码到邮箱
app.post('/api/auth/send-code', async (c) => {
  const env = c.env as Env;
  const cfg = emailConfig(env);
  if (!cfg) return c.json({ error: 'email not configured' }, 503);

  const body = await c.req.json<{ email?: unknown }>().catch((): { email?: unknown } => ({}));
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) return c.json({ error: 'Invalid email' }, 400);

  // 频率限制：按邮箱与 IP 双重限速（60 秒内限 2 次发码）
  const redis = getRedis(env);
  const ip = clientIp(c);
  const okMail = await rateLimit(redis, rlKey('mailcode-mail', email), 2, 60);
  const okIp = await rateLimit(redis, rlKey('mailcode-ip', ip), 10, 60);
  if (!okMail || !okIp) return c.json({ error: 'Too many attempts, please try again later' }, 429);

  // 邮件额度防刷防火墙（天级）：单邮箱 / 单 IP 每日发码上限，防止单点打穿厂商免费额度。
  const capMail = Number(env.MAIL_DAILY_PER_EMAIL) || 5;
  const capIp = Number(env.MAIL_DAILY_PER_IP) || 30;
  if (capMail > 0 && (await mailDayCount(redis, 'mail', email)) > capMail) {
    return c.json({ error: 'Daily verification-code limit reached for this email, please try again tomorrow' }, 429);
  }
  if (capIp > 0 && (await mailDayCount(redis, 'mailip', ip)) > capIp) {
    return c.json({ error: 'Daily verification-code limit reached, please try again tomorrow' }, 429);
  }

  const code = await issueMailCode(redis, email);
  if (!code) return c.json({ error: 'Internal error (code issue)' }, 500);

  const text = ['【APEXON】您的验证码', `验证码：${code}`, '10 分钟内有效，请勿泄露给他人。若非本人操作请忽略本邮件。'].join('\n');
  const html = `<div style="background:#eef0fb;padding:28px 16px;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,Verdana,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e4e6f2;box-shadow:0 12px 40px rgba(76,93,255,.10);">
    <div style="background:linear-gradient(135deg,#4f6bff 0%,#8b5cf6 100%);padding:26px 28px;">
      <div style="font-size:15px;font-weight:700;color:#ffffff;letter-spacing:.5px;">⚡ APEXON</div>
      <div style="font-size:22px;font-weight:700;color:#ffffff;margin-top:4px;">邮箱验证码</div>
    </div>
    <div style="padding:26px 28px 30px;">
      <p style="margin:0 0 6px;font-size:15px;color:#1a2140;line-height:1.6;">你好，</p>
      <p style="margin:0 0 18px;font-size:14px;color:#5a6286;line-height:1.7;">你正在进行登录 / 注册操作，以下是本次验证码：</p>
      <div style="background:#f6f7ff;border:1.5px dashed #9aa7ff;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;">
        <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#4f6bff;">${code}</div>
      </div>
      <p style="margin:0 0 6px;font-size:13px;color:#7a82a8;line-height:1.7;">· 验证码 <b style="color:#4f6bff">10 分钟</b> 内有效 · 一次性使用<br>· 请勿将验证码告知他人，谨防诈骗</p>
    </div>
    <div style="padding:16px 28px;background:#fafbff;border-top:1px solid #eef0fb;">
      <p style="margin:0;font-size:12px;color:#a0a6c4;line-height:1.6;">如果你没有进行上述操作，可以忽略这封邮件。<br>APEXON · 免费在线认知能力测试平台</p>
    </div>
  </div>
</div>`;

  const sent = await sendMail(cfg, email, 'APEXON 验证码', html, text);
  if (!sent.ok) {
    // 发送失败：清除刚生成的验证码，避免残留误用
    await redis.del(mailKey(email)).catch(() => {});
    const detail = sent.detail || (sent.status ? `HTTP ${sent.status}` : 'unknown');
    return c.json({ error: 'email send failed, please retry', detail: `${sent.provider || ''}: ${detail}`.trim() }, 502);
  }
  return c.json({ ok: true, expires_in: MAIL_CODE_TTL_SEC });
});

// ② 邮箱注册：username + email + 验证码
app.post('/api/auth/email-register', async (c) => {
  const env = c.env as Env;
  const cfg = emailConfig(env);
  if (!cfg) return c.json({ error: 'email not configured' }, 503);

  const body = await c.req.json<{ username?: unknown; email?: unknown; code?: unknown }>().catch((): { username?: unknown; email?: unknown; code?: unknown } => ({}));
  const username = str(body.username, 30).trim();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = str(body.code, 6).trim();

  if (username.length < 2 || username.length > 30) return c.json({ error: 'Username must be 2-30 characters' }, 400);
  if (!isValidEmail(email)) return c.json({ error: 'Invalid email' }, 400);

  const redis = getRedis(env);

  // 先查唯一性，再校验验证码：避免"邮箱已注册"等 409 时把一次性验证码消耗掉，
  // 否则用户无法用同一验证码切换去登录。账号唯一性经 /register 本就可探测，无新增泄露。
  const shard = await buildShardService(env);
  const existing = await shard.readByType('account', { limit: 1000 });
  for (const r of existing) {
    let p: any;
    try { p = JSON.parse(r.payload); } catch { continue; }
    if (p.username === username) return c.json({ error: 'Username already exists' }, 409);
    if (String(p.email || '').toLowerCase() === email) return c.json({ error: 'Email already registered, please login' }, 409);
  }

  // 限速（含验证码校验前的防刷）
  if (!(await rateLimit(redis, rlKey('emailreg', clientIp(c)), 5, 60))) {
    return c.json({ error: 'Too many attempts, please try again later' }, 429);
  }
  if (!(await verifyMailCode(redis, email, code))) return c.json({ error: 'Invalid or expired verification code' }, 400);

  const userId = uuid();
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const createdAt = new Date().toISOString();

  const writeResult = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'account',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({ username, email, email_verified: true, session_token: sessionToken, session_expires_at: expiresAt, last_login_ip: clientIp(c) }),
    file_url: null,
    created_at: createdAt,
    updated_at: createdAt,
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  if (!writeResult.ok) return c.json({ error: writeResult.error }, 503);

  await cacheSession(redis, sessionToken, userId, expiresAt);
  return c.json({ user_id: userId, username, token: sessionToken, expires_at: expiresAt });
});

// ③ 邮箱登录：email + 验证码（无需密码）
app.post('/api/auth/email-login', async (c) => {
  const env = c.env as Env;
  const cfg = emailConfig(env);
  if (!cfg) return c.json({ error: 'email not configured' }, 503);

  const body = await c.req.json<{ email?: unknown; code?: unknown }>().catch((): { email?: unknown; code?: unknown } => ({}));
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = str(body.code, 6).trim();
  if (!isValidEmail(email)) return c.json({ error: 'Invalid email' }, 400);

  const redis = getRedis(env);
  // email-login 此前缺失频率限制：验证码虽为一次性且 10 分钟有效，仍须按 IP 与邮箱限速，
  // 防止脚本对同一来源狂刷校验码、或对单一邮箱持续爆破验证码。
  const ip = clientIp(c);
  if (!(await rateLimit(redis, rlKey('emaillogin-ip', ip), 30, 60)) ||
      !(await rateLimit(redis, rlKey('emaillogin-mail', email), 15, 60))) {
    return c.json({ error: 'Too many attempts, please try again later' }, 429);
  }
  // 先查账号，再校验验证码：避免首次登录(无账号)时把一次性验证码消耗掉，
  // 否则前端无法用同一验证码回退去注册。存在性本身经 /email-login|/register 已可探测，无新增泄露。
  const shard = await buildShardService(env);
  const accounts = await shard.readByType('account', { limit: 1000 });
  const account = accounts.find((r) => {
    try { return String(JSON.parse(r.payload).email || '').toLowerCase() === email; } catch { return false; }
  });
  if (!account) return c.json({ error: 'No account with this email' }, 404);
  if (!(await verifyMailCode(redis, email, code))) return c.json({ error: 'Invalid or expired verification code' }, 400);
  const payload: any = JSON.parse(account.payload);
  if (payload.banned === true) return c.json({ error: 'No account with this email' }, 404);

  const prevIp = typeof payload.last_login_ip === 'string' ? payload.last_login_ip : '';
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  payload.session_token = sessionToken;
  payload.session_expires_at = expiresAt;
  payload.last_login_ip = ip;

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

  await cacheSession(redis, sessionToken, account.user_id, expiresAt);

  // 异地登录提醒：IP 变化且有通知渠道时推送
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  if (prevIp && prevIp !== ip && env.ADMIN_ALERT_WEBHOOK && env.GEO_DIFF_LOGIN_NOTIFY !== 'off') {
    sendNotify(env.ADMIN_ALERT_WEBHOOK, {
      title: 'APEXON · 异地登录提醒',
      theme: 'orange',
      lines: [
        { label: '账号', value: account.user_id },
        { label: '新 IP', value: ip },
        { label: '此前 IP', value: prevIp },
      ],
    }, waitUntil);
  }

  return c.json({ user_id: account.user_id, username: payload.username || account.user_id, token: sessionToken, expires_at: expiresAt });
});

app.post('/api/auth/merge-anon', createAuthMiddleware(buildShardService, getRedis), async (c) => {
  const userId = c.get('userId');
  const { anon_id } = await c.req.json<{ anon_id?: string }>();
  if (!anon_id || !anon_id.startsWith('anon_')) return c.json({ error: 'Invalid anon_id' }, 400);

  const shard = await buildShardService(c.env);
  const anonScores = await shard.readByUserAndType(anon_id, 'score', 1000);
  for (const row of anonScores) {
    // 保留原始 score 的 id：重复合并同一匿名账号时，tursoInsert 的 ON CONFLICT(id) DO NOTHING
    // 会幂等跳过，避免重复叠加同一成绩（此前每次都新生成 uuid 导致重复合并会翻倍）。
    await shard.write({ ...row, user_id: userId, updated_at: new Date().toISOString() }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
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
// 下发一道算数验证码挑战（公开）。供登录前需要验证码时调用；能力缺失时返回 disabled。
// 注意：必须在 app.use('/api/*', authOrAdmin) 之前注册，保持公开。
app.get('/api/auth/captcha', async (c) => {
  const challenge = await issueCaptcha(getRedis(c.env));
  if (!challenge) return c.json({ enabled: false });
  return c.json({ enabled: true, ...challenge });
});

app.use('/api/*', authOrAdmin);

/** 登录失败时同步累计 IP 失败次数；达到阈值则拉黑该 IP（fire-and-forget，不拖慢响应） */
function recordCumulativeIpFailure(c: { env: Env; executionCtx: any; req: { header: (n: string) => string | undefined } }): void {
  try {
    const env = c.env as Env;
    const threshold = Number(env.IP_BLACKLIST_THRESHOLD) || 20;
    const windowSec = Number(env.IP_BLACKLIST_WINDOW_SEC) || 3600;
    const durationSec = Number(env.IP_BLACKLIST_DURATION_SEC) || 86400;
    const ip = clientIp(c);
    const task = (async () => {
      const redis = getRedis(env);
      const n = await countIpFailure(redis, ip, windowSec);
      if (n >= threshold) {
        await blacklistIp(redis, ip, durationSec);
        console.warn(`IP blacklisted (${n} failures): ${ip}`);
      }
    })();
    task.catch((err) => console.error('recordCumulativeIpFailure error:', err));
    try { c.executionCtx.waitUntil(task); } catch { /* ignore */ }
  } catch (err) {
    console.error('recordCumulativeIpFailure outer error:', err);
  }
}

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
          // 同时识别 snake_case（写入规范）与历史上可能存在的 camelCase 两种标记
          return payload.leaderboard_eligible !== false && payload.leaderboardEligible !== false;
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
  // 按测试类型做上下限校验：低于人类物理极限的必然伪造，超上限的必然异常（复用模块级收口）。
  if (scoreValue < 0 || !scoreInBounds(testType, scoreValue)) {
    return c.json({ error: 'score out of range' }, 400);
  }

  // 频率限制：按用户身份限速，防脚本刷榜/刷存储
  if (!(await rateLimit(getRedis(c.env), rlKey('score', userId), 90, 60))) {
    return c.json({ error: 'Too many requests, slow down' }, 429);
  }

  const shard = await buildShardService(c.env);

  // 防刷分：运行异常检测（高频连发 / 相对历史最佳异常提升）。命中 → 标记 suspicious 且默认不上榜，
  // 管理员可在"异常成绩"面板复核，用户也可对标记成绩发起申诉。
  const anomaly = await checkScoreAnomaly(getRedis(c.env), shard, userId, testType, scoreValue, scoreLowerIsBetter(testType));

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
      leaderboard_eligible: payload.leaderboardEligible === false ? false : !anomaly.flagged,
      // 异常检测结果
      validity: anomaly.flagged ? 'suspicious' : 'valid',
      flag_reason: anomaly.flagged ? anomaly.flagReason || null : null,
      flagged: anomaly.flagged,
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
  // 若命中可疑：给用户一个温和提示（不做硬性拒绝，避免误杀真实成绩）。
  return c.json({ success: true, flagged: anomaly.flagged });
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

// 个人成绩趋势（C1）：当前登录用户自己的成绩按时间升序序列，供前端画趋势图
app.get('/api/scores/trend', async (c) => {
  const userId = c.get('userId');
  const testType = str(c.req.query('test_type'), 40).trim();
  const limit = Number(c.req.query('limit') || 100);
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);
  const shard = await buildShardService(c.env);
  const options: { userId: string; subtype?: string; limit: number } = { userId, limit: 1000 };
  if (testType) options.subtype = testType;
  const rows = await shard.readByType('score', options);
  // 按创建时间升序（时间轴从左到右）
  rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const series = rows.slice(-safeLimit).map((r) => {
    const p: any = safeJsonParse(r.payload) || {};
    return {
      id: r.id,
      subtype: r.subtype || p.test_type || '',
      score_value: r.score_value,
      accuracy: p.accuracy != null ? Number(p.accuracy) : null,
      wpm: p.wpm != null ? Number(p.wpm) : null,
      cpm: p.cpm != null ? Number(p.cpm) : null,
      created_at: r.created_at,
    };
  });
  return c.json({ data: { test_type: testType || null, limit: safeLimit, series } });
});

// 用户导出自已成绩（C2）：当前登录用户，按 test_type 可选，返回 CSV 下载
app.get('/api/export/my-scores', async (c) => {
  const userId = c.get('userId');
  const testType = str(c.req.query('test_type'), 40).trim();
  const shard = await buildShardService(c.env);
  const options: { userId: string; subtype?: string; limit: number } = { userId, limit: 1000 };
  if (testType) options.subtype = testType;
  const rows = await shard.readByType('score', options);
  rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const headers = ['test_type', 'score_value', 'accuracy', 'wpm', 'cpm', 'created_at'];
  const body = rows.map((r) => {
    const p: any = safeJsonParse(r.payload) || {};
    return [
      r.subtype || p.test_type || '',
      r.score_value ?? '',
      p.accuracy != null ? Number(p.accuracy) : '',
      p.wpm != null ? Number(p.wpm) : '',
      p.cpm != null ? Number(p.cpm) : '',
      r.created_at,
    ];
  });
  const filename = csvFilename(testType ? `scores-${testType}` : 'my-scores');
  return csvDownload(toCsv(headers, body), filename);
});

// ===== 成绩发布订阅（C 端）=====
// 订阅「某类测试 / 全部」的成绩发布邮箱提醒。email 未传时回退账号绑定的邮箱。
app.post('/api/subscriptions', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ email?: unknown; test_type?: unknown; enabled?: unknown }>().catch((): { email?: unknown; test_type?: unknown; enabled?: unknown } => ({}));
  const testType = str(body.test_type, 40).trim();
  const enabled = body.enabled !== false;
  const rl = await rateLimit(getRedis(c.env), rlKey('sub', userId), 10, 60);
  if (!rl) return c.json({ error: 'Too many requests, slow down' }, 429);

  const shard = await buildShardService(c.env);
  // 邮箱：优先用请求里带的；否则回退账号绑定的邮箱。
  let email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email && !isValidEmail(email)) return c.json({ error: 'Invalid email' }, 400);
  if (!email) {
    const acc = (await shard.readByUserAndType(userId, 'account', 10))[0];
    if (acc) {
      const p: any = safeJsonParse(acc.payload) || {};
      if (typeof p.email === 'string') email = p.email;
    }
  }
  if (!email) return c.json({ error: '需要有效的收件邮箱' }, 400);

  const r = await setSubscription(shard, userId, email, testType, enabled);
  if (!r.ok) return c.json({ error: r.error }, 503);
  return c.json({ success: true });
});

// 查看自己的订阅设置
app.get('/api/me/subscriptions', async (c) => {
  const shard = await buildShardService(c.env);
  const sub = await readMySubscription(shard, c.get('userId'));
  return c.json({ data: sub });
});

// ===== 成绩申诉（C 端）=====
// 用户对自己被标记的成绩发起申诉；管理员在后台复核。
app.post('/api/scores/:id/appeal', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json<{ reason?: unknown }>().catch((): { reason?: unknown } => ({}));
  const reason = str(body.reason, 500).trim();
  if (reason.length < 5) return c.json({ error: '申诉理由至少 5 个字' }, 400);
  if (!(await rateLimit(getRedis(c.env), rlKey('appeal', userId), 5, 60))) {
    return c.json({ error: 'Too many requests, slow down' }, 429);
  }

  const shard = await buildShardService(c.env);
  const score = await shard.readById(id);
  if (!score || score.type !== 'score') return c.json({ error: '记录不存在' }, 404);
  if (score.user_id !== userId) return c.json({ error: 'Forbidden' }, 403);
  const p: any = safeJsonParse(score.payload) || {};

  // 只允许对"被判可疑/无效"的成绩申诉
  if (p.validity === 'valid') return c.json({ error: '该成绩状态正常，无需申诉' }, 409);
  // 已存在的未处理申诉 → 拒绝重复提交
  const existingAppeals = await shard.readByUserAndType(userId, 'appeal', 50);
  const open = existingAppeals.find((a) => {
    const ap: any = safeJsonParse(a.payload) || {};
    return ap.score_id === id && ap.status === 'open';
  });
  if (open) return c.json({ error: '已有处理中的申诉' }, 409);

  const now = new Date().toISOString();
  const w = await shard.write({
    id: uuid(),
    user_id: userId,
    type: 'appeal',
    subtype: score.subtype,
    score_value: score.score_value,
    payload: JSON.stringify({
      score_id: id,
      test_type: score.subtype || p.test_type || '',
      score_value: score.score_value,
      reason,
      status: 'open',
      created_at: now,
      updated_at: now,
      resolved_by: null,
      admin_note: null,
    }),
    file_url: null,
    created_at: now,
    updated_at: now,
  }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  if (!w.ok) return c.json({ error: w.error }, 503);
  // 提醒管理员
  sendNotify(c.env.ADMIN_ALERT_WEBHOOK, {
    title: 'APEXON · 成绩申诉',
    theme: 'blue',
    lines: [
      { label: '用户', value: userId },
      { label: '题目', value: score.subtype || p.test_type || '-' },
      { label: '分数', value: score.score_value != null ? String(score.score_value) : '-' },
      { label: '理由', value: reason },
    ],
  }, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.json({ success: true });
});

// 查看自己的申诉记录
app.get('/api/my-appeals', async (c) => {
  const userId = c.get('userId');
  const shard = await buildShardService(c.env);
  const rows = await shard.readByUserAndType(userId, 'appeal', 50);
  const data = rows.map((r) => {
    const p: any = safeJsonParse(r.payload) || {};
    return {
      id: r.id,
      score_id: p.score_id,
      test_type: r.subtype || p.test_type || '',
      score_value: r.score_value,
      reason: p.reason || '',
      status: p.status || 'open',
      admin_note: p.admin_note || null,
      created_at: r.created_at,
    };
  });
  return c.json({ data });
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
        spam: payload.spam_filtered === true,
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

  // 内容反垃圾：硬命中（广告/外链/危险内容）拦截并落告警；软命中（无意义刷屏）打标记由客户端过滤。
  const env = c.env as Env;
  if (env.CONTENT_FILTER !== 'off') {
    const verdict = analyzeContent(content);
    if (verdict.action === 'block') {
      const redis = getRedis(env);
      await recordAlert(
        redis,
        await (async () => buildShardService(env))(),
        c.executionCtx.waitUntil.bind(c.executionCtx),
        env,
        { kind: 'comment', severity: 'warning', source_ip: clientIp(c), target: userId, message: '评论命中反垃圾规则', count: 1, detail: verdict.reason }
      );
      return c.json({ error: '该内容包含不允许的词语或链接' }, 400);
    }
    if (verdict.action === 'flag') {
      const flagged = { spam_filtered: true, spam_reason: verdict.reason };
      const shard = await buildShardService(env);
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
          spam_filtered: true,
          spam_reason: verdict.reason,
        }),
        file_url: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
      if (!result.ok) return c.json({ error: result.error }, 503);
      try { await getRedis(env).del('cache:stats'); } catch (err) { console.warn('comments cache invalidate failed:', err); }
      return c.json({ success: true, filtered: flagged });
    }
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
    // 优先取鉴权后的真实身份，避免客户端伪造 user_id 灌水在线数
    const userId = str(c.get('userId') || body.user_id, 64).trim();
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
  // 优先取鉴权后的真实身份，避免客户端伪造 user_id 为任意用户建行
  const userId = str(c.get('userId') || body.user_id, 64).trim();
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
// 加入严格 CSP：禁止外联脚本/图片/字体与站点外请求，即使被 XSS 注入也无法外带数据。
const ADMIN_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests";
function serveAdmin(c: any) {
  c.header('Content-Security-Policy', ADMIN_CSP);
  return c.html(renderAdminUI());
}
app.get('/admin', serveAdmin);
app.get('/admin/*', serveAdmin);

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

/** 删除指定用户全部类型的数据（与单删接口保持一致的分片删除策略） */
async function deleteUserAllData(shard: ShardService, userId: string): Promise<void> {
  const types = ['account', 'profile', 'score', 'comment', 'feedback', 'online', 'user', 'file'];
  for (const t of types) {
    const rows = await shard.readByUserAndType(userId, t, 1000);
    for (const row of rows) {
      await shard.deleteById(row.id);
    }
  }
}

/** 封禁/解封单个账号（写新行 + 删旧行，保留 created_at）。返回 { ok } 或 { ok:false, error } */
async function applyUserBan(
  shard: ShardService,
  userId: string,
  banned: boolean,
  reason: string,
  waitUntil: ((p: Promise<unknown>) => void) | undefined
): Promise<{ ok: boolean; error?: string }> {
  const account = (await shard.readByUserAndType(userId, 'account', 10))[0];
  if (!account) return { ok: false, error: '账号不存在' };

  const payload: any = safeJsonParse(account.payload) || {};
  payload.banned = banned;
  if (banned) {
    payload.banned_reason = reason.trim() || '管理员封禁';
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
  if (!writeResult.ok) return { ok: false, error: writeResult.error };
  await shard.deleteById(account.id);
  return { ok: true };
}

/** 高危操作二次校验（2FA）：已启用 TOTP 时，要求请求体中的动态码有效；未启用则放行 */
async function requireHighRiskTotp(c: any, body: { code?: unknown }): Promise<boolean> {
  const env = c.env as Env;
  const t = await verifyAdminTotp(env, String(body?.code || '').trim());
  return t.requiresTotp ? t.ok : true;
}

/** 管理接口统一入口：校验会话令牌（短期、带 TTL），通过后经 c.set 注入管理员标识供审计复用 */
async function adminGw(c: any, next: any): Promise<Response | void> {
  const p = c.req.path;
  // 登录/注销/2FA 首次绑定端点不走会话校验（它们各自处理鉴权：登录与绑定需持口令，注销只消会话）
  if ((c.req.method === 'POST' && (p === '/api/admin/login' || p === '/api/admin/logout')) ||
      (c.req.method === 'GET' && p === '/api/admin/2fa/setup')) {
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
  const adminLabel = `admin#${String(env.ADMIN_TOKEN).slice(-6)}`;
  const created = await createAdminSession(redis, adminLabel, ip, ttlSec);
  if (!created.ok) {
    // 会话令牌写入失败：发不可用的令牌毫无意义，视为登录失败（fail-closed，宁可 503 也不发死令牌）
    console.error('admin session create failed at ip', ip);
    return c.json({ error: 'session create failed, please retry' }, 503 as any);
  }
  writeAudit(shard, waitUntil, adminLabel, 'admin.login.success', ip, `session_ttl=${ttlSec}s`);
  // 高危事件实时推送：后台登录成功也第一时间通知管理员（可配飞书/Lark webhook）
  sendNotify(env.ADMIN_ALERT_WEBHOOK, {
    title: 'APEXON · 后台登录成功',
    theme: 'green',
    lines: [
      { label: '时间', value: new Date().toLocaleString('zh-CN') },
      { label: '来源 IP', value: ip },
      { label: '会话有效', value: Math.round(ttlSec / 60) + ' 分钟' },
    ],
  }, waitUntil);

  return c.json({ ok: true, session: created.token, expires_in: ttlSec, totp_enabled: totp.requiresTotp });
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

// 2FA 首次绑定端点：无需会话令牌，但必须持有管理员口令（常数时间比较），
// 解决「先绑定验证器才能登录，但没登录就看不到密钥」的死锁。
app.get('/api/admin/2fa/setup', async (c) => {
  const env = c.env as Env;
  if (!env.ADMIN_TOKEN) return c.json({ error: 'admin interface disabled' }, 404 as any);
  const authHeader = c.req.header('Authorization');
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  // 必须正确持有 ADMIN_TOKEN 才允许取回 2FA 绑定信息
  if (!verifyAdminPassword(env, token)) return c.json({ error: 'forbidden' }, 403 as any);
  const uri = adminOtpauthUri(env);
  if (!uri) return c.json({ enabled: false, message: '尚未配置 ADMIN_TOTP_SECRET' });
  return c.json({ enabled: true, secret: env.ADMIN_TOTP_SECRET, otpauth: uri });
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
  const body = await c.req.json().catch(() => ({} as { code?: unknown }));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const shard = await buildShardService(c.env);
  const userId = c.req.param('userId');
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  await deleteUserAllData(shard, userId);
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'user.delete', userId);
  sendNotify(c.env.ADMIN_ALERT_WEBHOOK, {
    title: 'APEXON · 高危操作：删除用户',
    theme: 'red',
    lines: [
      { label: '用户', value: userId },
      { label: '来源 IP', value: c.get('adminSessionIp') || '' },
      { label: '范围', value: '账号及全部成绩/评论/资料/反馈' },
    ],
  }, waitUntil);
  return c.json({ success: true });
});

async function setBan(c: any, banned: boolean) {
  const body = await c.req.json().catch(() => ({} as { code?: unknown; reason?: unknown }));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403) as any;
  const shard = await buildShardService(c.env);
  const userId = c.req.param('userId');
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const reason = banned ? str((body as { reason?: unknown }).reason, 300).trim() : '';
  const res = await applyUserBan(shard, userId, banned, reason, waitUntil);
  if (!res.ok) return c.json({ success: false, error: res.error }, res.error && res.error.includes('不存在') ? 404 : 503) as any;
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', banned ? 'user.ban' : 'user.unban', userId, reason || undefined);
  sendNotify(c.env.ADMIN_ALERT_WEBHOOK, {
    title: banned ? 'APEXON · 高危操作：封禁用户' : 'APEXON · 后台操作：解除封禁',
    theme: banned ? 'orange' : 'blue',
    lines: [
      { label: '用户', value: userId },
      { label: (banned ? '原因' : '来源 IP' ), value: banned ? reason : (c.get('adminSessionIp') || '') },
    ],
  }, waitUntil);
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
  const body = await c.req.json().catch(() => ({} as { code?: unknown }));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const row = await shard.readById(c.req.param('id'));
  await shard.deleteById(c.req.param('id'));
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'content.delete', c.req.param('id'), row ? row.type : undefined);
  sendNotify(c.env.ADMIN_ALERT_WEBHOOK, {
    title: 'APEXON · 高危操作：删除内容',
    theme: 'orange',
    lines: [
      { label: '记录', value: c.req.param('id') },
      { label: '类型', value: (row && row.type) || '' },
      { label: '来源 IP', value: c.get('adminSessionIp') || '' },
    ],
  }, waitUntil);
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
  const body = await c.req.json().catch(() => ({} as { code?: unknown }));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const id = c.req.param('id');
  await shard.deleteById(id);
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'alert.delete', id);
  sendNotify(c.env.ADMIN_ALERT_WEBHOOK, {
    title: 'APEXON · 高危操作：删除告警',
    theme: 'orange',
    lines: [
      { label: '告警', value: id },
      { label: '来源 IP', value: c.get('adminSessionIp') || '' },
    ],
  }, waitUntil);
  return c.json({ success: true });
});

app.get('/api/admin/audit', async (c) => {
  // D2 增强：按管理员 / 操作类型 / 关键词筛选
  const admin = str(c.req.query('admin'), 60).trim();
  const action = str(c.req.query('action'), 60).trim();
  const q = str(c.req.query('q'), 200).trim();
  const limit = Number(c.req.query('limit') || 200);
  const shard = await buildShardService(c.env);
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 200, 1), 1000);
  const needle = q.toLowerCase();
  const rows = await shard.readByType('audit', { limit: 1000 });
  const filtered = rows
    .map(flattenAudit)
    .filter((a) => {
      if (admin && a.admin !== admin) return false;
      if (action && a.action !== action) return false;
      if (needle && !`${a.target || ''} ${a.detail || ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  return c.json({ data: filtered.slice(0, safeLimit) });
});

// ---- 数据看板（A1）：注册趋势 / 活跃趋势 / 成绩类型分布（JS 聚合，无线程/外部图库依赖）----
app.get('/api/admin/stats/trends', async (c) => {
  const days = Number(c.req.query('days') || 14);
  const daysClamped = Math.min(Math.max(Number.isFinite(days) ? Math.trunc(days) : 14, 1), 90);
  const shard = await buildShardService(c.env);
  const [accounts, scores] = await Promise.all([
    shard.readByType('account', { limit: 1000 }),
    shard.readByType('score', { limit: 1000 }),
  ]);

  // 本地时区的"日"分桶键（YYYY-MM-DD）
  const dayKey = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // 生成日期轴（含今天之前 daysClamped-1 天）
  const keys: string[] = [];
  const start = new Date();
  start.setDate(start.getDate() - (daysClamped - 1));
  for (let i = 0; i < daysClamped; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const pad = (n: number) => String(n).padStart(2, '0');
    keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }

  const regMap = new Map<string, number>();
  const actMap = new Map<string, number>();
  for (const a of accounts) { const k = dayKey(a.created_at); if (k && keys.includes(k)) regMap.set(k, (regMap.get(k) || 0) + 1); }
  for (const s of scores) { const k = dayKey(s.created_at); if (k && keys.includes(k)) actMap.set(k, (actMap.get(k) || 0) + 1); }

  const registrations = keys.map((k) => ({ date: k, count: regMap.get(k) || 0 }));
  const activity = keys.map((k) => ({ date: k, count: actMap.get(k) || 0 }));

  // 成绩类型分布（不限定窗口，展示全量结构）
  const distMap = new Map<string, number>();
  for (const s of scores) {
    const t = s.subtype || ((safeJsonParse(s.payload) as any)?.test_type) || 'other';
    distMap.set(t, (distMap.get(t) || 0) + 1);
  }
  const distribution = Array.from(distMap.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const distinctUsers = new Set(scores.map((s) => s.user_id)).size;

  return c.json({ success: true, data: { days: daysClamped, registrations, activity, distribution, active_users: distinctUsers } });
});

// ---- 导出 CSV（A2）----
app.get('/api/admin/export/users', async (c) => {
  const q = str(c.req.query('q'), 100);
  const shard = await buildShardService(c.env);
  const rows = await searchAccounts(shard, q, 1000);
  const headers = ['user_id', 'username', 'email', 'banned', 'banned_reason', 'created_at', 'updated_at'];
  const body = rows.map(flattenAccount).map((u) => [
    u.user_id, u.username, u.email || '', u.banned ? '1' : '0', u.banned_reason || '', u.created_at, u.updated_at,
  ]);
  return csvDownload(toCsv(headers, body), csvFilename('users'));
});

app.get('/api/admin/export/audit', async (c) => {
  const admin = str(c.req.query('admin'), 60).trim();
  const action = str(c.req.query('action'), 60).trim();
  const q = str(c.req.query('q'), 200).trim();
  const shard = await buildShardService(c.env);
  const needle = q.toLowerCase();
  const rows = await shard.readByType('audit', { limit: 1000 });
  const filtered = rows.map(flattenAudit).filter((a) => {
    if (admin && a.admin !== admin) return false;
    if (action && a.action !== action) return false;
    if (needle && !`${a.target || ''} ${a.detail || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const headers = ['id', 'admin', 'action', 'target', 'detail', 'created_at'];
  const body = filtered.map((a) => [a.id, a.admin || '', a.action || '', a.target || '', a.detail || '', a.created_at]);
  return csvDownload(toCsv(headers, body), csvFilename('audit'));
});

// ---- 批量操作（D1）：批量删除 / 封禁 / 解封（均需 2FA 动态码）----
function adminUserIdList(body: any): string[] {
  if (!Array.isArray(body?.userIds)) return [];
  return body.userIds.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => String(x).trim().slice(0, 128)).slice(0, 500);
}

app.post('/api/admin/users/batch/delete', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const userIds = adminUserIdList(body);
  if (!userIds.length) return c.json({ error: 'userIds 不能为空' }, 400);
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  let deleted = 0;
  for (const id of userIds) {
    try { await deleteUserAllData(shard, id); deleted += 1; }
    catch (err) { console.error(`batch delete user ${id} failed:`, err); }
  }
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'user.batch_delete', `${userIds.length}`, `deleted=${deleted}`);
  sendNotify(c.env.ADMIN_ALERT_WEBHOOK, {
    title: 'APEXON · 高危操作：批量删除用户',
    theme: 'red',
    lines: [
      { label: '数量', value: `${deleted}/${userIds.length}` },
      { label: '来源 IP', value: c.get('adminSessionIp') || '' },
    ],
  }, waitUntil);
  return c.json({ success: true, deleted, requested: userIds.length });
});

app.post('/api/admin/users/batch/ban', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const userIds = adminUserIdList(body);
  if (!userIds.length) return c.json({ error: 'userIds 不能为空' }, 400);
  const reason = str((body as { reason?: unknown }).reason, 300).trim() || '批量封禁';
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  let done = 0, failed = 0;
  for (const id of userIds) {
    const r = await applyUserBan(shard, id, true, reason, waitUntil);
    r.ok ? (done += 1) : (failed += 1);
  }
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'user.batch_ban', `${userIds.length}`, `done=${done} failed=${failed} reason=${reason}`);
  sendNotify(c.env.ADMIN_ALERT_WEBHOOK, {
    title: 'APEXON · 高危操作：批量封禁用户',
    theme: 'orange',
    lines: [
      { label: '数量', value: `${done}/${userIds.length}（失败 ${failed}）` },
      { label: '原因', value: reason },
      { label: '来源 IP', value: c.get('adminSessionIp') || '' },
    ],
  }, waitUntil);
  return c.json({ success: true, done, failed });
});

app.post('/api/admin/users/batch/unban', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const userIds = adminUserIdList(body);
  if (!userIds.length) return c.json({ error: 'userIds 不能为空' }, 400);
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  let done = 0;
  for (const id of userIds) { const r = await applyUserBan(shard, id, false, '', waitUntil); if (r.ok) done += 1; }
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'user.batch_unban', `${userIds.length}`, `done=${done}`);
  return c.json({ success: true, done });
});

// ===========================================================================
// 新增：登录加固 / 防刷分 / 成绩申诉 / 教师端班级 / 成绩发布订阅（管理端）
// ===========================================================================

/** 校类名：仅允许 1-40 位的中英文、数字、横杠、下划线 */
function normClass(v: unknown): string {
  const s = str(v, 40).trim();
  return /^[\w\u4e00-\u9fa5-]{1,40}$/.test(s) ? s : '';
}

/** 更新账号所属班级（写新行 + 删除旧行，保留 created_at） */
async function setUserClass(
  shard: ShardService,
  userId: string,
  cls: string,
  waitUntil: ((p: Promise<unknown>) => void) | undefined
): Promise<{ ok: boolean; error?: string }> {
  const account = (await shard.readByUserAndType(userId, 'account', 10))[0];
  if (!account) return { ok: false, error: '账号不存在' };
  const payload: any = safeJsonParse(account.payload) || {};
  if (cls) payload.class = cls;
  else delete payload.class;
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
  if (!writeResult.ok) return { ok: false, error: writeResult.error };
  await shard.deleteById(account.id);
  return { ok: true };
}

/** 覆写一条成绩的 validity（写新行 + 删除旧行，保持同一 id，幂等） */
async function setScoreValidity(
  shard: ShardService,
  scoreId: string,
  validity: 'valid' | 'invalid',
  note: string,
  waitUntil: ((p: Promise<unknown>) => void) | undefined
): Promise<{ ok: boolean; error?: string; test_type?: string }> {
  const score = await shard.readById(scoreId);
  if (!score || score.type !== 'score') return { ok: false, error: '成绩不存在' };
  const payload: any = safeJsonParse(score.payload) || {};
  payload.validity = validity;
  payload.flag_reason = validity === 'invalid' ? (note || payload.flag_reason || '管理员标记') : null;
  payload.flagged = validity === 'invalid';
  payload.leaderboard_eligible = validity === 'valid';
  const writeResult = await shard.write({
    id: scoreId,
    user_id: score.user_id,
    type: 'score',
    subtype: score.subtype,
    score_value: score.score_value,
    payload: JSON.stringify(payload),
    file_url: score.file_url,
    created_at: score.created_at,
    updated_at: new Date().toISOString(),
  }, { waitUntil });
  if (!writeResult.ok) return { ok: false, error: writeResult.error };
  await shard.deleteById(scoreId);
  return { ok: true, test_type: score.subtype || payload.test_type || '' };
}

// ---- 登录加固：验证码状态 + 累积式 IP 黑名单管理 ----
app.get('/api/admin/security', async (c) => {
  const env = c.env as Env;
  return c.json({
    data: {
      captcha_always: env.CAPTCHA_ALWAYS === 'on',
      captcha_require_after_fail: Number(env.CAPTCHA_REQUIRE_AFTER_FAIL) || 3,
      ip_blacklist_threshold: Number(env.IP_BLACKLIST_THRESHOLD) || 20,
      ip_blacklist_window_sec: Number(env.IP_BLACKLIST_WINDOW_SEC) || 3600,
      ip_blacklist_duration_sec: Number(env.IP_BLACKLIST_DURATION_SEC) || 86400,
      admin_alert_webhook: Boolean(env.ADMIN_ALERT_WEBHOOK),
    },
  });
});

app.get('/api/admin/security/ipbans', async (c) => {
  const redis = getRedis(c.env);
  let keys: string[] = [];
  try {
    keys = await redis.keys('ipblack:*');
  } catch (err) {
    console.error('ipbans keys scan failed:', err);
    return c.json({ data: [] });
  }
  const list: Array<{ ip: string; failures: number; ttl: number }> = [];
  for (const k of keys.slice(0, 200)) {
    const ip = k.replace(/^ipblack:/, '');
    let failures = 0, ttl = 0;
    try { failures = (await redis.get<number>(k)) || 0; } catch { /* */ }
    try { ttl = await redis.ttl(k); } catch { /* */ }
    list.push({ ip, failures, ttl });
  }
  list.sort((a, b) => a.ip.localeCompare(b.ip));
  return c.json({ data: list });
});

app.post('/api/admin/security/ipbans/add', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const ip = str((body as { ip?: unknown }).ip, 64).trim();
  if (!/^[\w.:\-\[\]]+$/.test(ip) || !ip) return c.json({ error: '无效的 IP' }, 400);
  const hours = Number((body as { hours?: unknown }).hours);
  const durationSec = Number.isFinite(hours) && hours > 0 ? Math.min(Math.trunc(hours * 3600), 30 * 86400) : (Number((c.env as Env).IP_BLACKLIST_DURATION_SEC) || 86400);
  await blacklistIp(getRedis(c.env), ip, durationSec);
  const shard = await buildShardService(c.env);
  await writeAudit(shard, c.executionCtx.waitUntil.bind(c.executionCtx), c.get('adminToken') || '', 'security.ipban.add', ip, `duration=${durationSec}s`);
  return c.json({ success: true, ip, duration_sec: durationSec });
});

app.post('/api/admin/security/ipbans/remove', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ip = str((body as { ip?: unknown }).ip, 64).trim();
  if (!ip) return c.json({ error: '无效的 IP' }, 400);
  await clearIpBlacklist(getRedis(c.env), ip);
  const shard = await buildShardService(c.env);
  await writeAudit(shard, c.executionCtx.waitUntil.bind(c.executionCtx), c.get('adminToken') || '', 'security.ipban.remove', ip);
  return c.json({ success: true });
});

// ---- 防刷分：异常成绩审核 ----
app.get('/api/admin/scores/flagged', async (c) => {
  const status = str(c.req.query('status'), 20).trim(); // all | suspicious | invalid
  const shard = await buildShardService(c.env);
  const rows = await shard.readByType('score', { limit: 1000 });
  const data = rows
    .map((r) => {
      const p: any = safeJsonParse(r.payload) || {};
      const v = p.validity === 'invalid' ? 'invalid' : (p.flagged || p.validity === 'suspicious' ? 'suspicious' : 'valid');
      return {
        id: r.id,
        user_id: r.user_id,
        username: p.username || r.user_id,
        test_type: r.subtype || p.test_type || '',
        score_value: r.score_value,
        validity: v,
        flag_reason: p.flag_reason || null,
        leaderboard_eligible: p.leaderboard_eligible !== false,
        created_at: r.created_at,
      };
    })
    .filter((s) => status === 'all' || s.validity === status || (status === '' && s.validity !== 'valid'))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return c.json({ data: data.slice(0, 500) });
});

app.patch('/api/admin/scores/:id/validity', async (c) => {
  const env = c.env as Env;
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const validity = str((body as { validity?: unknown }).validity, 16).trim();
  if (validity !== 'valid' && validity !== 'invalid') return c.json({ error: 'validity 只能为 valid 或 invalid' }, 400);
  const id = c.req.param('id');
  const note = str((body as { reason?: unknown }).reason, 300).trim();
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const r = await setScoreValidity(shard, id, validity, note, waitUntil);
  if (!r.ok) return c.json({ error: r.error }, r.error && r.error.includes('不存在') ? 404 : 503);
  // 失效/恢复上榜会改变榜单聚合结果，需清缓存
  if (r.test_type) {
    try { await getRedis(env).del(`cache:lb:${r.test_type}`); } catch { /* ignore */ }
  }
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', validity === 'invalid' ? 'score.invalidate' : 'score.restore', id, note || undefined);
  return c.json({ success: true, validity });
});

// ---- 成绩申诉审核 ----
function flattenAppeal(r: MixedData) {
  const p: any = safeJsonParse(r.payload) || {};
  return {
    id: r.id,
    user_id: r.user_id,
    score_id: p.score_id || '',
    test_type: r.subtype || p.test_type || '',
    score_value: r.score_value,
    reason: p.reason || '',
    status: p.status || 'open',
    admin_note: p.admin_note || null,
    created_at: r.created_at,
  };
}

app.get('/api/admin/appeals', async (c) => {
  const status = str(c.req.query('status'), 20).trim(); // open | all
  const shard = await buildShardService(c.env);
  const rows = await shard.readByType('appeal', { limit: 1000 });
  let data = rows.map(flattenAppeal);
  if (status === 'open') data = data.filter((a) => a.status === 'open');
  data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return c.json({ data: data.slice(0, 500) });
});

app.patch('/api/admin/appeals/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const id = c.req.param('id');
  const status = str((body as { status?: unknown }).status, 16).trim();
  const note = str((body as { note?: unknown }).note, 300).trim();
  if (status !== 'approved' && status !== 'rejected') return c.json({ error: 'status 只能为 approved 或 rejected' }, 400);

  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const appeal = await shard.readById(id);
  if (!appeal || appeal.type !== 'appeal') return c.json({ error: '申诉不存在' }, 404);
  const ap: any = safeJsonParse(appeal.payload) || {};
  if (ap.status !== 'open') return c.json({ error: '该申诉已处理' }, 409);

  // 更新申诉状态（写新行 + 删旧行，保持同一 id）
  const now = new Date().toISOString();
  ap.status = status;
  ap.updated_at = now;
  ap.resolved_by = c.get('adminToken') || 'admin';
  ap.admin_note = note || null;
  const w1 = await shard.write({
    id,
    user_id: appeal.user_id,
    type: 'appeal',
    subtype: appeal.subtype,
    score_value: appeal.score_value,
    payload: JSON.stringify(ap),
    file_url: appeal.file_url,
    created_at: appeal.created_at,
    updated_at: now,
  }, { waitUntil });
  if (!w1.ok) return c.json({ error: w1.error }, 503);
  await shard.deleteById(id);

  // 申诉通过 → 恢复对应成绩为有效并上榜
  const scoreId = ap.score_id;
  if (status === 'approved' && scoreId) {
    const sc = await setScoreValidity(shard, scoreId, 'valid', '', waitUntil);
    if (sc.ok && sc.test_type) {
      try { await getRedis(c.env).del(`cache:lb:${sc.test_type}`); } catch { /* ignore */ }
    }
  }

  await writeAudit(shard, waitUntil, c.get('adminToken') || '', `appeal.${status}`, id, `score=${scoreId || '-'} note=${note || '-'}`);
  return c.json({ success: true, status });
});

// ---- 教师端：班级管理 + 成绩 CSV 导入 + 发布订阅 ----
app.post('/api/admin/users/:userId/class', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const cls = normClass((body as { class?: unknown }).class);
  const userId = c.req.param('userId');
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const r = await setUserClass(shard, userId, cls, waitUntil);
  if (!r.ok) return c.json({ error: r.error }, r.error && r.error.includes('不存在') ? 404 : 503);
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', cls ? 'user.setclass' : 'user.clearclass', userId, cls || '(清空)');
  return c.json({ success: true, class: cls });
});

app.post('/api/admin/users/batch/class', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const cls = normClass((body as { class?: unknown }).class);
  if (!cls) return c.json({ error: 'class 不能为空' }, 400);
  const userIds = adminUserIdList(body);
  if (!userIds.length) return c.json({ error: 'userIds 不能为空' }, 400);
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  let done = 0, failed = 0;
  for (const id of userIds) {
    const r = await setUserClass(shard, id, cls, waitUntil);
    r.ok ? (done += 1) : (failed += 1);
  }
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'user.batch_class', `${userIds.length}`, `class=${cls} done=${done} failed=${failed}`);
  return c.json({ success: true, done, failed });
});

/** 汇总班级：依据 account 上的 class 字段聚合（排除压测账号与未设班级） */
app.get('/api/admin/classes', async (c) => {
  const shard = await buildShardService(c.env);
  const accounts = await shard.readByType('account', { limit: 1000 });
  const byClass = new Map<string, number>();
  for (const row of accounts) {
    const p: any = safeJsonParse(row.payload) || {};
    const name = typeof p.class === 'string' ? p.class.trim() : '';
    if (!name || !normClass(name)) continue;
    byClass.set(name, (byClass.get(name) || 0) + 1);
  }
  const data = Array.from(byClass.entries())
    .map(([name, member_count]) => ({ name, member_count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return c.json({ data });
});

/** 班级名册：返回该班级的所有账号 */
app.get('/api/admin/classes/:name/members', async (c) => {
  const name = normClass(c.req.param('name'));
  if (!name) return c.json({ error: '无效的班级名' }, 400);
  const shard = await buildShardService(c.env);
  const accounts = await shard.readByType('account', { limit: 1000 });
  const members = accounts
    .filter((row) => {
      const p: any = safeJsonParse(row.payload) || {};
      return typeof p.class === 'string' && p.class.trim() === name;
    })
    .map(flattenAccount);
  return c.json({ data: members });
});

/** 班级榜单导出：每个成员在各类测试上的最佳成绩（CSV，每行=成员×类型） */
app.get('/api/admin/classes/:name/export', async (c) => {
  const name = normClass(c.req.param('name'));
  if (!name) return c.json({ error: '无效的班级名' }, 400);
  const shard = await buildShardService(c.env);
  const accounts = await shard.readByType('account', { limit: 1000 });
  const userSet = new Set<string>();
  const userName = new Map<string, string>();
  for (const row of accounts) {
    const p: any = safeJsonParse(row.payload) || {};
    if (typeof p.class === 'string' && p.class.trim() === name) {
      userSet.add(row.user_id);
      userName.set(row.user_id, typeof p.username === 'string' ? p.username : row.user_id);
    }
  }
  const scores = await shard.readByType('score', { limit: 1000 });
  const bestByKey = new Map<string, MixedData>();
  for (const s of scores) {
    if (!userSet.has(s.user_id)) continue;
    const sub = s.subtype || '';
    if (!sub) continue;
    const p: any = safeJsonParse(s.payload) || {};
    if (p.leaderboard_eligible === false || p.validity === 'invalid') continue;
    if (p.flagged || p.validity === 'suspicious') continue;
    const key = `${s.user_id}\u0001${sub}`;
    const cur = bestByKey.get(key);
    const better = !cur
      || (scoreLowerIsBetter(sub)
        ? (s.score_value ?? Infinity) < (cur.score_value ?? Infinity)
        : (s.score_value ?? -Infinity) > (cur.score_value ?? -Infinity));
    if (better) bestByKey.set(key, s);
  }
  const headers = ['class', 'username', 'user_id', 'test_type', 'best_score', 'created_at'];
  const body = Array.from(bestByKey.entries()).map(([key, s]) => {
    const [userId] = key.split('\u0001');
    return [name, userName.get(userId) || userId, userId, s.subtype || '', s.score_value ?? '', s.created_at];
  });
  body.sort((a, b) => String(a[3]).localeCompare(String(b[3])) || (Number(b[4]) || 0) - (Number(a[4]) || 0));
  return csvDownload(toCsv(headers, body), csvFilename(`class-${name}`));
});

/** 成绩批量导入（教师 CSV）：支持 preview(预览, dry_run) 与 commit(提交)。表头：username,test_type,score_value[,accuracy,wpm,cpm] */
app.post('/api/admin/scores/import', async (c) => {
  const env = c.env as Env;
  const body = await c.req.json().catch(() => ({}));
  if (!(await requireHighRiskTotp(c, body))) return c.json({ error: '需要有效的动态验证码' }, 403 as any);
  const csv = str((body as { csv?: unknown }).csv, 2_000_000);
  const dryRun = (body as { dry_run?: unknown }).dry_run !== false;
  const rows = parseCsv(csv);
  if (!rows) return c.json({ error: '文件不是合法的 CSV（引号未闭合）' }, 400);
  if (rows.length < 2) return c.json({ error: '没有可导入的数据行' }, 400);

  const maxRows = Math.min(Math.max(Number(env.IMPORT_MAX_ROWS) || 1000, 1), 5000);
  // 表头映射（大小写不敏感、容错空格，支持常见中文别名）
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/ +/g, '_'));
  const idx = (names: string[]) => {
    const hit = names.find((n) => head.indexOf(n) !== -1);
    return hit ? head.indexOf(hit) : -1;
  };
  const iUser = idx(['username', 'user_id', 'user', '用户名', '账号']);
  const iType = idx(['test_type', 'testtype', 'type', '题目', '测试类型']);
  const iScore = idx(['score_value', 'score', 'value', '分数', '成绩']);
  const iAcc = idx(['accuracy', '正确率']);
  const iWpm = idx(['wpm']);
  const iCpm = idx(['cpm']);
  if (iUser < 0 || iType < 0 || iScore < 0) {
    return c.json({ error: '表头缺失：需要包含 username / test_type / score_value 列' }, 400);
  }

  const shard = await buildShardService(c.env);
  const accounts = await shard.readByType('account', { limit: 1000 });
  const byUser = new Map<string, { user_id: string; username: string }>();
  for (const a of accounts) {
    const p: any = safeJsonParse(a.payload) || {};
    const uname = typeof p.username === 'string' ? p.username : a.user_id;
    byUser.set(uname.toLowerCase(), { user_id: a.user_id, username: uname });
    byUser.set(a.user_id.toLowerCase(), { user_id: a.user_id, username: uname });
  }

  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  const redis = getRedis(env);
  const errors: Array<{ row: number; message: string }> = [];
  const toWrite: Array<{ user_id: string; test_type: string; score_value: number; accuracy: number | null; wpm: number | null; cpm: number | null; created_at: string; flagged: boolean; flag_reason: string | null }> = [];
  const involvedTypes = new Set<string>();

  for (let r = 1; r < rows.length && r - 1 < maxRows; r++) {
    const line = rows[r];
    const get = (col: number) => (col >= 0 && col < line.length ? line[col].trim() : '');
    const unameRaw = get(iUser);
    const typeRaw = get(iType);
    const scoreRaw = get(iScore);
    if (!unameRaw && !typeRaw && !scoreRaw) continue; // 空行跳过

    // 跳过表头行（与首行完全相同的行）
    if (JSON.stringify(line) === JSON.stringify(rows[0])) continue;

    const user = byUser.get(unameRaw.toLowerCase());
    if (!user) { errors.push({ row: r + 1, message: `未找到用户「${unameRaw}」` }); continue; }
    const testType = typeRaw;
    if (!testType || !/^[\w-]{1,40}$/.test(testType)) { errors.push({ row: r + 1, message: `无效的 test_type「${typeRaw}」` }); continue; }
    const sv = Number(scoreRaw);
    if (!Number.isFinite(sv) || sv < 0 || !scoreInBounds(testType, sv)) { errors.push({ row: r + 1, message: `分数越界「${scoreRaw}」` }); continue; }

    // 复用异常检测
    let flagged = false, flagReason: string | null = null;
    try {
      const an = await checkScoreAnomaly(redis, shard, user.user_id, testType, sv, scoreLowerIsBetter(testType));
      flagged = an.flagged;
      flagReason = an.flagReason || null;
    } catch (err) {
      console.error('import anomaly check failed:', err);
    }
    const acc = iAcc >= 0 ? num(get(iAcc)) : null;
    const wpm = iWpm >= 0 ? num(get(iWpm)) : null;
    const cpm = iCpm >= 0 ? num(get(iCpm)) : null;
    toWrite.push({
      user_id: user.user_id,
      test_type: testType,
      score_value: sv,
      accuracy: acc,
      wpm,
      cpm,
      created_at: new Date().toISOString(),
      flagged,
      flag_reason: flagReason,
    });
    involvedTypes.add(testType);
  }

  if (dryRun || !toWrite.length) {
    return c.json({
      dry_run: true,
      preview: true,
      total_rows: rows.length - 1,
      would_add: toWrite.length,
      error_count: errors.length,
      errors: errors.slice(0, 200),
      involved_types: Array.from(involvedTypes),
    });
  }

  // commit：落库
  let added = 0;
  for (const item of toWrite) {
    const now = new Date().toISOString();
    const r = await shard.write({
      id: uuid(),
      user_id: item.user_id,
      type: 'score',
      subtype: item.test_type,
      score_value: item.score_value,
      payload: JSON.stringify({
        username: userNameOf(shard, item.user_id, accounts) as any,
        test_type: item.test_type,
        score_value: item.score_value,
        accuracy: item.accuracy,
        wpm: item.wpm,
        cpm: item.cpm,
        leaderboard_eligible: !item.flagged,
        validity: item.flagged ? 'suspicious' : 'valid',
        flag_reason: item.flag_reason,
        flagged: item.flagged,
        source: 'admin-import',
      }),
      file_url: null,
      created_at: item.created_at,
      updated_at: now,
    }, { waitUntil });
    if (r.ok) added += 1;
  }
  // 清相关排行榜缓存
  for (const t of involvedTypes) {
    try { await redis.del(`cache:lb:${t}`); } catch { /* ignore */ }
  }
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'score.import', `${added}`, `types=${Array.from(involvedTypes).join(',')}`);

  // 发布：给订阅了相关题型的用户发邮件提醒（fire-and-forget，不阻塞导入响应）
  if (involvedTypes.size > 0) {
    const task = (async () => {
      for (const t of involvedTypes) {
        const subs = await subscribersForType(shard, t, 1000);
        if (subs.length) await sendPublishNotification(env, subs, t, `新成绩已发布«${t}»`);
      }
    })();
    task.catch((err) => console.error('notify subscribers after import failed:', err));
    try { waitUntil(task); } catch { /* ignore */ }
  }

  return c.json({ dry_run: false, committed: true, added, error_count: errors.length, errors: errors.slice(0, 200) });
});

// 导入时解析用户名的小工具：避免重复扫库
function userNameOf(shard: ShardService, userId: string, cache: MixedData[]): string {
  const row = cache.find((a) => a.user_id === userId);
  if (row) {
    const p: any = safeJsonParse(row.payload) || {};
    return typeof p.username === 'string' ? p.username : userId;
  }
  return userId;
}

/** 手动发布成绩通知：向订阅了某 type（或全部）的用户发邮件。test_type 可空=全部 */
app.post('/api/admin/notify/publish', async (c) => {
  const env = c.env as Env;
  const body = await c.req.json().catch(() => ({}));
  const testType = str((body as { test_type?: unknown }).test_type, 40).trim();
  const subject = str((body as { subject?: unknown }).subject, 120);
  const message = str((body as { message?: unknown }).message, 2000);
  const shard = await buildShardService(c.env);
  const waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);

  const subs = await subscribersForType(shard, testType, 1000);
  const result = await sendPublishNotification(env, subs, testType, subject, message);
  await writeAudit(shard, waitUntil, c.get('adminToken') || '', 'notify.publish', testType || '(all)', `recipients=${subs.length} sent=${result.sent} configured=${result.configured}`);
  return c.json({ success: true, type: testType || '(all)', recipients: subs.length, sent: result.sent, configured: result.configured });
});
// ===== 榜单快照与回放（admin）=====
// 固化某个时刻的排行榜，供事后回放与追溯，化解排名争议。
app.get('/api/admin/snapshots', async (c) => {
  const shard = await buildShardService(c.env);
  const list = await listSnapshots(shard, getRedis(c.env));
  return c.json({ data: list });
});

app.post('/api/admin/snapshots', async (c) => {
  const shard = await buildShardService(c.env);
  const meta = await createSnapshot(shard, getRedis(c.env), c.env as Env);
  if (!meta) return c.json({ error: '快照生成失败' }, 503);
  await writeAudit(shard, c.executionCtx.waitUntil.bind(c.executionCtx), c.get('adminToken') || '', 'lb.snapshot', meta.id, `types=${meta.type_count} entries=${meta.entry_count}`);
  return c.json({ success: true, snapshot: meta });
});

app.get('/api/admin/snapshots/:id', async (c) => {
  const shard = await buildShardService(c.env);
  const snap = await getSnapshot(shard, c.req.param('id'));
  if (!snap) return c.json({ error: '快照不存在' }, 404);
  return c.json({ data: snap });
});

app.notFound((c) => {
  return c.json({ success: false, error: 'Not found', path: c.req.path }, 404);
});
app.onError((err, c) => {
  console.error(`[onError] ${c.req.method} ${c.req.path}`, err instanceof Error ? err.message : String(err));
  reportError(
    (c.env as Env).OBSERVABILITY_WEBHOOK,
    { method: c.req.method, path: c.req.path, message: err instanceof Error ? err.message : String(err) },
    c.executionCtx.waitUntil.bind(c.executionCtx)
  );
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

export default app;
