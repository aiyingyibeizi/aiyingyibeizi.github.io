export interface Env {
  NEON_DSN: string;

  TURSO_URL_APEXON: string;
  TURSO_TOKEN_APEXON: string;

  TURSO_URL_APEXON_1: string;
  TURSO_TOKEN_APEXON_1: string;

  TURSO_URL_APEXON_2: string;
  TURSO_TOKEN_APEXON_2: string;

  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Postgres connection string for Supabase SQL (required by pg).
  SUPABASE_DSN: string;

  UPSTASH_REDIS_URL: string;
  UPSTASH_REDIS_TOKEN: string;
}
