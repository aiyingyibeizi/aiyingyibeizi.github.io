/**
 * APEXON Weather - Multi-layer Cache
 *
 * Strategy:
 * 1. In-flight request deduplication (promise cache) - prevents double API calls.
 * 2. Memory cache - fastest, survives during session.
 * 3. IndexedDB cache - survives restarts, respects TTL.
 * 4. LocalStorage fallback - for tiny metadata.
 */

import { CONFIG, getProxyHeaders } from './config.js';
import { storage } from './common.js';
import { recordQuotaFromHeaders, markQuotaExhausted, isQuotaExhausted } from './supabase.js';

const DB_NAME = 'APEXON_Weather_DB';
const DB_VERSION = 1;
const STORE_NAME = 'weather_cache';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
    };
  });

  return dbPromise;
}

async function dbGet(key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function dbSet(key, value, ttlMs) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record = {
        key,
        value,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
      };
      const request = store.put(record);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return false;
  }
}

async function dbDelete(key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return false;
  }
}

async function dbClearExpired() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('expiresAt');
      const range = IDBKeyRange.upperBound(Date.now());
      const request = index.openCursor(range);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve(true);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return false;
  }
}

/**
 * In-flight promise cache to deduplicate concurrent identical requests.
 */
const inFlight = new Map();

function getPromiseKey(endpoint, params) {
  try {
    const url = new URL(endpoint);
    const search = new URLSearchParams(url.search);
    Object.entries(params || {}).forEach(([k, v]) => search.set(k, String(v)));
    const sorted = Array.from(search.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${url.pathname}?${sorted}`;
  } catch {
    const sorted = Object.keys(params || {})
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return `${endpoint}?${sorted}`;
  }
}

/**
 * Fetch with cache, deduplication and TTL.
 *
 * @param {string} endpoint - API endpoint
 * @param {object} params - Query params
 * @param {object} options - { ttlMs, skipCache, parser }
 * @returns {Promise<any>}
 */
export async function fetchWithCache(endpoint, params = {}, options = {}) {
  const { ttlMs = CONFIG.cacheTtl.realtime, skipCache = false, parser } = options;
  const key = getPromiseKey(endpoint, params);

  // 1. In-flight dedup
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const promise = (async () => {
    try {
      if (!skipCache) {
        // 2. Memory cache (not implemented here, could add simple Map)
        // 3. IndexedDB cache
        const cached = await dbGet(key);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.value;
        }
        if (cached) {
          await dbDelete(key);
        }
      }

      // 4. 网络请求 - 带 CapacitorHttp 原生兜底 + 详细日志
      let lastError = null;

      /**
       * 安全请求函数
       * 优先用 fetch（Capacitor 会自动桥接为原生 HTTP），
       * 如果 fetch 失败则尝试直接调用 CapacitorHttp 插件
       */
      const safeFetch = async (url) => {
        console.log('[APEXON API] 请求:', url.replace(/key=[^&]+/, 'key=***'));

        // 走服务端代理时需携带登录 JWT（Edge Function 用它鉴权并做每日限流）
        const proxyHeaders = getProxyHeaders();
        const headers = { Accept: 'application/json', ...proxyHeaders };

        // 方式1: 标准 fetch（Capacitor 开启 CapacitorHttp 后会自动桥接）
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 12000);

          const response = await fetch(url, {
            signal: controller.signal,
            headers,
          });
          clearTimeout(timeoutId);

          // 代理会带回 X-RateLimit-* 头，记下来供设置页展示剩余额度
          recordQuotaFromHeaders(response.headers);

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error(`[APEXON API] HTTP ${response.status}:`, errText);
            // 429 = 服务端明确判定今日额度用尽：标记本地状态，提示用户登录提升额度
            if (response.status === 429) {
              markQuotaExhausted();
              throw new Error('quota_exhausted');
            }
            throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();
          console.log('[APEXON API] 响应码:', data.code, '数据长度:', JSON.stringify(data).length);
          return data;
        } catch (fetchErr) {
          console.warn('[APEXON API] fetch 失败:', fetchErr.message);

          // 方式2: 直接调用 CapacitorHttp 原生插件（绕过 WebView CORS）
          if (typeof window !== 'undefined' && window.Capacitor) {
            try {
              const { CapacitorHttp } = window.Capacitor.Plugins || {};
              if (CapacitorHttp) {
                console.log('[APEXON API] 尝试 CapacitorHttp 原生请求...');
                const res = await CapacitorHttp.get({
                  url,
                  headers,
                });
                if (res.status >= 400) {
                  console.error(`[APEXON API] 原生 HTTP ${res.status}`);
                  if (res.status === 429) {
                    markQuotaExhausted();
                    throw new Error('quota_exhausted');
                  }
                  throw new Error(`HTTP ${res.status}`);
                }
                // 原生侧同样会带回 X-RateLimit-*，统一转成 Headers 接口读取
                const rawHeaders = res.headers || {};
                recordQuotaFromHeaders({
                  get: (key) => rawHeaders[String(key).toLowerCase()] ?? rawHeaders[key] ?? null,
                });
                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                console.log('[APEXON API] 原生响应码:', data.code);
                return data;
              }
            } catch (nativeErr) {
              // 额度用尽是明确结论，不能被下面「回退到原始 fetch 错误」吞掉
              if (nativeErr && nativeErr.message === 'quota_exhausted') throw nativeErr;
              console.error('[APEXON API] CapacitorHttp 也失败:', nativeErr.message);
            }
          }

          throw fetchErr;
        }
      };

      // 额度已用尽：缓存已在上一步查过，这里不再发起网络请求，
      // 直接抛明确错误，由 UI 提示「登录可获得更高额度」。
      // 游客额度较小，若不拦，后台自动刷新会把额度空转到 429。
      if (isQuotaExhausted()) {
        throw new Error('quota_exhausted');
      }

      /**
       * 解析和风天气响应
       * QWeather 成功返回 code='200'，失败返回 '4xx'/'5xx'
       */
      const attempt = async () => {
        const data = await safeFetch(endpoint);
        if (data && data.code && data.code !== '200') {
          console.error(`[APEXON API] 接口错误 code=${data.code}:`, data.message || '');
          throw new Error(`API ${data.code}: ${data.message || '请求失败'}`);
        }
        return parser ? parser(data) : data;
      };

      // 最多重试 2 次，间隔 500ms
      for (let i = 0; i < 2; i += 1) {
        try {
          const parsed = await attempt();
          if (parsed && !skipCache) {
            await dbSet(key, parsed, ttlMs);
          }
          return parsed;
        } catch (err) {
          lastError = err;
          console.warn(`[APEXON API] 第 ${i + 1} 次失败:`, err.message);
          if (i < 1) await new Promise((r) => setTimeout(r, 500));
        }
      }
      throw lastError;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Clear cache for a specific key pattern or all expired.
 */
export async function clearCache(pattern = null) {
  if (!pattern) {
    // 用户点击“清除缓存”时应清除所有条目，而不仅是过期条目
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return false;
    }
  }
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          if (cursor.key.includes(pattern)) cursor.delete();
          cursor.continue();
        } else {
          resolve(true);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return false;
  }
}

/**
 * Persisted city list.
 */
const CITIES_KEY = 'apexon_cities';
const LAST_LOCATION_KEY = 'apexon_last_location';
const SETTINGS_KEY = 'apexon_settings';

export const cityStore = {
  getAll() {
    return storage.get(CITIES_KEY, []);
  },
  set(cities) {
    return storage.set(CITIES_KEY, cities.slice(0, 20));
  },
  add(city) {
    const cities = this.getAll();
    const existingIndex = cities.findIndex((c) => String(c.id) === String(city.id));
    const isNew = existingIndex < 0;
    if (existingIndex >= 0) {
      cities.splice(existingIndex, 1);
    }
    cities.unshift(city);
    this.set(cities);
    return isNew;
  },
  remove(id) {
    const targetId = String(id);
    const cities = this.getAll().filter((c) => String(c.id) !== targetId);
    this.set(cities);
  },
  reorder(cities) {
    this.set(cities);
  },
};

export const locationStore = {
  get() {
    return storage.get(LAST_LOCATION_KEY, null);
  },
  set(location) {
    return storage.set(LAST_LOCATION_KEY, location);
  },
};

export const settingsStore = {
  get() {
    return storage.get(SETTINGS_KEY, {
      theme: 'auto',
      unit: 'c',
      language: 'zh-CN',
      enableAnimations: true,
      enableCanvas: true,
    });
  },
  set(settings) {
    return storage.set(SETTINGS_KEY, { ...this.get(), ...settings });
  },
};

// Clean expired entries on load
dbClearExpired().catch(() => {});
