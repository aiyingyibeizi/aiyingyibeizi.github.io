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
}
