export interface Env {
  // NEON_DSN 已注释掉，改为可选（仅使用 3 个 Turso 数据库）
  NEON_DSN?: string;

  TURSO_URL_APEXON: string;
  TURSO_TOKEN_APEXON: string;

  TURSO_URL_APEXON_1: string;
  TURSO_TOKEN_APEXON_1: string;

  TURSO_URL_APEXON_2: string;
  TURSO_TOKEN_APEXON_2: string;

  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Postgres connection string for Supabase SQL (已注释掉，改为可选).
  SUPABASE_DSN?: string;

  UPSTASH_REDIS_URL: string;
  UPSTASH_REDIS_TOKEN: string;

  // 管理接口（/api/admin/*）的访问令牌；未配置时管理接口直接禁用
  ADMIN_TOKEN?: string;

  // （可选）TOTP 双重验证密钥（Base32 编码，如 AAAA-BBBB-CCCC）。
  // 配置后，后台登录必须同时通过「口令 + 6 位动态码」双因素校验才发放会话令牌，
  // 可配合 Google Authenticator / 1Password / Authy 等 TOTP 验证器使用。
  // 未配置时退回「仅口令」模式（推荐始终配置）。
  ADMIN_TOTP_SECRET?: string;

  // 后台短时会话有效期（秒）。会话令牌发放后，接口一律只认会话令牌，
  // 不再直接校验 ADMIN_TOKEN，确保拿到口令也无法绕过双重验证。
  ADMIN_SESSION_TTL_SEC?: number;

  // 安全告警外发通知的 webhook 地址（可选）。配置后，暴破/异常告警会 POST 到该地址，
  // 可用于接机器人通知（如飞书/企业微信/钉钉/自建服务）。留空则仅面板内留痕、不外发。
  ADMIN_ALERT_WEBHOOK?: string;
}
