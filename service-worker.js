/**
 * APEXON Weather - Service Worker
 *
 * Provides offline shell, static asset caching and stale-while-revalidate
 * for weather API responses to save QWeather quota.
 *
 * Update strategy:
 * - First install: skipWaiting immediately so the app works offline right away.
 * - Subsequent updates: the new SW waits until the user clicks "Update Now"
 *   in the UI (which posts SKIP_WAITING). Then clients.claim() reloads the page.
 */

const APP_VERSION = '2.9.0';
const CACHE_NAME = `apexon-weather-${APP_VERSION}`;
/**
 * 安装期只预缓存"应用外壳"（HTML/CSS/JS/字体/图标，约 1MB）。
 * 天气视频与图片不在此列：8 个场景的 mp4 合计约 26MB，
 * 全部放进 addAll 既拖慢安装，也会因任一请求失败导致整个 SW 安装失败。
 * 它们由 fetch 里的 staleWhileRevalidate 规则（\.mp4 / \.jpg）在首次使用时按需缓存。
 */
const STATIC_ASSETS = [
  '/index.html',
  '/styles/variables.css',
  '/styles/main.css',
  '/styles/blueprint.css',
  '/js/config.js',
  '/js/common.js',
  '/js/i18n.js',
  '/js/device-profiler.js',
  '/js/supabase.js',
  '/js/cache.js',
  '/js/api.js',
  '/js/weather-background.js',
  '/js/update.js',
  '/js/family.js',
  '/js/life.js',
  '/js/memory.js',
  '/js/bond.js',
  '/js/blueprint.js',
  '/js/app.js',
  '/assets/icons/qweather/font/qweather-icons.css',
  '/assets/icons/qweather/font/fonts/qweather-icons.woff2',
  '/assets/icons/qweather/font/fonts/qweather-icons.woff',
  '/assets/icons/qweather/font/fonts/qweather-icons.ttf',
  '/assets/icons/apexon/icon-192x192.png',
  '/assets/icons/apexon/icon-512x512.png',
  '/manifest.json',
];

/**
 * 和风天气 API 响应（stale-while-revalidate 缓存，用于省额度）。
 *
 * ⚠️ v2.4.0 起所有天气请求都经 Supabase Edge Function 转发，
 *    因此这里必须同时登记代理地址，否则 API 分支失配 → 每次请求都直连上游，
 *    缓存省额度的作用会完全失效。
 */
const API_CACHE_PATTERNS = [
  // 服务端代理（Edge Function）：/functions/v1/weather-proxy/v7/... 与 /geo/v2/...
  'https://dtbvpapykwnigouhqrxc.supabase.co/functions/v1/weather-proxy/',
  // 兜底：直连和风官方域名（仅当代理不可用）
  'https://my2k5qny2j.re.qweatherapi.com/v7/',
  'https://my2k5qny2j.re.qweatherapi.com/geo/v2/',
];

function isStaticAsset(url) {
  return STATIC_ASSETS.some((path) => url.pathname === path);
}

/** HTML 外壳：只能实时取，绝不能按静态资源缓存，否则新旧 HTML/CSS 会错配 */
function isHtml(url) {
  return url.pathname === '/index.html' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
}

function isApiRequest(url) {
  return API_CACHE_PATTERNS.some((pattern) => url.href.startsWith(pattern));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // 逐个缓存、逐个容错：cache.addAll 是「全成功才算成功」，
      // 只要有一个资源 404（例如某张图标被清理、离线安装），整次安装就会失败，
      // 新的 Service Worker 永远进不来，用户会被旧版本缓存永久钉住。
      Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch(() => {
            // 单个资源失败不影响安装，首次使用时还会按 fetch 规则补齐
          })
        )
      )
    )
  );

  // 首次安装直接接管；后续更新等待用户确认，实现页面内更新
  if (!self.clients.controller) {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // 视频拖动 / 断点续传：Range 请求交给浏览器直连。
  // 把分片响应整包塞进缓存会破坏 Range 语义，播放器seek时会拿到坏数据。
  if (request.headers.has('range')) return;

  // 0. 原生更新清单（域名上的 /apps/apps.json）必须实时读网络：
  //    一旦命中缓存，用户会永远看到旧版本号、永远检测不到更新，必须绕过缓存。
  //    该清单的 Cache-Control 是 max-age=600，走默认分支会长时间命中旧副本。
  if (url.pathname.endsWith('/apps.json') || url.pathname.endsWith('/version.json')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // 1. 导航与 HTML 外壳：永远先走网络。
  //    旧实现把 /index.html 归进「静态资源 cacheFirst」，一旦命中就返回缓存里的旧外壳，
  //    与刚从网络取到的新 CSS/JS 版本错配 —— 这正是「有缓存后适配失效」的直接来源。
  if (request.mode === 'navigate' || isHtml(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 2. API requests: stale-while-revalidate with network timeout
  if (isApiRequest(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 3. Static assets: stale-while-revalidate（先秒开缓存，后台换新）
  //    不再用 cacheFirst：否则一次旧文件会一直滞留到版本号变更，
  //    升级期内容易出现「新页面 + 旧样式」的混搭。
  if (isStaticAsset(url) || url.pathname.match(/\.(css|js|png|jpg|jpeg|webp|svg|woff2?|ttf|mp4)$/)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkOnly(request) {
  // 更新清单必须拿最新的：显式忽略 HTTP 缓存
  return fetch(request, { cache: 'no-store' });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // no-cache：允许命中 HTTP 缓存但必须先向服务端校验，
    // 避免 CDN/浏览器把旧 HTML 直接当成新鲜响应返回。
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match('/index.html'));
    return cached || new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);

  // Race with timeout: return cached quickly, update in background
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), 600));

  return Promise.race([networkPromise, timeout]).then((res) => res || networkPromise);
}
