import type { Redis } from '@upstash/redis/cloudflare';
import type { Env } from '../types/env';
import type { MixedData } from '../types/models';
import type { ShardService } from './shard';
import { verifyTotp } from './totp';
import { accountRisk } from './security';

/**
 * 管理后台辅助：鉴权 + 审计 + 数据聚合
 *
 * 鉴权策略：管理接口一律要求 Bearer 令牌与 env.ADMIN_TOKEN 完全一致（常数时间比较）。
 * ADMIN_TOKEN 未配置 → 管理接口整体 404（禁用），避免暴露存在性。
 *
 * 复查安全说明：ADMIN_TOKEN 是管理员口令，配置在 Cloudflare Secret 中加密存储，
 * 建议使用本仓库工具生成的 512 位（128 位十六进制）随机口令，配合 PBKDF2（见 password.ts）。
 */

const TEST_ACCOUNT_RE = /^(test|testuser|verify|stress|stresstest|perf|loadtest|e2e|diag|dummy|benchmark|failcase|placeholder)[_\-\w]*$|realtest/i;

function safeJsonParse(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

/** 常数时间比较两个字符串（防止管理口令被时序旁路探测） */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** 从请求头取 Bearer 令牌；不合法返回 null */
function bearerToken(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const t = authHeader.slice(7).trim();
  return t || null;
}

/**
 * 管理接口鉴权。返回 { ok:true, token } 或 { ok:false, status, error }。
 * 签名刻意只要求最小结构，避免与 Hono 具体 Context 泛型耦合。
 */
export function authorizeAdmin(
  c: { env: Env; req: { header: (name: string) => string | undefined } }
): { ok: true; token: string } | { ok: false; status: number; error: string } {
  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) return { ok: false, status: 404, error: 'admin interface disabled' };
  const token = bearerToken(c.req.header('Authorization'));
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };
  if (!safeEqual(token, adminToken)) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, token };
}

/**
 * 写一条管理审计日志（fire-and-forget，不影响操作结果）。管理员身份用令牌尾 6 位标识。
 */
export async function writeAudit(
  shard: ShardService,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  adminToken: string,
  action: string,
  target: string | null,
  detail?: string
): Promise<void> {
  const createdAt = new Date().toISOString();
  try {
    const r = await shard.write(
      {
        id: crypto.randomUUID(),
        user_id: `admin#${adminToken.slice(-6)}`,
        type: 'audit',
        subtype: action,
        score_value: null,
        payload: JSON.stringify({
          admin: `admin#${adminToken.slice(-6)}`,
          action,
          target,
          detail: detail || null,
          created_at: createdAt,
        }),
        file_url: null,
        created_at: createdAt,
        updated_at: createdAt,
      },
      { waitUntil }
    );
    if (!r.ok) console.error('audit persist failed:', r.error);
  } catch (err) {
    console.error('audit write error:', err);
  }
}

/** 账号行 → 面板可读对象（不含密码哈希/会话钥匙等敏感字段） */
export function flattenAccount(row: MixedData): {
  id: string;
  user_id: string;
  username: string;
  email: string | null;
  banned: boolean;
  banned_reason: string | null;
  created_at: string;
  updated_at: string;
} {
  const p = safeJsonParse(row.payload);
  return {
    id: row.id,
    user_id: row.user_id,
    username: typeof p.username === 'string' ? p.username : row.user_id,
    email: typeof p.email === 'string' ? p.email : null,
    banned: Boolean(p.banned),
    banned_reason: typeof p.banned_reason === 'string' ? p.banned_reason : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 按用户名/ID 模糊搜索账号（排除压测账号，纯过滤不改排序）。 */
export async function searchAccounts(
  shard: ShardService,
  q: string,
  limit: number
): Promise<MixedData[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 1000);
  const accounts = await shard.readByType('account', { limit: safeLimit });
  const needle = q.trim().toLowerCase();
  return accounts.filter((row) => {
    const ua = flattenAccount(row);
    // 排除压测账号，保持与排行榜一致的通告口径
    const name = ua.username.trim();
    if (name && TEST_ACCOUNT_RE.test(name)) return false;
    if (!needle) return true;
    return (
      ua.username.toLowerCase().includes(needle) ||
      ua.user_id.toLowerCase().includes(needle) ||
      ua.id.toLowerCase().includes(needle)
    );
  });
}

/** 拉取某用户的综合档案（account + profile + 统计），用于详情页 */
export async function getUserDetail(
  shard: ShardService,
  userId: string
): Promise<{
  user_id: string;
  username: string;
  email: string | null;
  banned: boolean;
  banned_reason: string | null;
  account_created_at: string | null;
  profile: any | null;
  score_count: number;
  comment_count: number;
  feedback_count: number;
  online_last_seen: string | null;
  recent_scores: MixedData[];
  last_login_ip: string | null;
  risk: { score: number; level: 'low' | 'medium' | 'high' | 'critical'; flags: string[] };
}> {
  const account = (await shard.readByUserAndType(userId, 'account', 10))[0];
  const profiles = await shard.readByUserAndType(userId, 'profile', 1);
  const scores = await shard.readByUserAndType(userId, 'score', 200);
  const comments = await shard.readByUserAndType(userId, 'comment', 1000);
  const feedback = await shard.readByUserAndType(userId, 'feedback', 1000);
  const online = (await shard.readByUserAndType(userId, 'online', 1))[0];

  const accountInfo = account ? flattenAccount(account) : null;
  const onlineLast = online ? safeJsonParse(online.payload).last_seen || online.updated_at : null;
  const accountPayload: any = account ? safeJsonParse(account.payload) : null;

  return {
    user_id: userId,
    username: accountInfo?.username || (profiles[0] ? safeJsonParse(profiles[0].payload).username : userId),
    email: accountInfo?.email ?? null,
    banned: accountInfo?.banned ?? false,
    banned_reason: accountInfo?.banned_reason ?? null,
    account_created_at: account ? account.created_at : null,
    profile: profiles[0] ? safeJsonParse(profiles[0].payload) : null,
    score_count: scores.length,
    comment_count: comments.length,
    feedback_count: feedback.length,
    online_last_seen: onlineLast || null,
    recent_scores: scores.slice(0, 20),
    last_login_ip: typeof accountPayload?.last_login_ip === 'string' ? accountPayload.last_login_ip : null,
    risk: accountRisk(accountPayload || {}, 0),
  };
}

/** 内容审核列表（comment / feedback / score / profile，可选关键词过滤） */
export async function listContent(
  shard: ShardService,
  type: string,
  q: string,
  limit: number
): Promise<MixedData[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 1000);
  const rows = await shard.readByType(type, { limit: safeLimit });
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => {
    const text = [
      r.id,
      r.user_id,
      r.subtype || '',
      safeJsonParse(r.payload).content,
      safeJsonParse(r.payload).username,
      safeJsonParse(r.payload).name,
    ]
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .toLowerCase();
    return text.includes(needle);
  });
}

// ---------------------------------------------------------------------------
// 双重验证（2FA）登录与会话
//
// 关键安全设计：
//   1) 登录端点 `POST /api/admin/login` 校验「口令 + TOTP 动态码」，两者都正确
//      才发放一段短期**会话令牌**（Redis 存 key，带 TTL）。
//   2) 之后所有 /api/admin/* 接口一律只认该会话令牌，**不再直接校验 ADMIN_TOKEN**。
//      因此即使攻击者偷到 ADMIN_TOKEN（口令），缺动态码也无法绕过双重验证直连接口。
//   3) 连续登录失败按来源 IP 计数，超过阈值临时冻结，并写审计 + 触发告警。
// ---------------------------------------------------------------------------

// 会话存储前缀（Redis）
const ADMIN_SESSION_PREFIX = 'admin:sess:';
// 登录失败计数 / 冻结前缀
const ADMIN_FAIL_PREFIX = 'admin:loginfail:';
const ADMIN_LOCK_PREFIX = 'admin:lock:';

/** 会话有效期：默认 2 小时，可通过 env.ADMIN_SESSION_TTL_SEC 覆盖 */
export function adminSessionTtl(env: Env): number {
  const v = Number(env.ADMIN_SESSION_TTL_SEC);
  const safe = Number.isFinite(v) && v > 0 ? Math.min(Math.trunc(v), 24 * 3600) : 2 * 3600;
  return Math.max(300, safe);
}

/** 登录失败阈值与冻结窗口：5 分钟内 5 次失败 → 冻结 15 分钟 */
export const ADMIN_FAIL_WINDOW_SEC = 300;
export const ADMIN_FAIL_LOCK_THRESHOLD = 5;
export const ADMIN_LOCK_WINDOW_SEC = 15 * 60;

/** 校验后台口令（常数时间比较）。env 未配置口令时不返回 ok。 */
export function verifyAdminPassword(env: Env, password: string): boolean {
  return !!(env.ADMIN_TOKEN && safeEqual(password, env.ADMIN_TOKEN));
}

/** 管理员角色：普通管理员 / 站长（站长由管理员二次认证升级而来） */
export type AdminRole = 'admin' | 'owner';

/**
 * 校验「站长」认证口令（常数时间比较）。
 * 未配置 OWNER_TOKEN 时返回 false —— 站长认证整体禁用，管理员始终停留在 admin 角色。
 */
export function verifyOwnerPassword(env: Env, code: string): boolean {
  return !!(env.OWNER_TOKEN && safeEqual(code, env.OWNER_TOKEN));
}


function adminFailKey(ip: string): string {
  return `${ADMIN_FAIL_PREFIX}${ip.replace(/[^\w.\-:@]+/g, '_').slice(0, 64) || 'anon'}`;
}
function adminLockKey(ip: string): string {
  return `${ADMIN_LOCK_PREFIX}${ip.replace(/[^\w.\-:@]+/g, '_').slice(0, 64) || 'anon'}`;
}
export function adminSessionKey(token: string): string {
  return `${ADMIN_SESSION_PREFIX}${token}`;
}

/** 记录一次后台登录失败；返回自窗口内累计失败次数。Redis 异常时返回 0（不阻断流程） */
export async function recordAdminLoginFailure(redis: Redis, ip: string): Promise<number> {
  try {
    const key = adminFailKey(ip);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ADMIN_FAIL_WINDOW_SEC);
    return n;
  } catch (err) {
    console.error('recordAdminLoginFailure failed:', err);
    return 0;
  }
}

/** 来源 IP 是否已被冻结 */
export async function isAdminLocked(redis: Redis, ip: string): Promise<boolean> {
  try {
    return !!(await redis.get(adminLockKey(ip)));
  } catch (err) {
    console.error('isAdminLocked failed:', err);
    return false;
  }
}

/** 超过阈值则临时冻结该来源 IP（仅当失败次数达到阈值后调用） */
export async function lockAdminSource(redis: Redis, ip: string): Promise<void> {
  try {
    await redis.set(adminLockKey(ip), '1', { ex: ADMIN_LOCK_WINDOW_SEC });
  } catch (err) {
    console.error('lockAdminSource failed:', err);
  }
}

/** 登录成功：清空失败计数与冻结标记 */
export async function clearAdminFailures(redis: Redis, ip: string): Promise<void> {
  try {
    await redis.del(adminFailKey(ip));
    await redis.del(adminLockKey(ip));
  } catch (err) {
    console.error('clearAdminFailures failed:', err);
  }
}

/** 发放短期会话令牌（登录成功调用）。返回 { ok, token }；Redis 写入失败时 ok=false，调用方应视为登录失败（503），避免发一个不可用的死令牌 */
export async function createAdminSession(
  redis: Redis,
  adminLabel: string,
  ip: string,
  ttlSec: number,
  role: AdminRole = 'admin'
): Promise<{ ok: boolean; token: string }> {
  const token = crypto.randomUUID();
  try {
    await redis.set(
      adminSessionKey(token),
      JSON.stringify({ admin: adminLabel, ip, role, created_at: new Date().toISOString() }),
      { ex: ttlSec }
    );
  } catch (err) {
    console.error('createAdminSession set failed:', err);
    return { ok: false, token };
  }
  return { ok: true, token };
}

/** 升级/变更当前会话的角色（站长认证成功后调用）。保留 TTL。 */
export async function setAdminSessionRole(redis: Redis, token: string, role: AdminRole): Promise<boolean> {
  if (!token) return false;
  try {
    const key = adminSessionKey(token);
    const raw = await redis.get<string | Record<string, unknown>>(key);
    if (!raw) return false;
    // Upstash 客户端默认开启 automaticDeserialization：JSON 字符串读回时已被解析成对象。
    // 因此这里必须兼容“已是对象”的情况，否则 JSON.parse(object) 会抛错导致会话判定失败。
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    parsed.role = role;
    parsed.role_updated_at = new Date().toISOString();
    // 保留剩余 TTL：重新 set 时 TTL 会丢失，故读取剩余时间后再写回
    let ttl: number | undefined;
    try { ttl = await redis.ttl(key); } catch { ttl = undefined; }
    const ex = typeof ttl === 'number' && ttl > 0 ? ttl : 2 * 3600;
    await redis.set(key, JSON.stringify(parsed), { ex });
    return true;
  } catch (err) {
    console.error('setAdminSessionRole failed:', err);
    return false;
  }
}

/** 校验会话令牌；有效返回 { ok:true, admin, ip, role }，否则 { ok:false } */
export async function resolveAdminSession(
  redis: Redis,
  token: string
): Promise<{ ok: true; admin: string; ip: string; role: AdminRole } | { ok: false }> {
  if (!token) return { ok: false };
  try {
    const raw = await redis.get<string | Record<string, unknown>>(adminSessionKey(token));
    if (!raw) return { ok: false };
    // 兼容 Upstash 自动反序列化：读回的 JSON 可能已是对象（见 setAdminSessionRole 注释）。
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    const role: AdminRole = parsed?.role === 'owner' ? 'owner' : 'admin';
    return { ok: true, admin: String(parsed?.admin || 'admin'), ip: String(parsed?.ip || ''), role };
  } catch (err) {
    console.error('resolveAdminSession failed:', err);
    return { ok: false };
  }
}

/** 注销会话（退出登录） */
export async function revokeAdminSession(redis: Redis, token: string): Promise<void> {
  try {
    await redis.del(adminSessionKey(token));
  } catch (err) {
    console.error('revokeAdminSession failed:', err);
  }
}

/** 校验用户输入的 6 位 TOTP 动态码（带 ±1 时间窗容错）。返回 { ok, requiresTotp } */
export async function verifyAdminTotp(env: Env, code: string): Promise<{ ok: boolean; requiresTotp: boolean }> {
  if (!env.ADMIN_TOTP_SECRET) {
    // 未配置二次验证密钥：退化为"无需动态码"
    return { ok: true, requiresTotp: false };
  }
  const valid = await verifyTotp(env.ADMIN_TOTP_SECRET, code);
  return { ok: valid, requiresTotp: true };
}