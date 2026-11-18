/**
 * APEXON Weather · 牵手消息提醒
 *
 * 一套逻辑 covering 三端：
 *   - APK：把生效中的配对（bondId + token）镜像给原生，原生用 AlarmManager 每 15 分钟
 *     拉一次消息，App 被系统杀掉也能弹出通知；App 在前台时这里每 45 秒拉一次，
 *     新消息立即提醒。
 *   - 网页 / 桌面：用 Web Notification（需用户授权），页面打开期间生效。
 *
 * 提醒文案是固定的生动模板，不拼接任何用户可控的长文本：
 *   「阿姨 提醒你看看天气：记得带伞」 / 「小林 想跟你说：早点睡」
 *
 * 去重：本地记录每个配对「已提醒到的时间戳」，只对更新的消息提醒一次。
 */

import { activeBonds, pullMessages, getMessages } from './bond.js';
import { storage } from './common.js';
import { getLanguage } from './i18n.js';

const SEEN_KEY = 'apexon_bond_seen';
const POLL_MS = 45 * 1000;
const FIRST_DELAY_MS = 6000;

const isZh = () => String(getLanguage()).startsWith('zh');

let timer = null;
let started = false;

/* ------------------------------------------------------------- 权限 */

/**
 * 请求通知权限：APK 走原生（Android 13+ 必须运行时申请），网页走 Notification API。
 * 只在用户真正开始配对时调用一次，不在启动时打扰。
 */
export function requestBondNotificationPermission() {
  try {
    if (window.ApexonShell?.requestNotificationPermission) {
      window.ApexonShell.requestNotificationPermission();
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch (_) {
    /* 权限被拒也不影响 App 其他功能 */
  }
}

/* --------------------------------------------------------- 原生镜像 */

/**
 * 把当前生效中的配对交给原生，供 App 退到后台 / 被清理后继续拉消息。
 * 只有 active 的配对才有 token 可用；pending 阶段服务端本来就只回状态。
 */
export function syncBondWatch() {
  const list = activeBonds()
    .filter((b) => b && b.token)
    .map((b) => ({ id: b.id, token: b.token, peerName: b.peerName || '' }));
  try {
    window.ApexonShell?.saveBondWatch?.(JSON.stringify(list));
  } catch (_) {
    /* 网页端没有桥，忽略 */
  }
  return list;
}

/* ------------------------------------------------------------- 文案 */

function template(kind, name, body) {
  const who = name || (isZh() ? '对方' : 'They');
  if (isZh()) {
    if (kind === 'weather') return { title: `${who} 提醒你看看天气`, body };
    if (kind === 'care') return { title: `${who} 让你照顾好自己`, body };
    return { title: `${who} 想跟你说一句`, body };
  }
  if (kind === 'weather') return { title: `${who} has a weather note`, body };
  if (kind === 'care') return { title: `${who} wants you to take care`, body };
  return { title: `${who} sent you a line`, body };
}

function notify(title, body) {
  try {
    if (window.ApexonShell?.notify && window.ApexonShell.notify(title, body)) return;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'apexon-bond', silent: false });
    }
  } catch (_) {
    /* 通知失败静默 */
  }
}

/* ---------------------------------------------------------- 新消息扫描 */

function readSeen() {
  const v = storage.get(SEEN_KEY, null);
  return v && typeof v === 'object' ? v : null;
}

/** 首次运行：把已有消息标记为「已看过」，避免一启动就补发一堆历史提醒 */
function initSeen() {
  const seen = {};
  const now = Date.now();
  activeBonds().forEach((b) => { seen[b.id] = now; });
  storage.set(SEEN_KEY, seen);
  return seen;
}

function scanNewMessages() {
  const seen = readSeen() || initSeen();
  let changed = false;
  activeBonds().forEach((bond) => {
    const last = Number(seen[bond.id] || 0);
    const fresh = getMessages(bond.id)
      .filter((m) => m.from === 'peer' && Number(m.at) > last)
      .sort((a, b) => a.at - b.at);
    if (!fresh.length) return;
    const latest = fresh[fresh.length - 1];
    const { title, body } = template(latest.kind, bond.peerName, latest.body);
    notify(title, body);
    seen[bond.id] = Number(latest.at) || Date.now();
    changed = true;
  });
  if (changed) storage.set(SEEN_KEY, seen);
}

/* ------------------------------------------------------------ 轮询 */

async function tick(force) {
  if (!activeBonds().length) return;
  try {
    await pullMessages({ force: !!force });
  } catch (_) {
    return;
  }
  // pullMessages 内部已经把新消息写进本地，这里只负责提醒
  scanNewMessages();
  syncBondWatch();
}

export function initBondNotify() {
  if (started || typeof window === 'undefined') return;
  started = true;

  if (!readSeen()) initSeen();
  syncBondWatch();

  setTimeout(() => { void tick(false); }, FIRST_DELAY_MS);
  timer = setInterval(() => { void tick(false); }, POLL_MS);

  // 回到前台立刻补一次：后台被系统冻结期间漏掉的提醒，在这里补齐
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void tick(true);
  });
  window.addEventListener('online', () => { void tick(true); });

  // 配对数量变化（新建 / 确认 / 断开）后，镜像给原生
  window.addEventListener('apexon:bonds-changed', syncBondWatch);

  if (timer && typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { clearInterval(timer); }, { once: true });
  }
}
