/**
 * 成绩发布订阅与邮件提醒。
 *
 * 用户在自身资料里绑定邮箱后，可订阅「某类测试 / 全部」的成绩发布通知；
 * 当教师批量发布成绩（成绩导入）或后台手动发起发布通知时，向对应订阅者发邮件。
 *
 * 存储：mixed_data type='subscription'，user_id=订阅者；payload 每次整体覆盖（幂等 upsert）。
 * 依赖 services/email.ts 的供应商无关发信，未配置 MAIL_API_KEY 时静默跳过（不阻塞任何流程）。
 */

import type { ShardService } from './shard';
import type { MixedData } from '../types/models';
import { emailConfig, sendMail } from './email';

export interface SubscriptionView {
  user_id: string;
  email: string;
  test_type: string;   // '' 表示订阅全部
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const TEST_ANY = '';

function safeParse(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

export function flattenSubscription(r: MixedData): SubscriptionView {
  const p = safeParse(r.payload);
  return {
    user_id: r.user_id,
    email: typeof p.email === 'string' ? p.email : '',
    test_type: typeof p.test_type === 'string' ? p.test_type : '',
    enabled: p.enabled !== false,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * upsert 订阅。一条用户同时只保留一条 subscription 记录（test_type 与 enabled 覆盖即得）。
 * 返回 { ok } 或 { ok:false, error }。
 */
export async function setSubscription(
  shard: ShardService,
  userId: string,
  email: string,
  testType: string,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  const normType = testType ? testType.trim().slice(0, 40) : TEST_ANY;
  const existingRows = await shard.readByUserAndType(userId, 'subscription', 10);
  const existing = existingRows[0];
  const now = new Date().toISOString();
  const payload = JSON.stringify({ email: email.slice(0, 120), test_type: normType, enabled, updated_at: now });

  const writeResult = await shard.write(
    {
      id: existing ? existing.id : crypto.randomUUID(),
      user_id: userId,
      type: 'subscription',
      subtype: normType || null,
      score_value: null,
      payload,
      file_url: null,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    },
    {}
  );
  if (!writeResult.ok) return { ok: false, error: writeResult.error };
  // 若曾存在旧记录则删除（保证单条）
  if (existing) {
    for (const ex of existingRows) {
      if (ex.id !== existing.id) await shard.deleteById(ex.id);
    }
  }
  return { ok: true };
}

/** 用户自己的订阅（至多一条） */
export async function readMySubscription(shard: ShardService, userId: string): Promise<SubscriptionView | null> {
  const rows = await shard.readByUserAndType(userId, 'subscription', 10);
  return rows[0] ? flattenSubscription(rows[0]) : null;
}

/**
 * 收集某 test_type 的启用订阅者（test_type 精确匹配或订阅了 all=''）。
 * 排除无有效邮箱的。返回去重后的 { userId, email }[]。
 */
export async function subscribersForType(shard: ShardService, testType: string, limit = 1000): Promise<Array<{ userId: string; email: string }>> {
  const rows = await shard.readByType('subscription', { limit });
  const out: Array<{ userId: string; email: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const s = flattenSubscription(r);
    if (!s.enabled) continue;
    if (testType && s.test_type && s.test_type !== testType) continue;
    const email = s.email.trim();
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ userId: s.user_id, email });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 发送一次"成绩发布"邮件通知给指定订阅者。
 * - 发件走 sendMail（fire-and-forget 该函数内部自带超时，但这里逐个 await 聚合结果）。
 * - 未配置邮件则返回 { sent:0, configured:false }，不报错。
 */
export async function sendPublishNotification(
  env: { MAIL_PROVIDER?: string; MAIL_API_KEY?: string; MAIL_FROM?: string; NOTIFY_PUBLIC_URL?: string },
  subscribers: Array<{ userId: string; email: string }>,
  testType: string,
  subject?: string,
  message?: string
): Promise<{ sent: number; configured: boolean }> {
  const cfg = emailConfig(env);
  if (!cfg) return { sent: 0, configured: false };
  if (!subscribers.length) return { sent: 0, configured: true };

  const typeLabel = testType ? `「${testType}」` : '全部';
  const title = subject && subject.trim() ? subject.trim().slice(0, 120) : `APEXON 新成绩已发布${typeLabel}`;
  const publicUrl = typeof env.NOTIFY_PUBLIC_URL === 'string' ? env.NOTIFY_PUBLIC_URL : '';
  const bodyText = (message && message.trim() ? message.trim() : `你订阅的${typeLabel}测试有新的成绩发布了，快来查看你的名次与详情。`).slice(0, 2000);

  let sent = 0;
  for (const sub of subscribers) {
    const html = buildEmailHtml(title, bodyText, typeLabel, publicUrl);
    const ok = await sendMail(cfg, sub.email, title, html, `${bodyText}\n${publicUrl ? '查看：' + publicUrl : ''}`);
    if (ok.ok) sent += 1;
    // 控制并发，避免打爆发信服务的免费额度
    await new Promise((r) => setTimeout(r, 120));
  }
  return { sent, configured: true };
}

function buildEmailHtml(title: string, body: string, typeLabel: string, publicUrl: string): string {
  const link = publicUrl
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(publicUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">前往排行榜查看</a></p>`
    : '';
  return `<!DOCTYPE html><html lang="zh-CN"><body style="margin:0;background:#f5f6fa;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
    <h2 style="margin:0 0 6px;color:#111827">${escapeHtml(title)}</h2>
    <p style="color:#9ca3af;margin:0 0 16px;font-size:13px">APEXON · 成绩发布提醒</p>
    <p style="color:#374151;line-height:1.7;margin:0">${escapeHtml(body)}</p>
    ${link}
  </div></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}