# cesi-worker

Cloudflare Workers + Hono + TypeScript 后端服务，支持多数据库写入分片、 fan-out 读取、Supabase Auth 校验以及 Supabase Storage 文件上传。

## 技术栈

- [Cloudflare Workers](https://workers.cloudflare.com/) — 部署目标
- [Hono](https://hono.dev/) — Web 框架
- [TypeScript](https://www.typescriptlang.org/)
- [@libsql/client](https://github.com/tursodatabase/libsql-client-ts) — Turso (SQLite)
- [pg](https://node-postgres.com/) — Neon / Supabase SQL (PostgreSQL)
- [@supabase/supabase-js](https://github.com/supabase/supabase-js) — Auth + Storage
- [@upstash/redis](https://github.com/upstash/upstash-redis) — 缓存与原子计数

## 项目结构

```
src/
  index.ts              # Hono 入口：路由 + 中间件
  db/
    turso.ts            # Turso 客户端工厂 + 查询辅助
    neon.ts             # Neon pg Pool 工厂 + 查询辅助
    supabase-pg.ts      # Supabase SQL via pg Pool 工厂 + 查询辅助
    redis.ts            # Upstash Redis 工厂
  services/
    auth.ts             # Supabase Auth JWT 校验中间件
    shard.ts            # 基于优先级的写入分片服务
    storage.ts          # Supabase Storage 上传辅助
  types/
    env.ts              # 环境变量类型
    models.ts           # MixedData / Meta / DbConfig 类型
sql/
  init-turso.sql        # Turso (SQLite) 建表脚本
  init-postgres.sql     # Neon + Supabase SQL (PostgreSQL) 建表脚本
wrangler.toml           # 配置模板（占位符）
```

## 前置准备

1. 安装依赖：

```bash
cd /workspace/cesi-worker
npm install
```

2. 登录 Wrangler 并绑定 Cloudflare 账户：

```bash
npx wrangler login
```

3. 准备以下外部服务：
   - **Turso**：3 个数据库（APEXON、APEXON_1、APEXON_2），分别运行 `sql/init-turso.sql`。
   - **Neon**：一个 PostgreSQL 数据库，运行 `sql/init-postgres.sql`。
   - **Supabase**：
     - 创建 PostgreSQL 数据库并运行 `sql/init-postgres.sql`。
     - 在 Storage 中创建名为 `files` 的公开 bucket。
   - **Upstash Redis**：创建一个 Redis 数据库并获取 REST URL + Token。

## 环境变量

所有环境变量均通过 `c.env` 读取，代码中没有任何硬编码凭据。

编辑 `wrangler.toml`，将占位符替换为你的真实值。敏感变量建议通过 `wrangler secret put` 设置。

```toml
[vars]
NEON_DSN = "postgresql://user:pass@host.neon.tech/db?sslmode=require"
SUPABASE_DSN = "postgresql://postgres:pass@db.project.supabase.co:5432/postgres"
TURSO_URL_APEXON = "libsql://..."
TURSO_TOKEN_APEXON = "..."
TURSO_URL_APEXON_1 = "libsql://..."
TURSO_TOKEN_APEXON_1 = "..."
TURSO_URL_APEXON_2 = "libsql://..."
TURSO_TOKEN_APEXON_2 = "..."
SUPABASE_URL = "https://project.supabase.co"
UPSTASH_REDIS_URL = "https://..."
```

敏感变量（推荐用 secret put）：

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put UPSTASH_REDIS_TOKEN
```

> 注意：`SUPABASE_DSN` 是 Supabase Postgres 的直接连接字符串，与 `SUPABASE_URL` 不同，项目已将它加入 `Env` 类型与 `wrangler.toml` 模板。

## 数据库初始化

### Turso

对每个 Turso 数据库执行：

```bash
turso db shell <db-name> < sql/init-turso.sql
```

或分别在 Turso Dashboard / CLI 中执行 `sql/init-turso.sql` 内容。

### Neon + Supabase SQL

在各自的 SQL 编辑器或 psql 中执行：

```bash
psql "$NEON_DSN" -f sql/init-postgres.sql
psql "$SUPABASE_DSN" -f sql/init-postgres.sql
```

## 本地开发

```bash
npm run dev
```

服务默认在 `http://localhost:8787` 启动。

## 部署

```bash
npm run deploy
```

## API

### 健康检查

```bash
GET /
# { "status": "ok" }
```

### 写入数据

```bash
POST /api/data
Authorization: Bearer <supabase-jwt>
Content-Type: application/json

{
  "type": "note",
  "payload": { "content": "hello" },
  "file_url": "https://..." // optional
}
```

响应：

```json
{ "id": "uuid", "db": "turso_apexon" }
```

如果所有数据库已满，返回 `507 Insufficient Storage`。

### Fan-out 读取数据

```bash
GET /api/data
Authorization: Bearer <supabase-jwt>
```

并发查询 5 个数据库，合并后按 `created_at` 倒序，默认返回 100 条。单个数据库失败会被记录并忽略，返回部分数据。

### 上传文件

```bash
POST /api/upload
Authorization: Bearer <supabase-jwt>
Content-Type: multipart/form-data

file: <binary>
```

响应：

```json
{ "url": "https://project.supabase.co/storage/v1/object/public/files/{userId}/{timestamp}-{filename}" }
```

## 分片策略

写入优先级：

1. Turso APEXON (8 GB)
2. Turso APEXON_1 (8 GB)
3. Turso APEXON_2 (8 GB)
4. Neon (0.5 GB)
5. Supabase SQL (500 MB)

写入前通过 Redis `used_bytes:{db_name}` 检查容量；Redis 缺失时回退到 `meta` 表。写入成功后使用 Redis `INCRBY` 原子更新已用容量，并异步更新 `meta` 表。

## 类型检查

```bash
npm run typecheck
```
