/**
 * 邮件发送 —— 供应商无关封装（验证码 / 通知等事务邮件）。
 *
 * 通过环境变量切换厂商，零代码改动：
 *   - MAIL_PROVIDER = 'brevo' （默认）｜ 免费 300 封/天，约 9000 封/月，无需沙箱审批
 *   - MAIL_PROVIDER = 'resend' ｜ 免费 3000 封/月但每天硬限 100 封
 *   - MAIL_API_KEY / MAIL_FROM（发件人，如 "APEXON <noreply@example.com>"）
 *
 * 一律 fire-and-forget 风格 + 超时，任何失败只记日志、绝不抛给调用方。
 * 未配置 MAIL_API_KEY 时返回 false（调用方据此回退/提示）。
 */

export interface EmailConfig {
  provider: string;
  apiKey: string;
  from: string;
}

export function emailConfig(env: {
  MAIL_PROVIDER?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM?: string;
}): EmailConfig | null {
  const apiKey = env.MAIL_API_KEY;
  if (!apiKey) return null;
  const provider = (env.MAIL_PROVIDER || 'brevo').trim().toLowerCase();
  return {
    provider,
    apiKey,
    from: env.MAIL_FROM || 'APEXON <noreply@apexon.qzz.io>',
  };
}

/**
 * 发送一封事务邮件。返回 true 表示已提交发送；false 表示未配置或请求失败。
 * 不做重试（验证码类短时效，浪费重试无意义），由上抛给调用方判断。
 */
export async function sendMail(
  cfg: EmailConfig,
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<boolean> {
  try {
    const body = cfg.provider === 'resend'
      ? buildResend(cfg, to, subject, html, text)
      : buildBrevo(cfg, to, subject, html, text);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(body.url, {
        method: 'POST',
        headers: body.headers,
        body: JSON.stringify(body.payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`sendMail non-2xx (${cfg.provider}):`, res.status);
        return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error('sendMail failed:', err);
    return false;
  }
}

/** Brevo：POST /v3/smtp/email，鉴权头 api-key */
function buildBrevo(
  cfg: EmailConfig,
  to: string,
  subject: string,
  html: string,
  text: string
): { url: string; headers: Record<string, string>; payload: unknown } {
  const [name, email] = splitFrom(cfg.from);
  return {
    url: 'https://api.brevo.com/v3/smtp/email',
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    payload: {
      sender: { name, email },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    },
  };
}

/** Resend：POST /emails，鉴权头 Authorization: Bearer */
function buildResend(
  cfg: EmailConfig,
  to: string,
  subject: string,
  html: string,
  text: string
): { url: string; headers: Record<string, string>; payload: unknown } {
  return {
    url: 'https://api.resend.com/emails',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    payload: { from: cfg.from, to: [to], subject, html, text },
  };
}

/** 解析 "Name <email>" → [Name, email]，无 Name 时 name 为空串 */
function splitFrom(from: string): [string, string] {
  const m = /^(.*?)\s*<([^>]+)>$/.exec(from.trim());
  return m ? [m[1].trim(), m[2].trim()] : ['', from.trim()];
}