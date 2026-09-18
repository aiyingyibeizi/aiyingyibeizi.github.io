import type { Env } from '../types/env';
import type { MixedData } from '../types/models';
import type { ShardService } from './shard';

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
  banned: boolean;
  banned_reason: string | null;
  account_created_at: string | null;
  profile: any | null;
  score_count: number;
  comment_count: number;
  feedback_count: number;
  online_last_seen: string | null;
  recent_scores: MixedData[];
}> {
  const account = (await shard.readByUserAndType(userId, 'account', 10))[0];
  const profiles = await shard.readByUserAndType(userId, 'profile', 1);
  const scores = await shard.readByUserAndType(userId, 'score', 200);
  const comments = await shard.readByUserAndType(userId, 'comment', 1000);
  const feedback = await shard.readByUserAndType(userId, 'feedback', 1000);
  const online = (await shard.readByUserAndType(userId, 'online', 1))[0];

  const accountInfo = account ? flattenAccount(account) : null;
  const onlineLast = online ? safeJsonParse(online.payload).last_seen || online.updated_at : null;

  return {
    user_id: userId,
    username: accountInfo?.username || (profiles[0] ? safeJsonParse(profiles[0].payload).username : userId),
    banned: accountInfo?.banned ?? false,
    banned_reason: accountInfo?.banned_reason ?? null,
    account_created_at: account ? account.created_at : null,
    profile: profiles[0] ? safeJsonParse(profiles[0].payload) : null,
    score_count: scores.length,
    comment_count: comments.length,
    feedback_count: feedback.length,
    online_last_seen: onlineLast || null,
    recent_scores: scores.slice(0, 20),
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