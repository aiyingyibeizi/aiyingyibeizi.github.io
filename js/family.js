/**
 * APEXON Weather · 牵挂系统（单向层）
 *
 * 设计原则（来自蓝图第二部分 2.1–2.5）：
 *  - 纯本地，零后端：只把「公开天气」放在这里，TA 永远收不到通知；
 *  - 称呼、颜色、emoji 都是私人的，永不同步、永不外泄；
 *  - 永不自动删除、永不生成「你很久没看了」这类催促；
 *  - 没有值得说的话就不说（副文案可以整行留空）。
 *
 * 存 localStorage 而不是 IndexedDB：冷启动首帧就要能读到，不能等异步打开数据库。
 */

import { storage } from './common.js';
import { getRealtimeWeather, getDailyForecast, getWarnings } from './api.js';
import { getLanguage } from './i18n.js';

const PEOPLE_KEY = 'apexon_people';
const WX_KEY = 'apexon_people_wx';
const NOTE_KEY = 'apexon_person_notes';

export const PEOPLE_LIMIT = 20;
export const NOTE_LIMIT = 5;
export const NOTE_LEN = 60;

/** 8 个预设记号 + 8 个专属色：一眼能分辨，不用挑花眼 */
export const EMOJI_PRESETS = ['🌸', '❤️', '🏠', '👧', '🧓', '☀️', '🌙', '⭐'];
export const COLOR_PRESETS = [
  '#e88ab4', '#e0785a', '#e0b25a', '#6fb389',
  '#5f9fe0', '#8a7fe0', '#a0a8b8', '#5ac0c0',
];

export const DEFAULT_ALERTS = {
  rain: true, cold: false, hot: false, aqi: false, extreme: true,
};

const isZh = () => String(getLanguage()).startsWith('zh');
/** 双语兜底：中文语境给中文，其余语言给英文（不让界面出现键名） */
const P = (zhText, enText) => (isZh() ? zhText : enText);

function uid() {
  try {
    if (crypto?.randomUUID) return `p_${crypto.randomUUID().slice(0, 8)}`;
  } catch (_) { /* 忽略 */ }
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------------------------------------------ 人物 */

export function getPeople() {
  const list = storage.get(PEOPLE_KEY, []);
  return Array.isArray(list) ? list.filter((p) => p && p.id && p.city?.id) : [];
}

export function savePeople(list) {
  storage.set(PEOPLE_KEY, (list || []).slice(0, PEOPLE_LIMIT));
  return getPeople();
}

export function makePerson(input = {}) {
  const now = Date.now();
  return {
    id: uid(),
    label: String(input.label || '').slice(0, 8),
    emoji: input.emoji || '',
    color: input.color || COLOR_PRESETS[0],
    city: input.city || null,
    // relation 只影响措辞，永不显示在界面上
    relation: input.relation || 'peer',
    privacy: input.privacy || 'visible',
    alerts: { ...DEFAULT_ALERTS, ...(input.alerts || {}) },
    quietHours: input.quietHours || [22, 8],
    note: String(input.note || '').slice(0, 60),
    bondId: input.bondId || null,
    createdAt: now,
    lastSeenAt: now,
  };
}

export function upsertPerson(person) {
  const list = getPeople();
  const i = list.findIndex((p) => p.id === person.id);
  if (i >= 0) list[i] = { ...list[i], ...person };
  else list.unshift(person);
  return savePeople(list);
}

export function removePerson(id) {
  return savePeople(getPeople().filter((p) => p.id !== id));
}

/** 首页最多露出 4 个，其余折叠（C12：信息过载） */
export const HOME_PEOPLE_LIMIT = 4;

/* ------------------------------------------------------- 私人便签（I3） */

export function getNotes(personId) {
  const map = storage.get(NOTE_KEY, {});
  const list = map?.[personId];
  return Array.isArray(list) ? list : [];
}

export function addNote(personId, text) {
  const clean = String(text || '').trim().slice(0, NOTE_LEN);
  if (!clean) return getNotes(personId);
  const map = storage.get(NOTE_KEY, {});
  const list = getNotes(personId);
  if (list.length >= NOTE_LIMIT) return list;
  map[personId] = [...list, { id: uid(), text: clean, at: Date.now() }];
  storage.set(NOTE_KEY, map);
  return map[personId];
}

export function removeNote(personId, noteId) {
  const map = storage.get(NOTE_KEY, {});
  map[personId] = getNotes(personId).filter((n) => n.id !== noteId);
  storage.set(NOTE_KEY, map);
  return map[personId];
}

/* ----------------------------------------------------- 牵挂城市的天气 */

/**
 * 牵挂城市只拉 realtime（1 次/人），daily 每 3 小时一次，
 * 预警只在「开了极端预警」时拉。20 分钟内存闸门挡住自动刷新带来的重复请求。
 * 这样 10 个人一天最多约 1000 次，远低于 5000 的游客额度。
 */
const WX_TTL = 20 * 60 * 1000;
const DAILY_TTL = 3 * 60 * 60 * 1000;
const WARN_TTL = 30 * 60 * 1000;

function readWx() {
  const map = storage.get(WX_KEY, {});
  return map && typeof map === 'object' ? map : {};
}

export async function fetchPeopleWeather(people, { force = false } = {}) {
  const map = readWx();
  const now = Date.now();
  await Promise.all((people || []).map(async (p) => {
    const prev = map[p.id];
    const fresh = prev && now - (prev.t || 0) < WX_TTL;
    if (fresh && !force) return;
    try {
      const [rt, daily, warnings] = await Promise.all([
        getRealtimeWeather(p.city.id),
        prev?.daily && now - (prev.dt || 0) < DAILY_TTL
          ? Promise.resolve(prev.daily)
          : getDailyForecast(p.city.id, 3).catch(() => prev?.daily || null),
        p.alerts?.extreme && (!prev?.warn || now - (prev.wt || 0) > WARN_TTL)
          ? getWarnings({ id: p.city.id, lon: p.city.lon, lat: p.city.lat }).catch(() => prev?.warn || [])
          : Promise.resolve(prev?.warn || []),
      ]);
      map[p.id] = {
        t: now,
        rt,
        daily: daily || prev?.daily || null,
        dt: daily ? now : prev?.dt,
        warn: Array.isArray(warnings) ? warnings : [],
        wt: now,
        stale: false,
      };
    } catch (_) {
      // 拉取失败不显示「--」，保留上次成功数据并标记为旧数据（C13）
      if (prev) map[p.id] = { ...prev, stale: true };
    }
  }));
  storage.set(WX_KEY, map);
  return map;
}

export function getPeopleWeather() {
  return readWx();
}

export function weatherAgeText(entry) {
  if (!entry?.t) return '';
  const minutes = Math.max(0, Math.round((Date.now() - entry.t) / 60000));
  if (minutes < 2) return P('刚刚', 'just now');
  if (minutes < 60) return P(`${minutes} 分钟前`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return P(`${hours} 小时前`, `${hours}h ago`);
  return P(`${Math.round(hours / 24)} 天前`, `${Math.round(hours / 24)}d ago`);
}

/* ------------------------------------------------------ 天气类型归类 */

const RAIN_WORDS = ['雨', 'rain', 'drizzle', 'shower', 'thunder', 'storm', '雷'];
const SUN_WORDS = ['晴', 'sun', 'clear'];
const SNOW_WORDS = ['雪', 'snow', 'sleet'];

export function weatherKind(text = '') {
  const s = String(text).toLowerCase();
  if (SNOW_WORDS.some((w) => s.includes(w))) return 'snow';
  if (RAIN_WORDS.some((w) => s.includes(w))) return 'rain';
  if (SUN_WORDS.some((w) => s.includes(w))) return 'sun';
  return 'cloud';
}

/* ------------------------------------------------- 副文案规则引擎（2.3） */

/**
 * 目标城市当前小时。
 * 和风 realtime.obsTime 是「当地时间 + 时区偏移」的 ISO 串（如 2026-10-25T14:00+08:00），
 * 直接切字符串取小时就能拿到当地时刻，不做任何时区换算，海外的家人也不会算错。
 */
function hourOfCity(rt) {
  const obs = String(rt?.obsTime || '');
  const m = obs.match(/T(\d{2}):/);
  if (m) return Number(m[1]);
  return new Date().getHours();
}

/**
 * 只输出一条，优先级从高到低；第 10 条是「不显示」。
 * @param {object} person
 * @param {object} entry  牵挂城市天气缓存
 * @param {object} local  state.weather（本地城市，用于温差/同类比较）
 * @param {object} unread {name, body} 未读的双向消息（可为 null）
 * @returns {{text:string, tone:'alert'|'normal', unread:boolean}}
 */
export function buildSubtitle(person, entry, local, unread) {
  const empty = { text: '', tone: 'normal', unread: false };

  // 0. 真人的话压过一切规则
  if (unread?.body) {
    const who = unread.name || person.label || '';
    return {
      text: P(`${who} 提醒你：${unread.body}`, `${who}: ${unread.body}`),
      tone: 'normal',
      unread: true,
    };
  }
  if (!entry?.rt) return empty;

  const rt = entry.rt;
  const daily = entry.daily || [];
  const today = daily[0] || {};
  const tomorrow = daily[1] || {};
  const label = person.label || P('TA', 'them');
  const elder = person.relation === 'elder';

  // 1. 预警
  const warn = (entry.warn || [])[0];
  if (warn) {
    const title = warn.title || P('天气预警', 'Weather alert');
    return { text: P(`⚠️ ${title}，注意安全`, `⚠️ ${title}`), tone: 'alert', unread: false };
  }

  // 2. 未来 12h 降水（C17：时段措辞按目标城市的当地时间算，不看本机时钟）
  if (Number(today.pop) >= 60) {
    const localHour = hourOfCity(rt);
    const when = localHour < 11 ? P('今天', 'today') : (localHour < 18 ? P('下午', 'this afternoon') : P('今晚', 'tonight'));
    const t = elder
      ? P(`${label}那边${when}有雨，记得提醒带伞`, `Rain where ${label} is ${when} — remind them to take an umbrella`)
      : P(`${label}那边${when}有雨`, `Rain where ${label} is ${when}`);
    return { text: t, tone: 'normal', unread: false };
  }

  // 3/4. 明日降温 / 升温（用最高温差）
  const d1 = Number(tomorrow.tempMax);
  const d0 = Number(today.tempMax);
  if (Number.isFinite(d1) && Number.isFinite(d0)) {
    const diff = d1 - d0;
    if (diff <= -6) {
      return { text: P(`明天降 ${Math.abs(diff)} 度，该加件外套了`, `Colder by ${Math.abs(diff)}° tomorrow`), tone: 'normal', unread: false };
    }
    if (diff >= 6) {
      return { text: P(`明天暖 ${diff} 度，可以少穿点`, `Warmer by ${diff}° tomorrow`), tone: 'normal', unread: false };
    }
  }

  const temp = Number(rt.temp);
  // 5. 高温
  if (Number.isFinite(temp) && temp >= 35) {
    return { text: P(`${temp}°C，很热，别在中午出门`, `${temp}°C — avoid going out at noon`), tone: 'normal', unread: false };
  }
  // 6. 低温
  if (Number.isFinite(temp) && temp <= 0) {
    return { text: P(`${temp}°C，注意保暖`, `${temp}°C — keep warm`), tone: 'normal', unread: false };
  }

  // 8. 与本地温差 ≥ 10
  const localRt = local?.realtime;
  const localTemp = Number(localRt?.temp);
  if (Number.isFinite(temp) && Number.isFinite(localTemp)) {
    const gap = temp - localTemp;
    if (Math.abs(gap) >= 10) {
      return {
        text: gap > 0
          ? P(`比这里暖 ${Math.round(gap)} 度`, `about ${Math.round(gap)}° warmer here`)
          : P(`比这里冷 ${Math.round(Math.abs(gap))} 度`, `about ${Math.round(Math.abs(gap))}° colder here`),
        tone: 'normal',
        unread: false,
      };
    }
    // 9. 几乎一样
    if (Math.abs(gap) < 5 && localRt?.text && rt.text && weatherKind(rt.text) === weatherKind(localRt.text)) {
      // 9.5 同一片天空：同类型天气时说得更具体一点（B10）
      const kind = weatherKind(rt.text);
      if (kind === 'rain') {
        return { text: P(`你和${label}那边都在下雨`, `It's raining in both places`), tone: 'normal', unread: false };
      }
      if (kind === 'sun') {
        return { text: P(`你和${label}那边都是好天`, `Clear skies in both places`), tone: 'normal', unread: false };
      }
      if (kind === 'snow') {
        return { text: P(`你和${label}那边都在下雪`, `It's snowing in both places`), tone: 'normal', unread: false };
      }
      return { text: P('和这里差不多', 'About the same as here'), tone: 'normal', unread: false };
    }
  }

  // 10. 没有值得说的话 —— 宁可空一行，不凑话
  return empty;
}

/* -------------------------------------------- 递话 / 天气传声筒（2.4） */

/**
 * 生成一段「可以直接复制发出去」的话，不做自动发送、不记录内容。
 * style: 'chat' 微信口吻（默认，带一点口语）| 'sms' 短信口吻（更短、更正式、无表情）
 */
export function composeMessage(person, entry, style = 'chat') {
  if (!entry?.rt) return '';
  const label = person.label || P('TA', 'them');
  const rt = entry.rt;
  const daily = entry.daily || [];
  const today = daily[0] || {};
  const tomorrow = daily[1] || {};
  const lines = [];

  if (style === 'sms') {
    const head = P(`${label}，${person.city?.name || ''}今天`, `${person.city?.name || ''} today`);
    lines.push(P(`${head}${rt.text}，${rt.temp}度。`, `${head}: ${rt.text}, ${rt.temp}°C.`));
    const d1 = Number(tomorrow.tempMax);
    const d0 = Number(today.tempMax);
    if (Number.isFinite(d1) && Number.isFinite(d0) && d0 - d1 >= 6) {
      lines.push(P(`明天降温${Math.abs(d0 - d1)}度，注意加衣。`, `Colder by ${Math.abs(d0 - d1)}° tomorrow.`));
    } else if (Number(today.pop) >= 60) {
      lines.push(P('有雨，出门带伞。', 'Rain expected — take an umbrella.'));
    }
    return lines.join('');
  }

  const openers = [
    P(`妈，${person.city?.name || ''}今天${rt.text}`, `Hey — it's ${rt.text} in ${person.city?.name || ''}`),
    P(`${label}那边今天${rt.text}，${rt.temp}度`, `It's ${rt.text} and ${rt.temp}° where ${label} is`),
    P(`刚看了一眼${person.city?.name || ''}的天气`, `Just checked the weather for ${person.city?.name || ''}`),
  ];
  // 用 id 哈希固定选一句，同一个人每次同一句，不来回跳（肌肉记忆）
  const seed = Array.from(person.id || '').reduce((n, c) => n + c.charCodeAt(0), 0);
  lines.push(openers[seed % openers.length] + '。');

  if (Number(today.pop) >= 60) {
    lines.push(P('下午有雨，出门记得带伞。', 'Rain in the afternoon — take an umbrella.'));
  }
  const d1 = Number(tomorrow.tempMax);
  const d0 = Number(today.tempMax);
  if (Number.isFinite(d1) && Number.isFinite(d0) && d0 - d1 >= 6) {
    lines.push(P(`明天降温 ${Math.abs(d0 - d1)} 度，把那件厚外套找出来。`, `Colder by ${Math.abs(d0 - d1)}° tomorrow — dig out the thick coat.`));
  }
  return lines.join('');
}

/* ------------------------------------------------- 双向消息模板（2.10） */

export const MESSAGE_TEMPLATES = {
  weather: ['msg.tpl.umbrella', 'msg.tpl.warm', 'msg.tpl.hot', 'msg.tpl.mask', 'msg.tpl.wind', 'msg.tpl.cool'],
  care: ['msg.tpl.sleep', 'msg.tpl.eat', 'msg.tpl.medicine', 'msg.tpl.water', 'msg.tpl.selfcare'],
  warm: ['msg.tpl.miss', 'msg.tpl.weekend', 'msg.tpl.fine', 'msg.tpl.sky', 'msg.tpl.thought'],
};

/* ----------------------------------------------------- 配置传承（2.5） */

/** base64url 编解码（不引第三方库，纯浏览器 API） */
function b64urlEncode(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * 导出「给家人装好」的配置码。
 * 刻意不编码：主题、语言、私人备注、配对码（安凭证绝不进二维码）。
 */
export function encodeConfig(people, cities, unit) {
  const payload = {
    v: 1,
    unit: unit === 'f' ? 'f' : 'c',
    cities: (cities || []).slice(0, 20).map((c) => ({
      id: c.id, name: c.name, lon: c.lon, lat: c.lat, adm1: c.adm1 || '', adm2: c.adm2 || '',
    })),
    people: (people || []).slice(0, PEOPLE_LIMIT).map((p) => ({
      label: p.label, emoji: p.emoji, color: p.color, relation: p.relation,
      alerts: p.alerts, quietHours: p.quietHours, privacy: p.privacy,
      city: p.city ? { id: p.city.id, name: p.city.name, lon: p.city.lon, lat: p.city.lat } : null,
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return b64urlEncode(bytes);
}

export function decodeConfig(code) {
  try {
    const json = new TextDecoder().decode(b64urlDecode(code));
    const data = JSON.parse(json);
    if (!data || data.v !== 1) return null;
    return {
      unit: data.unit === 'f' ? 'f' : 'c',
      cities: Array.isArray(data.cities) ? data.cities.filter((c) => c?.id) : [],
      people: Array.isArray(data.people) ? data.people.filter((p) => p?.city?.id) : [],
    };
  } catch (_) {
    return null;
  }
}

/**
 * 合并导入：同名城市去重，已存在的同名人物不动（不静默合并，返回提示）。
 */
export function mergeImport(data) {
  return {
    cities: data?.cities?.length || 0,
    people: data?.people?.length || 0,
    unit: data?.unit || 'c',
  };
}

/** 给尚未建立双向连接的人补上 bondId */
export function setBondId(personId, bondId) {
  const list = getPeople().map((p) => (p.id === personId ? { ...p, bondId: bondId || null } : p));
  return savePeople(list);
}

export function findPersonByBond(bondId) {
  return getPeople().find((p) => p.bondId && String(p.bondId) === String(bondId)) || null;
}
