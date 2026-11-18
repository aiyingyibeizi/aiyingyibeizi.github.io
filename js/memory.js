/**
 * APEXON Weather · 记忆层
 *
 * 每天一条天气胶囊（E1）、天气色卡归档（F1）、一天形状（F2）、
 * 气候小结、写给未来的信（E1 时间胶囊）、气候遗物（I7）。
 * 全部本地存储，不上传任何内容。
 */

import { storage } from './common.js';
import { getLanguage } from './i18n.js';

const CAPSULE_KEY = 'apexon_day_capsule';
const LETTER_KEY = 'apexon_letters';
const HEIRLOOM_KEY = 'apexon_heirloom';
const CAPSULE_LIMIT = 120;
const LETTER_LIMIT = 60;

const isZh = () => String(getLanguage()).startsWith('zh');
const P = (zhText, enText) => (isZh() ? zhText : enText);
const num = (v, fb = NaN) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------- 每日胶囊（E1） */

function readCapsules() {
  const map = storage.get(CAPSULE_KEY, {});
  return map && typeof map === 'object' ? map : {};
}

/**
 * 每天只写一次；同一天再次调用只更新「最高/最低」这类可累加的字段。
 */
export function recordDayCapsule(city, weather) {
  const rt = weather?.realtime;
  if (!rt) return null;
  const key = todayKey();
  const map = readCapsules();
  const daily = Array.isArray(weather.daily) ? weather.daily[0] || {} : {};
  const prev = map[key];
  const temp = num(rt.temp);
  const entry = {
    date: key,
    cityId: city?.id || '',
    cityName: city?.name || '',
    text: rt.text || '',
    icon: rt.icon || '',
    temp,
    tempMax: prev ? Math.max(num(prev.tempMax, temp), num(daily.tempMax, temp)) : num(daily.tempMax, temp),
    tempMin: prev ? Math.min(num(prev.tempMin, temp), num(daily.tempMin, temp)) : num(daily.tempMin, temp),
    humidity: num(rt.humidity),
    sunset: weather?.astronomy?.sunset || '',
    sunrise: weather?.astronomy?.sunrise || '',
    updatedAt: Date.now(),
  };
  map[key] = entry;
  const keys = Object.keys(map).sort();
  while (keys.length > CAPSULE_LIMIT) {
    delete map[keys.shift()];
  }
  storage.set(CAPSULE_KEY, map);
  return entry;
}

export function getCapsules() {
  const map = readCapsules();
  return Object.keys(map)
    .sort()
    .reverse()
    .map((k) => map[k]);
}

export function getCapsule(dateKey) {
  return readCapsules()[dateKey] || null;
}

/**
 * 给某一天的胶囊写一句手写体备注（F2）。
 * 只存本地，上限 100 字；传空字符串即清除。
 */
export function setCapsuleNote(dateKey, note) {
  const map = readCapsules();
  const entry = map[dateKey];
  if (!entry) return null;
  const text = String(note || '').trim().slice(0, 100);
  if (text) entry.note = text;
  else delete entry.note;
  entry.updatedAt = Date.now();
  storage.set(CAPSULE_KEY, map);
  return entry;
}

/* ------------------------------------------------------- 一天形状（F2） */

/**
 * 把 24 小时的温度归一化成 24 个 0–1 的柱高，用来画一条无数字的「一天形状」。
 * 一眼看出「今天是驼峰还是斜坡」，比折线图更安静。
 */
export function dayShape(weather) {
  const hourly = Array.isArray(weather?.hourly) ? weather.hourly.slice(0, 24) : [];
  if (hourly.length < 6) return null;
  const temps = hourly.map((h) => num(h.temp, 20));
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const span = Math.max(1, max - min);
  const bars = temps.map((t) => Math.round(((t - min) / span) * 80 + 20));
  const peakAt = temps.indexOf(max);
  return {
    bars,
    label: P(
      peakAt <= 8 ? '早晨最高，越晚越凉' : peakAt >= 18 ? '傍晚才热起来' : '午后是顶点',
      peakAt <= 8 ? 'Warmest in the morning' : peakAt >= 18 ? 'Warms up late' : 'Peak in the afternoon',
    ),
  };
}

/* --------------------------------------------------- 日期信（E1） */

/**
 * 把某天的胶囊写成一段可以读的话。事实全部来自当天记录，不编造。
 */
export function dayNarrative(capsule) {
  if (!capsule) return '';
  const temp = Math.round(num(capsule.temp, 0));
  const max = Math.round(num(capsule.tempMax, temp));
  const min = Math.round(num(capsule.tempMin, temp));
  const text = capsule.text || P('多云', 'cloudy');
  const hum = Math.round(num(capsule.humidity, 0));
  const parts = [
    P(`${capsule.date}，${capsule.cityName || ''}${text}，${temp}°C。`, `${capsule.date} · ${capsule.cityName || ''} · ${text}, ${temp}°C.`),
  ];
  if (max - min >= 8) parts.push(P(`一天里差了 ${max - min} 度（${min}–${max}）。`, `A ${max - min}° swing (${min}–${max}).`));
  if (hum >= 80) parts.push(P('湿度很高，衣服不容易干。', 'Very humid — laundry took forever to dry.'));
  if (capsule.sunset) parts.push(P(`日落 ${capsule.sunset}。`, `Sunset at ${capsule.sunset}.`));
  return parts.join('');
}

export function capsuleYearsAgo(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  if (!y) return 0;
  const then = new Date(y, (m || 1) - 1, d || 1);
  const now = new Date();
  let years = now.getFullYear() - then.getFullYear();
  const anniversary = new Date(now.getFullYear(), then.getMonth(), then.getDate());
  if (anniversary > now) years -= 1;
  return Math.max(0, years);
}

/* ------------------------------------------------- 气候小结（E4/I7） */

export function climateSummary(days = 30) {
  const list = getCapsules().slice(0, days);
  if (!list.length) return null;
  let rain = 0;
  let sun = 0;
  let max = -999;
  let min = 999;
  let tempSum = 0;
  list.forEach((c) => {
    const t = String(c.text || '').toLowerCase();
    if (t.includes('雨') || t.includes('rain')) rain += 1;
    if (t.includes('晴') || t.includes('sun') || t.includes('clear')) sun += 1;
    max = Math.max(max, num(c.tempMax, num(c.temp, 0)));
    min = Math.min(min, num(c.tempMin, num(c.temp, 0)));
    tempSum += num(c.temp, 0);
  });
  return {
    days: list.length,
    rain,
    sun,
    max: Math.round(max),
    min: Math.round(min),
    avg: Math.round(tempSum / list.length),
  };
}

/* ---------------------------------------------------- 写给未来（E1） */

export function getLetters() {
  const list = storage.get(LETTER_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function addLetter(text, openAt, weather) {
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) return getLetters();
  const rt = weather?.realtime || {};
  const list = getLetters();
  list.unshift({
    id: `lt_${Date.now().toString(36)}`,
    text: clean,
    at: Date.now(),
    openAt: Number(openAt) || 0,
    weather: { text: rt.text || '', temp: num(rt.temp, 0), city: weather?.cityName || '' },
  });
  storage.set(LETTER_KEY, list.slice(0, LETTER_LIMIT));
  return getLetters();
}

export function removeLetter(id) {
  const list = getLetters().filter((l) => l.id !== id);
  storage.set(LETTER_KEY, list);
  return list;
}

/** 到点才可打开的信（未到点的只显示「还有 N 天」） */
export function lettersDue(now = Date.now()) {
  return getLetters().filter((l) => l.openAt && l.openAt <= now);
}

export function lettersSealed(now = Date.now()) {
  return getLetters().filter((l) => l.openAt && l.openAt > now);
}

/* ------------------------------------------------- 气候遗物（I7） */

export function getHeirloom() {
  return storage.get(HEIRLOOM_KEY, null);
}

export function setHeirloom(data) {
  storage.set(HEIRLOOM_KEY, data || null);
  return getHeirloom();
}

/* ------------------------------------------- 预警年表归档（G2） */

const WARN_KEY = 'apexon_warning_log';
const WARN_LIMIT = 300;

function warnDayText(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 只归档「已经发生过的预警」，同一城市同一天同一条标题只记一次。
 * 不推断、不合并级别；接口给了什么就记什么。
 */
export function recordWarnings(city, warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length || !city?.id) return getWarningLog();
  const stored = getWarningLog();
  const seen = new Set(stored.map((w) => `${w.cityId}|${w.day}|${w.title}`));
  const day = warnDayText();
  let added = 0;
  list.forEach((w) => {
    const title = String(w?.title || '').trim();
    if (!title) return;
    const key = `${city.id}|${day}|${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    stored.unshift({
      cityId: city.id,
      cityName: city.name || '',
      day,
      title,
      type: w?.type || '',
      severity: w?.severity || w?.level || '',
      text: w?.text || '',
      at: Date.now(),
    });
    added += 1;
  });
  if (added) storage.set(WARN_KEY, stored.slice(0, WARN_LIMIT));
  return getWarningLog();
}

export function getWarningLog() {
  const list = storage.get(WARN_KEY, []);
  return Array.isArray(list) ? list : [];
}

/** 按年统计：总条数、涉及城市数、按类型的粗略分布 */
export function warningStats(year = new Date().getFullYear()) {
  const rows = getWarningLog().filter((w) => String(w.day).startsWith(String(year)));
  const cities = new Set(rows.map((w) => w.cityName || w.cityId));
  const byType = {};
  rows.forEach((w) => {
    const t = String(w.type || 'other');
    byType[t] = (byType[t] || 0) + 1;
  });
  return { year, total: rows.length, cities: cities.size, byType };
}

/* ------------------------------------------- 年度报告（E2） */

/**
 * 只用真实记录：晴天/雨天/雪天天数、最热最冷的那一天、去过的城市数。
 * 记录不足 90 天返回 null，界面显示「明年见」，不硬凑。
 */
export function yearStats(year = new Date().getFullYear()) {
  const rows = getCapsules().filter((c) => String(c.date).startsWith(String(year)));
  if (rows.length < 90) return null;
  let sun = 0;
  let rain = 0;
  let snow = 0;
  let hottest = rows[0];
  let coldest = rows[0];
  const cities = new Set();
  rows.forEach((c) => {
    const t = String(c.text || '').toLowerCase();
    if (t.includes('雪') || t.includes('snow')) snow += 1;
    else if (t.includes('雨') || t.includes('rain') || t.includes('雷')) rain += 1;
    else if (t.includes('晴') || t.includes('sun') || t.includes('clear')) sun += 1;
    if (num(c.temp, -999) > num(hottest.temp, -999)) hottest = c;
    if (num(c.temp, 999) < num(coldest.temp, 999)) coldest = c;
    if (c.cityName) cities.add(c.cityName);
  });
  const tempSum = rows.reduce((s, c) => s + num(c.temp, 0), 0);
  const monthly = new Array(12).fill(null).map(() => ({ sum: 0, n: 0 }));
  rows.forEach((c) => {
    const m = Number(String(c.date).slice(5, 7)) - 1;
    if (m >= 0 && m < 12) {
      monthly[m].sum += num(c.temp, 0);
      monthly[m].n += 1;
    }
  });
  return {
    year,
    days: rows.length,
    sun,
    rain,
    snow,
    cities: cities.size,
    avg: Math.round(tempSum / rows.length),
    hottest: { date: hottest.date, temp: Math.round(num(hottest.temp, 0)), text: hottest.text || '' },
    coldest: { date: coldest.date, temp: Math.round(num(coldest.temp, 0)), text: coldest.text || '' },
    monthly: monthly.map((m) => (m.n ? Math.round(m.sum / m.n) : null)),
  };
}
