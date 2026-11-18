/**
 * APEXON Weather - Configuration
 *
 * SECURITY NOTICE:
 *   本文件刻意不保存任何和风天气 API Key。
 *   所有天气 / 地理请求统一经服务端代理（Supabase Edge Function）转发，
 *   Key 只存在于服务端的 Secrets / Vault 中，App 包内不存在明文或混淆后的密钥。
 *
 *   未登录也可以正常使用：游客以公开的 publishable key 匿名调用代理，
 *   只是每日额度更小；登录后按用户计数，额度更大。
 */

export const CONFIG = {
  // 品牌
  brand: 'APEXON',

  // 自建代理（可选）。留空则使用 Supabase Edge Function 代理。
  proxyBaseUrl: '',

  // Supabase 项目地址（形如 https://xxxx.supabase.co）
  // 留空则没有可用的服务端代理，天气功能不可用（因为包内不再内置密钥）。
  supabaseUrl: 'https://dtbvpapykwnigouhqrxc.supabase.co',
  // Supabase 可公开暴露的 publishable key（anon key），放在前端是安全的：
  // 它只代表「匿名游客」这个最低权限身份，真正的和风 Key 在服务端。
  supabaseAnonKey: 'sb_publishable_suLzstWQfibtKh5NXUEyFw_BVJN5iFN',

  // Lemon Squeezy 店铺标识（用于前端联盟追踪脚本）
  lemonStore: 'apexon',
  // 打赏结账链接：在 Lemon Squeezy 后台建好产品后粘贴到此处。
  // 留空时打赏页只展示档位并提示"通道尚未开通"，不会产生任何无效跳转。
  // ⚠️ 不要把 Lemon Squeezy 的 API Key 放在这里——它是服务端密钥，
  //    前端只需要产品结账链接（该链接本身就是公开的）。
  donateCheckoutUrl: '',

  // API 基础地址（仅在服务端代理不可用时作为兜底配置保留）
  // ⚠️ 2026年起和风天气升级为专属 API Host，旧域名 devapi/geoapi.qweather.com 已停服
  // ⚠️ 所有请求（天气 + GeoAPI）统一走专属域名，GeoAPI 路径前缀为 /geo/v2/
  geoApiBase: 'https://my2k5qny2j.re.qweatherapi.com/geo/v2',
  weatherApiBase: 'https://my2k5qny2j.re.qweatherapi.com/v7',

  // 每日调用额度（仅用于客户端展示，真正的判定在服务端）
  // 额度已按需求大幅放开：正常使用（5 分钟缓存 + 请求去重）一天只会消耗
  // 几十次调用，因此这两档上限实际不可能被普通用户触达，
  // 相当于「取消额度限制」，但仍保留一个兜底闸门防止代理被人写脚本刷爆。
  // 必须与 supabase/functions/weather-proxy/index.ts 中的常量保持一致
  guestDailyLimit: 5000,
  userDailyLimit: 20000,

  // 缓存 TTL（毫秒）
  cacheTtl: {
    geoSearch: 1000 * 60 * 60 * 24,      // 城市搜索 24h
    realtime: 1000 * 60 * 5,             // 实时天气 5min
    hourly: 1000 * 60 * 30,              // 逐小时预报 30min
    daily: 1000 * 60 * 60,               // 7天预报 1h
    airQuality: 1000 * 60 * 15,          // 空气质量 15min
    minutely: 1000 * 60 * 5,             // 分钟降水 5min
    indices: 1000 * 60 * 60,             // 天气指数 1h
  },

  // 节流与去重
  debounceMs: 280,
  minSearchChars: 2,
  maxSearchResults: 20,
  defaultCityCount: 10,

  // 动画与性能
  enableCanvas: true,
  targetFps: 60,
  particleCount: {
    mobile: 32,
    desktop: 64,
  },

  // 版本号，用于缓存清理
  appVersion: '2.8.4',

  // 当前安装包的 versionCode，必须与 dist/android/app/build.gradle 保持一致。
  // 原生更新检测会用它和远端清单（/apps/apps.json）的 versionCode 比对。
  // tools/make-app-json.py 会在构建时校验两者一致，不一致直接报错。
  versionCode: 33,

  // 应用内原生更新的远端清单地址。
  // 域名上由 /apps/apps.json 统一维护：网站发布页 /apps.html 与 App 端读同一份清单，
  // 发布新版本时只改这一处，两边自动同步，不会出现「网站显示最新、App 检测不到」。
  // 留空则不做原生更新检测；网页版仍由 Service Worker 热更新。
  updateManifestUrl: 'https://apexon.qzz.io/apps/apps.json',

  // 双域名清单：每次发版两个站点都会放同一版本的 APK 与清单，
  // 检测时逐个拉取、取 versionCode 最大的那条，任一域名被墙/缓存过期都不影响升级。
  // 顺序只影响发起请求的先后，与优先级无关。
  updateManifestUrls: [
    'https://apexon.qzz.io/apps/apps.json',
    'https://weather.apexon.qzz.io/apps/apps.json',
  ],

  // 清单 apps[] 数组里标识本应用的 id，用于取到属于自己的那一条 latest
  updateAppId: 'apexon-weather',

  // latest.file 是相对站点根的路径（如 apps/apexon-weather-2.4.0.apk），
  // 拼上下载基址才是完整下载地址。
  updateSiteBase: 'https://apexon.qzz.io',

  // 自建 API（Cloudflare Worker）：配对消息 / 三端同步 / IP 兜底定位
  // 手机端、网页端、桌面端共用同一份数据，改动时只改这里。
  bondApiBase: 'https://weather-api.apexon.qzz.io',
  syncApiBase: 'https://weather-api.apexon.qzz.io',
};

/**
 * 当前登录会话的 JWT。由 app.js 在登录状态变化时写入，
 * 请求代理时作为 Authorization 头带上，供 Edge Function 区分「登录用户」并按其计数。
 * 未登录时为 null，此时改用公开 publishable key 作为匿名身份（游客额度）。
 */
let proxyAccessToken = null;

export function setProxyAccessToken(token) {
  proxyAccessToken = token || null;
}

/* -------------------------------------------------------------
   设备号：游客额度的计数主体
   不用 IP 计数——国内运营商 CGNAT 下大量用户共享出口 IP，
   按 IP 会让互不相干的人互相挤占额度。
   ------------------------------------------------------------- */

const DEVICE_ID_KEY = 'apexon_device_id';

function randomDeviceId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `d_${crypto.randomUUID()}`;
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      return `d_${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
  } catch (_) {
    // 忽略：退回到下面的时间戳随机串
  }
  return `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** 读取（必要时生成并持久化）本机设备号，供游客档位限流使用。 */
export function getDeviceId() {
  if (typeof localStorage === 'undefined') return '';
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_ID_KEY);
  } catch (_) {
    id = null;
  }
  if (!id || id.length < 8) {
    id = randomDeviceId();
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch (_) {
      // 隐私模式下写入失败：本次会话仍用内存里的临时值
    }
  }
  return id;
}

/**
 * Supabase Edge Function 代理地址。
 * 部署后形如 https://<ref>.supabase.co/functions/v1/weather-proxy
 * 未配置 supabaseUrl 时返回空字符串。
 */
export function getSupabaseProxyBase() {
  if (!CONFIG.supabaseUrl) return '';
  return `${CONFIG.supabaseUrl.replace(/\/+$/, '')}/functions/v1/weather-proxy`;
}

/**
 * 服务端代理是否可用：只要配置了 Supabase 就可用。
 * 未登录时以匿名身份调用（额度较小），因此这里不再要求「必须已登录」。
 */
export function isSupabaseProxyReady() {
  return Boolean(getSupabaseProxyBase());
}

/** 是否正在走服务端代理（此时请求不再携带任何前端 Key） */
export function isProxied() {
  return Boolean(CONFIG.proxyBaseUrl) || isSupabaseProxyReady();
}

/**
 * 获取实际使用的 API 基础地址
 * 优先级：自建代理 → Supabase Edge Function 代理 → 和风官方域名（不可用时仅作兜底）
 */
export function getApiBase() {
  if (CONFIG.proxyBaseUrl) return `${CONFIG.proxyBaseUrl}/api/weather`;
  if (isSupabaseProxyReady()) return `${getSupabaseProxyBase()}/v7`;
  return CONFIG.weatherApiBase;
}

export function getGeoBase() {
  if (CONFIG.proxyBaseUrl) return `${CONFIG.proxyBaseUrl}/api/geo`;
  if (isSupabaseProxyReady()) return `${getSupabaseProxyBase()}/geo/v2`;
  return CONFIG.geoApiBase;
}

/**
 * 需要附加到代理请求上的认证头。
 * - 已登录：Authorization 用用户 JWT，服务端按 userId 计数（高额度档）
 * - 未登录：Authorization 用公开 publishable key（匿名游客档），并带上设备号计数
 */
export function getProxyHeaders() {
  if (!isSupabaseProxyReady()) return {};

  const headers = {};
  if (CONFIG.supabaseAnonKey) headers.apikey = CONFIG.supabaseAnonKey;
  const token = proxyAccessToken || CONFIG.supabaseAnonKey;
  if (token) headers.Authorization = `Bearer ${token}`;

  const deviceId = getDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;

  return headers;
}

/**
 * 构建 API URL，自动处理代理模式。
 * 走代理时不携带任何 key —— key 只存在于服务端。
 */
export function buildUrl(endpoint, params = {}) {
  const isGeo = endpoint.startsWith('/city') || endpoint.startsWith('/top');
  const base = isGeo ? getGeoBase() : getApiBase();
  const url = new URL(base + endpoint);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  if (!isProxied()) {
    // 包内不再保存密钥，此分支仅为兜底；走到这里说明服务端代理未配置，
    // 请求会因缺少 key 失败，前端会给出明确错误提示而不是静默吞掉。
    console.error('[APEXON] 未配置服务端代理，且 App 内不保存 API Key，请求无法完成');
  }

  return url.toString();
}

/**
 * 构建「新版接口」URL。
 *
 * 和风 2026 起把空气质量与灾害预警换成了新路径，它们和旧接口有两处不同，
 * 因此不能复用 getApiBase()（那个基址自带 /v7 前缀）：
 *   1. 路径不带 /v7 前缀，例如 /airquality/v1/current/{latitude}/{longitude}；
 *   2. 定位参数不再是 location=城市ID，而是把经纬度直接写在路径里。
 * 代理对任意和风路径都是透传的，所以这里只要保证拼出正确的上游路径即可。
 */
export function buildV1Url(path, params = {}) {
  let base;
  if (CONFIG.proxyBaseUrl) base = `${CONFIG.proxyBaseUrl}/api/weather`;
  else if (isSupabaseProxyReady()) base = getSupabaseProxyBase();
  else base = CONFIG.weatherApiBase.replace(/\/+v7$/, '');

  const url = new URL(base + path);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  return url.toString();
}
