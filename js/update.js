/**
 * APEXON Weather - In-App Update Manager
 *
 * 两条更新通道：
 * 1. Web 层（Service Worker）：监听并触发热更新，见下方 SW 相关函数。
 * 2. 原生层（Android APK）：读取远端更新清单（/apps/apps.json）比对 versionCode，
 *    有新版本时调起原生桥下载并交给系统安装器覆盖安装。
 */

import { CONFIG } from './config.js';

export const UPDATE_EVENT = 'apexon:update-available';
/** 原生通道：检测到远端有新版本 */
export const NATIVE_UPDATE_EVENT = 'apexon:native-update-available';

let updateRegistration = null;

/**
 * 初始化 Service Worker 并监听更新。
 */
export function initUpdateManager() {
  if (!('serviceWorker' in navigator)) return;

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('service-worker.js').then((registration) => {
    updateRegistration = registration;

    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        // 只有当已有一个激活的 SW 控制器时，新的 installed 状态才代表“可用更新”
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
        }
      });
    });
  }).catch(() => {
    // SW 注册失败不应阻塞主应用
  });
}

/**
 * 触发 Service Worker 立即接管并刷新页面。
 */
export function applyUpdate() {
  if (!('serviceWorker' in navigator)) {
    window.location.reload();
    return;
  }

  navigator.serviceWorker.ready.then((registration) => {
    const worker = registration.waiting || registration.installing;
    if (worker) {
      worker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  });
}

/**
 * 手动检查是否有等待中的更新（用于设置页“检查更新”按钮）。
 */
export function checkForWaitingUpdate() {
  return new Promise((resolve) => {
    if (!('serviceWorker' in navigator)) return resolve(false);

    // 与 ready 赛跑并设上限：SW 注册失败或迟迟不激活时，
    // 也必须给出结果，否则设置页的“检查更新”按钮会点了没反应。
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    setTimeout(() => done(false), 4000);

    navigator.serviceWorker.ready.then((registration) => {
      done(!!registration.waiting || !!registration.installing);
    }).catch(() => done(false));
  });
}

/* ============================
   原生通道：远端 version.json 更新检测
   ============================ */

/** 是否运行在原生 App（Android WebView 已注入 ApexonUpdater 桥）。 */
export function isNativeApp() {
  return typeof window !== 'undefined' && typeof window.ApexonUpdater !== 'undefined';
}

/** 本地已安装的 versionCode：优先取原生真实值，回退到构建期写入的 config。 */
export function getLocalVersionCode() {
  if (isNativeApp()) {
    try {
      const code = Number(window.ApexonUpdater.appVersionCode());
      if (code > 0) return code;
    } catch (e) {
      // 桥调用异常时回退到 config 值
    }
  }
  return Number(CONFIG.versionCode || 0);
}

/**
 * 把远端清单里属于本应用的一条归一化成内部结构。
 *
 * 域名上的 /apps/apps.json 是「网站发布页 + App 端」共用的唯一清单，
 * 结构为 { apps: [ { id, latest: { version, versionCode, file, sha256, ... } } ] }：
 *   - latest.file 是相对站点根的路径，需要拼上 CONFIG.updateSiteBase 才是下载地址；
 *   - latest.changelog 是更新说明数组；
 *   - sha256 是小写，统一转成大写，与 APK 校验值比对时不区分大小写也保持一致。
 */
function normalizeManifest(payload) {
  const apps = Array.isArray(payload && payload.apps) ? payload.apps : null;
  // 兼容两种版式：多应用清单 { apps: [...] }，以及单应用的扁平清单 { latest: {...} }。
  // 两个域名上的文件由同一份构建产出，但历史上曾用过扁平版式，因此两种都要认。
  const entry = apps
    ? apps.find((item) => item && item.id === CONFIG.updateAppId) || apps[0]
    : payload;
  const latest = entry && entry.latest;
  if (!latest) return null;

  const file = String(latest.file || '');
  const base = String(CONFIG.updateSiteBase || '').replace(/\/+$/, '');
  let downloadUrl =
    latest.downloadUrl || (file ? `${base}/${file.replace(/^\/+/, '')}` : '');

  // CDN（Cloudflare / Fastly）按完整 URL 缓存：文件还没传上去时被缓存过的 404，
  // 会在之后很长一段时间里持续返回 404，用户看到的就是「网络正常却一直下载失败」。
  // 带上版本号后每个版本都是全新的缓存键，不会再撞上上一版残留的 404。
  if (downloadUrl && !downloadUrl.includes('?')) {
    downloadUrl += `?v=${Number(latest.versionCode || 0)}`;
  }

  return {
    id: entry.id || CONFIG.updateAppId,
    version: latest.version || '',
    versionCode: Number(latest.versionCode || 0),
    // apps.json 里的 size 已经是给人看的字符串（如 "36.1 MB"），
    // 而更新弹窗取的是 sizeText，这里直接对齐字段名。
    sizeText: latest.size || '',
    releaseDate: latest.date || '',
    downloadUrl,
    sha256: String(latest.sha256 || '').toUpperCase(),
    fileName: latest.fileName || file.split('/').pop() || '',
    // 强制更新位：apps.json 可选的布尔开关；旧版清单 / version.json 无此字段，
    // 缺省一律为 false，绝不改变现有用户的升级体验。
    force: latest.force === true,
    // 弹窗按界面语言取说明；apps.json 的 changelog 是单一语言的数组，
    // 归到 zh-CN 下，其它语言由 pickManifestNotes 回退取用。
    notes: latest.changelogI18n || (Array.isArray(latest.changelog) ? { 'zh-CN': latest.changelog } : {}),
  };
}

/**
 * 拉取单个清单地址。加时间戳参数 + no-store 双保险绕过 HTTP 缓存：
 * 站点清单的 Cache-Control 是 max-age=600，光靠 no-store 不够稳妥。
 */
async function fetchManifest(url) {
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return normalizeManifest(await res.json());
  } catch (e) {
    return null;
  }
}

/**
 * 拉取远端版本清单并与本地 versionCode 比对。
 * 有新版本时派发 NATIVE_UPDATE_EVENT 并返回清单，否则返回 null。
 *
 * 主站与网页站各有一份清单，两处都可能被 CDN 缓存拖慢，
 * 因此并发拉取后取 versionCode 最大的一条，避免「主站还是旧清单 → 检测不到更新」。
 */
export async function checkRemoteUpdate() {
  if (!isNativeApp()) return null;

  const urls = Array.isArray(CONFIG.updateManifestUrls) && CONFIG.updateManifestUrls.length
    ? CONFIG.updateManifestUrls
    : [CONFIG.updateManifestUrl].filter(Boolean);
  if (!urls.length) return null;

  const results = (await Promise.all(urls.map(fetchManifest))).filter(Boolean);
  if (!results.length) return null;

  const manifest = results.reduce((best, cur) =>
    cur.versionCode > best.versionCode ? cur : best
  );

  const latest = manifest.versionCode;
  if (!latest || latest <= getLocalVersionCode()) return null;

  window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_EVENT, { detail: manifest }));
  return manifest;
}

/**
 * 按清单开始下载并安装。
 * @returns {'downloading'|'need-permission'|'external'|'no-url'} 供 UI 决定提示文案
 */
export function installRemoteUpdate(manifest) {
  const url = (manifest && (manifest.downloadUrl || manifest.url)) || '';
  if (!url) return 'no-url';

  if (isNativeApp()) {
    if (typeof window.ApexonUpdater.canInstall === 'function' && !window.ApexonUpdater.canInstall()) {
      window.ApexonUpdater.openInstallSettings();
      return 'need-permission';
    }
    window.ApexonUpdater.downloadAndInstall(url, manifest.sha256 || '', manifest.fileName || '');
    return 'downloading';
  }

  // 非原生环境（网页版）无法安装 APK，交给浏览器下载
  window.open(url, '_blank', 'noopener');
  return 'external';
}

/** 跳转到系统「安装未知应用」授权页（安卓 8+ 首次安装需用户手动允许）。 */
export function openInstallPermissionSettings() {
  if (isNativeApp() && typeof window.ApexonUpdater.openInstallSettings === 'function') {
    window.ApexonUpdater.openInstallSettings();
  }
}
