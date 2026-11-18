/**
 * APEXON Weather · 天气相册（本地）
 *
 * 只做一件事：把用户拍下/选中的照片连同当时的天气，存在这台手机的 IndexedDB 里。
 *  - 不上传、不联网、不请求任何第三方服务；
 *  - 原图压缩到长边 1600 / JPEG 0.85，缩略图长边 480 / JPEG 0.7；
 *  - 导出到系统相册优先走 navigator.share（系统分享面板可直接存相册），
 *    不支持时退回 a[download]。
 */

const DB_NAME = 'apexon_album';
const DB_VERSION = 1;
const STORE = 'shots';

let dbPromise = null;
let memoryFallback = null; // IndexedDB 不可用（隐私模式/老 WebView）时的降级容器

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no-idb'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb-open'));
    req.onblocked = () => reject(new Error('idb-blocked'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

function fallbackList() {
  if (!memoryFallback) memoryFallback = [];
  return memoryFallback;
}

export function isSupported() {
  return typeof indexedDB !== 'undefined';
}

/* ------------------------------------------------------------ 压缩 */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

function drawToBlob(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
  const w = Math.max(1, Math.round((img.width || maxSide) * scale));
  const h = Math.max(1, Math.round((img.height || maxSide) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

/** 压缩成 { full, thumb, width, height }；任何一步失败都返回 null */
export async function compress(file) {
  const img = await loadImage(file);
  const full = await drawToBlob(img, 1600, 0.85);
  const thumb = await drawToBlob(img, 480, 0.7);
  if (!full) return null;
  return {
    full,
    thumb: thumb || full,
    width: img.width || 0,
    height: img.height || 0,
  };
}

/* ------------------------------------------------------------ 读写 */

function makeId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 新增一张照片。
 * meta: { cityId, cityName, text, temp, icon, day }
 */
export async function addPhoto(file, meta = {}) {
  const packed = await compress(file);
  if (!packed) return null;
  const record = {
    id: makeId(),
    ts: Date.now(),
    day: meta.day || new Date().toISOString().slice(0, 10),
    cityId: meta.cityId || '',
    cityName: meta.cityName || '',
    text: meta.text || '',
    temp: Number.isFinite(Number(meta.temp)) ? Number(meta.temp) : null,
    icon: meta.icon || '',
    full: packed.full,
    thumb: packed.thumb,
    width: packed.width,
    height: packed.height,
  };

  try {
    await tx('readwrite', (store) => store.put(record));
  } catch (_) {
    fallbackList().unshift(record);
  }
  return record;
}

export async function listPhotos() {
  try {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const store = transaction.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return rows.sort((a, b) => b.ts - a.ts);
  } catch (_) {
    return fallbackList().slice().sort((a, b) => b.ts - a.ts);
  }
}

export async function getPhoto(id) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return fallbackList().find((x) => x.id === id) || null;
  }
}

export async function removePhoto(id) {
  try {
    await tx('readwrite', (store) => store.delete(id));
  } catch (_) {
    const list = fallbackList();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
  }
}

export async function countPhotos() {
  const rows = await listPhotos();
  return rows.length;
}

/** 按天气归类（晴 / 雨 / 雪 / 云），用于筛选条 */
export function kindOf(record) {
  const s = String(record?.text || '').toLowerCase();
  if (!s) return 'other';
  if (/雪|snow|sleet/.test(s)) return 'snow';
  if (/雨|rain|drizzle|shower|thunder|storm|雷/.test(s)) return 'rain';
  if (/晴|sun|clear/.test(s)) return 'sun';
  return 'cloud';
}

/* ------------------------------------------------------------ 导出 */

function fileNameFor(record) {
  const stamp = String(record.day || '').replace(/-/g, '') || String(record.ts);
  return `APEXON-${stamp}-${String(record.cityName || 'sky').replace(/[\\/:*?"<>|\s]/g, '')}.jpg`;
}

/** 保存到手机相册：优先系统分享，其次下载 */
export async function saveToDevice(record) {
  const blob = record.full || record.thumb;
  if (!blob) return false;
  const name = fileNameFor(record);
  const file = new File([blob], name, { type: 'image/jpeg' });

  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') return false;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
