/**
 * APEXON Weather - Supabase 客户端封装
 *
 * 设计目标：
 * 1. 纯前端、无打包器，仅在「已配置 Supabase URL」时才按需动态加载官方 SDK。
 * 2. 未配置 / 无网络 / 未登录时，所有导出函数都安全返回 null 或 false，绝不抛异常。
 * 3. 每日额度由服务端 Edge Function 强制，客户端只做展示：
 *    游客 5000 次/天（按设备计数），登录用户 20000 次/天（按用户计数）。
 *    额度信息直接读代理响应头（X-RateLimit-*），游客无需任何数据库读权限。
 *    上限已大幅放开（等价于取消限制），正常使用永远触达不到。
 */

import { CONFIG } from './config.js';

// 每日调用上限（与 supabase/functions/weather-proxy/index.ts 保持一致）
const GUEST_DAILY_LIMIT = CONFIG.guestDailyLimit || 5000;
const USER_DAILY_LIMIT = CONFIG.userDailyLimit || 20000;

// 上次成功请求带回的额度快照（按 UTC 日切分，与数据库 date 列对齐）
const QUOTA_KEY = 'apexon_quota_snapshot';

// SDK 懒加载缓存：undefined = 尚未尝试；null = 加载失败（不再重试）；其他 = 已加载的 createClient
let _createClient = undefined;
// 单例客户端
let _client = null;
// 初始化 Promise，避免并发重复初始化
let _initPromise = null;

/**
 * 判断是否已完成 Supabase 配置。
 * @returns {boolean}
 */
export function isSupabaseConfigured() {
  return Boolean(CONFIG && CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
}

/**
 * 动态加载 @supabase/supabase-js，失败时静默返回 null。
 * @returns {Promise<Function|null>} createClient 工厂函数
 */
async function loadCreateClient() {
  if (_createClient !== undefined) return _createClient;
  try {
    // 仅在此处使用动态 import，且只在已配置时才尝试
    const mod = await import('https://esm.sh/@supabase/supabase-js@2');
    _createClient = mod && mod.createClient ? mod.createClient : null;
  } catch (err) {
    // 离线 / CDN 不可达 / 模块解析失败：降级，不抛出
    console.warn('[supabase] SDK 加载失败，已降级为直连模式', err);
    _createClient = null;
  }
  return _createClient;
}

/**
 * 初始化 Supabase 客户端（幂等）。未配置或加载失败时返回 null。
 * @returns {Promise<object|null>} Supabase 客户端实例
 */
export async function initSupabase() {
  if (!isSupabaseConfigured()) return null;
  if (_client) return _client;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const createClient = await loadCreateClient();
      if (!createClient) return null;
      _client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
      return _client;
    } catch (err) {
      console.warn('[supabase] 初始化失败，已降级为直连模式', err);
      _client = null;
      return null;
    }
  })();

  return _initPromise;
}

/**
 * 同步获取已初始化的客户端（未初始化时为 null，不会触发加载）。
 * @returns {object|null}
 */
export function getSupabase() {
  return _client;
}

/**
 * 订阅认证状态变化。未配置时返回空操作并立即回调 null。
 * @param {(session: object|null) => void} cb
 * @returns {Function} 取消订阅函数（未配置时为空函数）
 */
export function onAuthStateChange(cb) {
  const noop = () => {};
  if (typeof cb !== 'function') return noop;
  if (!isSupabaseConfigured()) {
    // 异步回调一次 null，保证调用方状态机不会卡住
    Promise.resolve().then(() => {
      try { cb(null); } catch (_) { /* 忽略回调异常 */ }
    });
    return noop;
  }

  let unsubscribe = noop;
  // 客户端可能是异步初始化的，这里等到就绪后再注册
  initSupabase().then((client) => {
    if (!client || !client.auth || typeof client.auth.onAuthStateChange !== 'function') {
      try { cb(null); } catch (_) { /* 忽略 */ }
      return;
    }
    try {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        try { cb(session || null); } catch (_) { /* 忽略回调异常 */ }
      });
      if (data && typeof data.subscription !== 'undefined' && data.subscription) {
        unsubscribe = () => {
          try { data.subscription.unsubscribe(); } catch (_) { /* 忽略 */ }
        };
      }
    } catch (err) {
      console.warn('[supabase] 订阅认证状态失败', err);
    }
  }).catch(() => { /* 已在 initSupabase 内处理 */ });

  return () => unsubscribe();
}

/**
 * 获取当前会话。未配置 / 未登录 / 出错时返回 null。
 * @returns {Promise<object|null>}
 */
export async function getSession() {
  try {
    const client = await initSupabase();
    if (!client || !client.auth) return null;
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    return (data && data.session) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 获取当前用户。未登录时返回 null。
 * @returns {Promise<object|null>}
 */
export async function getUser() {
  try {
    const client = await initSupabase();
    if (!client || !client.auth) return null;
    const { data, error } = await client.auth.getUser();
    if (error) return null;
    return (data && data.user) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 使用 GitHub OAuth 登录。未配置时返回 null。
 * @param {string} [redirectTo] 登录后跳转地址，默认回当前页面
 * @returns {Promise<object|null>} 数据对象，或 null
 */
export async function signInWithGitHub(redirectTo) {
  try {
    const client = await initSupabase();
    if (!client || !client.auth) return null;
    const target = redirectTo || (typeof window !== 'undefined' ? window.location.href : undefined);
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'github',
      options: target ? { redirectTo: target } : undefined,
    });
    if (error) return null;
    return data || null;
  } catch (_) {
    return null;
  }
}

/**
 * 退出登录。未配置时返回 false。
 * @returns {Promise<boolean>}
 */
export async function signOut() {
  try {
    const client = await initSupabase();
    if (!client || !client.auth) return false;
    const { error } = await client.auth.signOut();
    return !error;
  } catch (_) {
    return false;
  }
}

/* -------------------------------------------------------------
   每日额度：数据来自代理响应头，游客与登录用户共用同一套读取逻辑
   ------------------------------------------------------------- */

let _quota = null;

function saveQuota(quota) {
  _quota = quota;
  try {
    localStorage.setItem(QUOTA_KEY, JSON.stringify(quota));
  } catch (_) {
    // 隐私模式 / 存储满：仅内存生效
  }
}

function readStoredQuota() {
  try {
    const raw = localStorage.getItem(QUOTA_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // 跨天即失效，保证第二天看到的是全新额度
    if (!parsed || parsed.day !== todayStr()) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * 从代理响应头记录额度快照。纯本地写入，不产生任何额外请求。
 * @param {Headers} headers fetch Response.headers
 */
export function recordQuotaFromHeaders(headers) {
  try {
    if (!headers || typeof headers.get !== 'function') return;
    const limit = Number(headers.get('X-RateLimit-Limit'));
    const used = Number(headers.get('X-RateLimit-Used'));
    if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return;
    const tier = headers.get('X-RateLimit-Tier') || 'guest';
    saveQuota({
      used,
      limit,
      remaining: Math.max(0, limit - used),
      tier,
      day: todayStr(),
    });
  } catch (_) {
    // 忽略：额度展示失败不应影响主流程
  }
}

/** 最近一次拿到的额度快照（跨天后自动失效，取不到时返回 null）。 */
export function getQuota() {
  if (_quota && _quota.day === todayStr()) return _quota;
  _quota = readStoredQuota();
  return _quota;
}

/** 额度是否已用尽（含服务端明确返回 429 后的本地标记）。 */
export function isQuotaExhausted() {
  const quota = getQuota();
  return Boolean(quota && quota.remaining <= 0);
}

/** 服务端返回 429 时调用：立即把本地快照标记为已用尽，避免继续无效请求。 */
export function markQuotaExhausted() {
  const quota = getQuota();
  const limit = quota ? quota.limit : USER_DAILY_LIMIT;
  saveQuota({
    used: limit,
    limit,
    remaining: 0,
    tier: quota ? quota.tier : 'guest',
    day: todayStr(),
  });
}

/**
 * 读取今日用量。登录用户优先读数据库（含其他设备的调用），
 * 游客直接返回本地快照（无数据库读权限，也不需要）。
 * @returns {Promise<{used:number, limit:number, remaining:number, tier:string, day:string}|null>}
 */
export async function fetchUsage() {
  const local = getQuota();
  try {
    const client = await initSupabase();
    if (!client) return local;
    const user = await getUser();
    if (!user) return local;

    const day = todayStr();
    const { data, error } = await client
      .from('usage_daily')
      .select('calls, day')
      .eq('user_id', user.id)
      .eq('day', day)
      .maybeSingle();

    if (error) return local;

    const used = (data && Number(data.calls)) || 0;
    return {
      used,
      limit: USER_DAILY_LIMIT,
      remaining: Math.max(0, USER_DAILY_LIMIT - used),
      tier: 'user',
      day: (data && data.day) || day,
    };
  } catch (_) {
    return local;
  }
}

/**
 * 生成本地 UTC 日期的 YYYY-MM-DD 字符串（与数据库 date 列对齐）。
 * @returns {string}
 */
function todayStr() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
