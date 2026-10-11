#!/usr/bin/env bash
#
# APEXON Worker 一键部署脚本（Cloudflare Workers + Hono）
# ------------------------------------------------------------
# 用法：
#   ./deploy.sh                 安装依赖 → 类型检查 → 上传密钥 → 部署
#   ./deploy.sh --check         仅构建校验（wrangler deploy --dry-run，不发布）
#   ./deploy.sh --skip-secrets  跳过密钥上传（密钥已在 Cloudflare 配置好时）
#   ./deploy.sh --with-git      部署成功后额外 commit + push 当前 git 变更
#   ./deploy.sh -h              查看帮助
#
# 认证（切勿把令牌写进代码库！）：
#   CLOUDFLARE_API_TOKEN   Cloudflare API 令牌（Workers Scripts 编辑权限）
#                          可放环境变量，或放进 .dev.vars（本脚本会自动读取）
#   CLOUDFLARE_ACCOUNT_ID  可选，账号下存在多个账户时需要
#
# 密钥文件（按优先级自动选择，均已在 .gitignore 中）：
#   secrets.json   JSON 形式 {"KEY":"VALUE"}，支持用 null 删除密钥
#   .dev.vars      KEY=VALUE 形式；上报时会自动剔除 CLOUDFLARE_* 等本地专用键
# ------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

CHECK_ONLY=0
SKIP_SECRETS=0
WITH_GIT=0
for arg in "$@"; do
  case "$arg" in
    --check)        CHECK_ONLY=1 ;;
    --skip-secrets) SKIP_SECRETS=1 ;;
    --with-git)     WITH_GIT=1 ;;
    -h|--help)      sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（使用 -h 查看帮助）" >&2; exit 2 ;;
  esac
done

# ---- 彩色日志 ----
if [ -t 1 ]; then B=$'\033[1;36m'; G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; N=$'\033[0m'
else B=; G=; Y=; R=; N=; fi
log(){  printf '%s▶ %s%s\n' "$B" "$*" "$N"; }
ok(){   printf '%s✔ %s%s\n' "$G" "$*" "$N"; }
warn(){ printf '%s! %s%s\n' "$Y" "$*" "$N" >&2; }
die(){  printf '%s✖ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ---- 载入本地变量（含 CLOUDFLARE_API_TOKEN，便于非交互部署）----
if [ -f .dev.vars ]; then
  log "载入本地变量 .dev.vars"
  set -a
  # shellcheck disable=SC1091
  . ./.dev.vars
  set +a
fi

# ---- 前置检查 ----
command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 18+"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  warn "未检测到 CLOUDFLARE_API_TOKEN：wrangler 将改用已登录的 OAuth 凭据（npx wrangler login）"
fi
WRANGLER="npx --yes wrangler"

# ---- 1) 安装依赖 ----
if [ -f package-lock.json ]; then
  log "安装依赖（npm ci）"; npm ci
else
  log "安装依赖（npm install）"; npm install
fi

# ---- 2) 类型检查 ----
log "类型检查（tsc --noEmit）"
npm run typecheck
ok "类型检查通过"

# ---- 3) 仅构建校验则到此为止 ----
if [ "$CHECK_ONLY" = "1" ]; then
  log "构建校验（wrangler deploy --dry-run）"
  $WRANGLER deploy --dry-run --outdir dist
  ok "构建校验通过（未发布）"
  exit 0
fi

# ---- 4) 上传密钥 ----
if [ "$SKIP_SECRETS" = "0" ]; then
  SECRETS_FILE=""
  if [ -f secrets.json ]; then
    SECRETS_FILE="secrets.json"
  elif [ -f .dev.vars ]; then
    # 剔除本地专用键（部署令牌、本地放行开关），避免误传为线上 Worker 密钥
    SECRETS_FILE="$(mktemp)"
    trap 'rm -f "$SECRETS_FILE"' EXIT
    grep -vE '^[[:space:]]*(#|$)' .dev.vars \
      | grep -vE '^[[:space:]]*(CLOUDFLARE_[A-Z_]+|ALLOW_LOCALHOST_ORIGIN)[[:space:]]*=' \
      > "$SECRETS_FILE" || true
  fi

  if [ -n "$SECRETS_FILE" ]; then
    log "上传密钥（wrangler secret bulk）"
    $WRANGLER secret bulk "$SECRETS_FILE"
    ok "密钥已上传"
  else
    warn "未找到 secrets.json / .dev.vars，跳过密钥上传"
  fi

  if [ ! -f secrets.json ] && [ -f .dev.vars ] && grep -qiE '^[[:space:]]*ADMIN_TOKEN[[:space:]]*=' .dev.vars; then
    warn "建议设置 ADMIN_TOTP_SECRET 开启登录双重验证（口令 + 6 位动态码）"
  fi
fi

# ---- 5) 部署 ----
log "部署到 Cloudflare Workers（wrangler deploy）"
$WRANGLER deploy
ok "部署完成"

# ---- 6) 可选：提交并推送 git ----
if [ "$WITH_GIT" = "1" ]; then
  log "提交并推送 git 变更"
  git add -A
  if git diff --cached --quiet; then
    warn "无变更可提交，跳过 git"
  else
    git commit -m "chore: deploy $(date '+%Y-%m-%d %H:%M:%S')"
    git push
    ok "git 已推送"
  fi
fi
