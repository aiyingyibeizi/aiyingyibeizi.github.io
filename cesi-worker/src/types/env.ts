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

  // 邮箱验证码登录/注册（可选）。
  // MAIL_PROVIDER 支持 'brevo'（默认）| 'resend'；未配置 MAIL_API_KEY 时邮箱相关接口整体禁用。
  MAIL_PROVIDER?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM?: string;

  // 异地登录提醒开关：登录来源 IP 与上次不同时，推送通知到 ADMIN_ALERT_WEBHOOK（可选，默认开启）。
  GEO_DIFF_LOGIN_NOTIFY?: string;

  // ===== 登录安全再加固 =====
  // 算数验证码（CAPTCHA）：
  //   APEXON_CAPTCHA_ALWAYS   = 'on' 时，密码登录一律要求先过验证码（默认 off，平时不打扰）；
  //   CAPTCHA_REQUIRE_AFTER_FAIL = 该 IP 累计失败达到此值后，要求填验证码（默认 3）。
  CAPTCHA_ALWAYS?: string;
  CAPTCHA_REQUIRE_AFTER_FAIL?: number;
  // 累积式 IP 黑名单：
  //   IP_BLACKLIST_THRESHOLD      默认 20（窗口内累计失败次数）
  //   IP_BLACKLIST_WINDOW_SEC     默认 3600（计数窗口秒）
  //   IP_BLACKLIST_DURATION_SEC   默认 86400（拉黑时长秒）
  IP_BLACKLIST_THRESHOLD?: number;
  IP_BLACKLIST_WINDOW_SEC?: number;
  IP_BLACKLIST_DURATION_SEC?: number;

  // ===== 成绩发布订阅邮件 =====
  // 成绩发布通知链接（可选）：放在提醒邮件里引导用户去看排行榜。
  NOTIFY_PUBLIC_URL?: string;
  // 班级成绩 CSV 单次导入上限行数（默认 1000，防超大文件拖垮 Worker）。
  IMPORT_MAX_ROWS?: number;

  // ===== 内容反垃圾 =====
  // CONTENT_FILTER = 'off' 时关闭评论/反馈的内容检测（默认开启）。
  // 硬命中（广告/外链/危险内容）直接拦截；软命中（无意义刷屏）照常保存并打标记，由客户端过滤显示。
  CONTENT_FILTER?: string;

  // ===== 可观测性 =====
  // OBSERVABILITY_SAMPLE 访问日志采样率 0~1（默认 0，即关闭），>0 时按比例输出结构化访问日志。
  // OBSERVABILITY_WEBHOOK 可选：接口未捕获错误时 POST 到该地址便于告警（默认不启用）。
  OBSERVABILITY_SAMPLE?: number;
  OBSERVABILITY_WEBHOOK?: string;

  // 榜单快照单题型保留名次数（默认 20，仅影响快照体积，不改变在线排行榜）。
  SNAPSHOT_TOP_N?: number;
}
