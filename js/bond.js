/**
 * APEXON Weather · 双向牵手（关系层）
 *
 * 与 family.js 的区别：family 是「单向牵挂」——你看 TA 的天气，TA 完全不知道；
 * bond 是「双方都同意」的连接——配对、互报平安、互递一句话。
 *
 * 三条硬规则（蓝图 2.14）：
 *  1. 必须双方同意才建立，任何一方可随时断开，断开后服务端删行；
 *  2. 只传一句话（≤40 字）+ 城市名，绝不传精确坐标、绝不传联系人、不读通讯录；
 *  3. 每天最多 3 条，第 4 条起直接本地拦下，不做「再发一条」的诱导。
 *
 * 所有网络失败都静默：不弹错误、不清本地数据，只标记 stale。
 */

import { CONFIG } from './config.js';
import { storage } from './common.js';
import { getLanguage } from './i18n.js';

const BOND_KEY = 'apexon_bonds';
const MSG_KEY = 'apexon_bond_msgs';
const SENT_KEY = 'apexon_bond_sent';       // 每日发送计数
const LAST_PULL_KEY = 'apexon_bond_pull';   // 上次拉取时间
const DAILY_LIMIT = 3;
const PULL_TTL = 60 * 1000;

const isZh = () => String(getLanguage()).startsWith('zh');
const P = (zhText, enText) => (isZh() ? zhText : enText);

// 自建 Cloudflare Worker（与网页端、桌面端共用同一套配对数据）
const BOND_API = `${String(CONFIG.bondApiBase || 'https://weather-api.apexon.qzz.io').replace(/\/+$/, '')}/bond`;

function endpoint() {
  return BOND_API;
}

function headers() {
  return { 'Content-Type': 'application/json' };
}

/**
 * 把服务端错误码翻译成能看懂的一句话。
 * 配对流程里所有失败都要让用户看见原因，否则「点了没反应」比报错更糟。
 */
const ERROR_TEXT = {
  not_found: () => P('配对码不存在或已过期', 'That code does not exist or has expired'),
  already_bound: () => P('这个配对码已经被用掉了', 'This code has already been used'),
  revoked: () => P('这个连接已经断开，请重新配对', 'This connection was closed — pair again'),
  unauthorized: () => P('配对凭证失效了，请重新配对', 'The pairing credential expired — pair again'),
  nothing_to_approve: () => P('对方还没提交申请，稍后再看', 'No request to approve yet'),
  inactive: () => P('连接还在同步，等两三秒再试', 'Still syncing — try again in a moment'),
  empty: () => P('先写一句话再发', 'Write something first'),
  name_required: () => P('先写一个称呼', 'Give yourself a name first'),
};

export function describeBondError(err) {
  const code = String((err && err.message) || '').trim();
  const fn = ERROR_TEXT[code];
  if (fn) return fn();
  return P('操作没成功，请稍后再试', 'That did not work — try again later');
}

async function call(action, payload, timeout = 8000) {
  const url = endpoint();
  if (!url) throw new Error('bond endpoint missing');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ action, ...payload }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `bond http ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ 本地状态 */

export function getBonds() {
  const list = storage.get(BOND_KEY, []);
  return Array.isArray(list) ? list : [];
}

function saveBonds(list) {
  storage.set(BOND_KEY, list);
  return getBonds();
}

export function hasBonds() {
  return getBonds().length > 0;
}

export function activeBonds() {
  return getBonds().filter((b) => b.status === 'active');
}

export function pendingBonds() {
  return getBonds().filter((b) => b.status === 'pending');
}

function upsertBond(bond) {
  const list = getBonds();
  const i = list.findIndex((b) => b.id === bond.id);
  if (i >= 0) list[i] = { ...list[i], ...bond };
  else list.unshift(bond);
  return saveBonds(list);
}

export function removeBond(id) {
  return saveBonds(getBonds().filter((b) => b.id !== id));
}

/* ------------------------------------------------------ 每日发送限额 */

function sentToday() {
  const map = storage.get(SENT_KEY, {}) || {};
  const key = new Date().toISOString().slice(0, 10);
  return Number(map[key] || 0);
}

function bumpSent() {
  const map = storage.get(SENT_KEY, {}) || {};
  const key = new Date().toISOString().slice(0, 10);
  map[key] = Number(map[key] || 0) + 1;
  storage.set(SENT_KEY, map);
  return map[key];
}

export function canSend() {
  return sentToday() < DAILY_LIMIT;
}

export function remainingToday() {
  return Math.max(0, DAILY_LIMIT - sentToday());
}

/* ------------------------------------------------------- 配对流程 */

/**
 * 发起方：生成 6 位邀请码（服务端生成，避免本地重复）。
 * 返回 {id, code, token}，token 只存在本机。
 */
export async function createInvite(name, city) {
  const data = await call('create', { name: String(name || '').slice(0, 8), city });
  if (!data?.bondId || !data?.code) throw new Error('create failed');
  upsertBond({
    id: data.bondId,
    role: 'host',
    token: data.token,
    code: data.code,
    peerName: '',
    peerCity: null,
    status: 'waiting',
    createdAt: Date.now(),
  });
  return data;
}

/**
 * 接受方：输入邀请码，提交自己的名字和城市，进入「等对方确认」。
 */
export async function joinInvite(code, name, city) {
  const clean = String(code || '').replace(/\s/g, '').toUpperCase().slice(0, 8);
  const data = await call('join', { code: clean, name: String(name || '').slice(0, 8), city });
  if (!data?.bondId) throw new Error('join failed');
  upsertBond({
    id: data.bondId,
    role: 'guest',
    token: data.joinToken,
    code: clean,
    peerName: data.hostName || '',
    peerCity: data.hostCity || null,
    status: 'pending',
    createdAt: Date.now(),
  });
  return data;
}

/** 发起方确认或拒绝 */
export async function approveInvite(bondId, accept) {
  const bond = getBonds().find((b) => b.id === bondId);
  if (!bond) throw new Error('bond missing');
  const data = await call('approve', { bondId, token: bond.token, accept: !!accept });
  if (!accept) {
    removeBond(bondId);
    return { removed: true };
  }
  // 本地立即置为 active：KV 在各边缘节点收敛需要几秒，
  // 若等下一次轮询才改状态，用户刚点完「同意」就发消息会撞上 inactive。
  upsertBond({ id: bondId, status: 'active', pendingGuest: null });
  return data;
}

/** 轮询一个配对的状态（接受方用，直到对方确认） */
export async function refreshBond(bondId) {
  const bond = getBonds().find((b) => b.id === bondId);
  if (!bond) return null;
  try {
    const data = await call('status', { bondId, token: bond.token });
    // 对方断开后服务端会把状态置为 revoked，本机也一并清掉，避免留一个点不开的条目
    if (data.status === 'revoked') {
      removeBond(bondId);
      return { ...bond, status: 'revoked' };
    }
    const patch = {
      status: data.status || bond.status,
      peerName: data.peerName || bond.peerName,
      peerCity: data.peerCity || bond.peerCity,
      pendingGuest: data.pendingGuest || null,
    };
    // 接受方被确认后，服务端会把正式 token 下发一次
    if (data.token) patch.token = data.token;
    upsertBond({ id: bondId, ...patch });
    return { ...bond, ...patch };
  } catch (_) {
    return null;
  }
}

/** 断开：告知服务端删行，本地立即清除 */
export async function revokeBond(bondId) {
  const bond = getBonds().find((b) => b.id === bondId);
  removeBond(bondId);
  const map = storage.get(MSG_KEY, {}) || {};
  delete map[bondId];
  storage.set(MSG_KEY, map);
  if (!bond) return true;
  try {
    await call('revoke', { bondId, token: bond.token });
  } catch (_) {
    // 网络失败也允许本地断开；服务端会在 30 天后被定时清理
  }
  return true;
}

/* --------------------------------------------------------- 消息 */

export async function sendMessage(bondId, kind, body) {
  if (!canSend()) {
    return { ok: false, reason: 'limit', text: P('今天已经说过三句了，明天再聊', 'That is three messages today — talk tomorrow') };
  }
  const bond = getBonds().find((b) => b.id === bondId);
  if (!bond || bond.status !== 'active') {
    return { ok: false, reason: 'inactive', text: P('连接还没建立', 'Not connected yet') };
  }
  const text = String(body || '').trim().slice(0, 40);
  if (!text) return { ok: false, reason: 'empty', text: '' };
  const send = () => call('send', { bondId, token: bond.token, kind: kind || 'warm', body: text });
  try {
    try {
      await send();
    } catch (e) {
      // 刚在另一台设备上确认的配对，KV 收敛有 3–5 秒窗口：
      // 这里等 2.6 秒重试一次，而不是直接把「发不出去」丢给用户。
      if (String((e && e.message) || '') !== 'inactive') throw e;
      await new Promise((r) => setTimeout(r, 2600));
      await send();
    }
    bumpSent();
    pushLocalMessage(bondId, { id: `local_${Date.now()}`, from: 'me', kind, body: text, at: Date.now(), read: true });
    return { ok: true, text };
  } catch (e) {
    return {
      ok: false,
      reason: 'network',
      text: describeBondError(e),
    };
  }
}

function readMessages() {
  const map = storage.get(MSG_KEY, {});
  return map && typeof map === 'object' ? map : {};
}

function pushLocalMessage(bondId, msg) {
  const map = readMessages();
  const list = Array.isArray(map[bondId]) ? map[bondId] : [];
  map[bondId] = [...list, msg].slice(-40);
  storage.set(MSG_KEY, map);
  return map[bondId];
}

export function getMessages(bondId) {
  return readMessages()[bondId] || [];
}

export function unreadCount(bondId) {
  return getMessages(bondId).filter((m) => m.from !== 'me' && !m.read).length;
}

export function totalUnread() {
  return getBonds().reduce((n, b) => n + unreadCount(b.id), 0);
}

/* ------------------------------------------------------ 免打扰（X19） */

/** 22:00–08:00 不震动；只影响触觉，不拦消息 */
export function inQuietHours(now = new Date()) {
  const h = now.getHours();
  return h >= 22 || h < 8;
}

/**
 * 拉取新消息。bond 面板打开时或首页进入时调用一次，1 分钟闸门。
 * 收到新消息只震一次 [10,40,10]，夜间不震。
 */
export async function pullMessages({ force = false } = {}) {
  const bonds = getBonds().filter((b) => b.status === 'active');
  if (!bonds.length) return 0;
  const last = Number(storage.get(LAST_PULL_KEY, 0)) || 0;
  if (!force && Date.now() - last < PULL_TTL) return 0;
  storage.set(LAST_PULL_KEY, Date.now());
  let added = 0;
  await Promise.all(bonds.map(async (bond) => {
    try {
      const data = await call('pull', { bondId: bond.id, token: bond.token });
      const list = Array.isArray(data?.messages) ? data.messages : [];
      const map = readMessages();
      const known = new Set((map[bond.id] || []).map((m) => m.id));
      const fresh = list
        .filter((m) => m && m.id && !known.has(m.id))
        .map((m) => ({ id: m.id, from: 'peer', kind: m.kind, body: m.body, at: Number(m.created_at) || Date.now(), read: false }));
      if (fresh.length) {
        map[bond.id] = [...(map[bond.id] || []), ...fresh].slice(-40);
        storage.set(MSG_KEY, map);
        added += fresh.length;
      }
    } catch (_) { /* 静默 */ }
  }));
  if (added && !inQuietHours()) {
    try { navigator.vibrate?.([10, 40, 10]); } catch (_) { /* 忽略 */ }
  }
  return added;
}

export async function markRead(bondId) {
  const map = readMessages();
  map[bondId] = (map[bondId] || []).map((m) => ({ ...m, read: true }));
  storage.set(MSG_KEY, map);
  const bond = getBonds().find((b) => b.id === bondId);
  if (bond?.status === 'active') {
    try { await call('read', { bondId, token: bond.token }); } catch (_) { /* 静默 */ }
  }
}

/** 首页牵挂卡片用：某人对应的未读消息（取最新一条） */
export function unreadFor(bondId) {
  if (!bondId) return null;
  const list = getMessages(bondId).filter((m) => m.from !== 'me' && !m.read);
  return list.length ? list[list.length - 1] : null;
}

/** 把 bond 消息的发送人名字交给 family 的副文案使用 */
export function peerNameOf(bondId) {
  return getBonds().find((b) => b.id === bondId)?.peerName || '';
}
