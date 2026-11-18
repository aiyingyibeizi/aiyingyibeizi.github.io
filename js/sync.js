/**
 * APEXON Weather · 数据备份与三端同步
 *
 * 同步的内容是「固定的用户数据」，不是缓存：
 *   城市列表、设置（主题/语言/单位/动效）、上次定位、牵挂的人、蓝图偏好。
 * 不包含：天气缓存、设备号、牵手 token（token 与设备绑定，不能复制到另一台机器）。
 *
 * 云端存储由 Cloudflare Worker 的 /sync 提供，键是「同步码」的 SHA-256，
 * 服务端不知道同步码原文，也不做账号体系：用户自己保管这串码，三端输入同一个码即同步。
 */

import { CONFIG } from './config.js';
import { storage } from './common.js';

const CODE_KEY = 'apexon_sync_code';
const AT_KEY = 'apexon_sync_at';
const SCHEMA = 1;

/** 参与同步的本地键（白名单，避免把缓存 / 凭证一起传上去） */
const SYNC_KEYS = [
  'apexon_cities',
  'apexon_settings',
  'apexon_last_location',
  'apexon_people',
  'apexon_person_notes',
  'apexon_bp_prefs',
];

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function apiBase() {
  return `${String(CONFIG.syncApiBase || 'https://weather-api.apexon.qzz.io').replace(/\/+$/, '')}/sync`;
}

/* --------------------------------------------------------------- 同步码 */

function randomCode(len = 8) {
  const bytes = new Uint8Array(len);
  try {
    crypto.getRandomValues(bytes);
  } catch (_) {
    for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function getSyncCode() {
  let code = String(storage.get(CODE_KEY, '') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 6) {
    code = randomCode();
    storage.set(CODE_KEY, code);
  }
  return code;
}

export function setSyncCode(input) {
  const code = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  if (code.length < 4) return false;
  storage.set(CODE_KEY, code);
  return true;
}

export function lastSyncedAt() {
  return Number(storage.get(AT_KEY, 0)) || 0;
}

/* --------------------------------------------------------------- 快照 */

export function collectSnapshot() {
  const data = {};
  SYNC_KEYS.forEach((key) => {
    const value = storage.get(key, null);
    if (value !== null && value !== undefined) data[key] = value;
  });
  return {
    schema: SCHEMA,
    app: CONFIG.appVersion,
    exportedAt: Date.now(),
    data,
  };
}

/** 城市合并：保留云端顺序在前，本机独有的城市接在后面，同 id 只留一份 */
function mergeCities(local, incoming) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || c.id === undefined || c.id === null) return;
    const id = String(c.id);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(c);
  };
  (Array.isArray(incoming) ? incoming : []).forEach(push);
  (Array.isArray(local) ? local : []).forEach(push);
  return out.slice(0, 20);
}

/**
 * 应用一份快照。默认合并城市、覆盖其余字段。
 * 返回实际写入的键数量，便于 UI 显示「已恢复 N 项」。
 */
export function applySnapshot(snapshot, { mergeCities: doMerge = true } = {}) {
  const root = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const data = root.data && typeof root.data === 'object' ? root.data : root;
  let count = 0;

  SYNC_KEYS.forEach((key) => {
    if (!(key in data)) return;
    let value = data[key];

    if (key === 'apexon_cities') {
      value = doMerge ? mergeCities(storage.get(key, []), value) : (Array.isArray(value) ? value.slice(0, 20) : []);
    }
    if (key === 'apexon_people' && !Array.isArray(value)) return;
    if (key === 'apexon_settings' && (typeof value !== 'object' || value === null)) return;

    storage.set(key, value);
    count += 1;
  });

  return count;
}

/* --------------------------------------------------------- 文件导入导出 */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 导出：APK 走原生分享面板（可存到「下载」、发给电脑、存网盘），
 * 浏览器走普通下载。两条路径都不需要存储权限。
 */
export function exportBackup() {
  const json = JSON.stringify(collectSnapshot(), null, 2);
  const name = `apexon-weather-backup-${stamp()}.json`;

  try {
    if (window.ApexonShell?.shareBackup) {
      const ok = window.ApexonShell.shareBackup(name, json);
      if (ok) return { ok: true, via: 'share', name };
    }
  } catch (_) {
    /* 落到浏览器下载 */
  }

  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, via: 'download', name };
  } catch (_) {
    return { ok: false, name };
  }
}

/** 导入：File 对象 → 校验 → 应用。返回写入项数。 */
export async function importBackupFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const count = applySnapshot(parsed, { mergeCities: true });
  if (!count) throw new Error('empty');
  return count;
}

/* --------------------------------------------------------------- 云端 */

async function request(url, options, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `sync http ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function pushCloud() {
  const code = getSyncCode();
  const payload = collectSnapshot();
  const data = await request(apiBase(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, payload }),
  });
  storage.set(AT_KEY, Date.now());
  return { code, size: data?.size || 0, updatedAt: data?.updatedAt || Date.now() };
}

export async function pullCloud() {
  const code = getSyncCode();
  const data = await request(`${apiBase()}?code=${encodeURIComponent(code)}`, { method: 'GET' });
  if (data?.empty || !data?.payload) return { empty: true, code };
  const count = applySnapshot(data.payload, { mergeCities: true });
  storage.set(AT_KEY, Date.now());
  return { empty: false, code, count, updatedAt: Number(data.updatedAt) || 0 };
}
