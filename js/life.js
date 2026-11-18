/**
 * APEXON Weather · 生活判断层
 *
 * 这里只做「把数字翻译成人话」：
 * 晨间三件事、屋檐、通勤、周末、身体感知、睡眠、节气、问候、约定、色卡、暖光。
 * 全部是纯函数（除约定存储），不碰 DOM，方便 app.js 复用与单测。
 */

import { storage } from './common.js';
import { getLanguage } from './i18n.js';

const isZh = () => String(getLanguage()).startsWith('zh');
const P = (zhText, enText) => (isZh() ? zhText : enText);
const num = (v, fb = NaN) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const hh = (n) => `${String(n).padStart(2, '0')}:00`;

/* ------------------------------------------------------- 穿衣建议（D1） */

/**
 * 以体感温度为准，风大再降一档。返回 {level, key} 供界面选图层。
 */
export function wearAdvice(feelsLike, windScale = 0) {
  const t = num(feelsLike, num(feelsLike, 20)) - (num(windScale, 0) >= 5 ? 2 : 0);
  if (t >= 30) return { level: 'hot', key: P('短袖、短裤，尽量待在阴凉处', 'T-shirt and shorts; stay in the shade') };
  if (t >= 25) return { level: 'warm', key: P('短袖或薄衬衫', 'T-shirt or light shirt') };
  if (t >= 20) return { level: 'mild', key: P('长袖加一件薄外套', 'Long sleeves and a light jacket') };
  if (t >= 15) return { level: 'cool', key: P('薄外套或针织衫', 'Light jacket or knitwear') };
  if (t >= 10) return { level: 'chill', key: P('外套加一件内搭', 'Jacket over a warm layer') };
  if (t >= 5) return { level: 'cold', key: P('厚外套，风大时加围巾', 'Thick coat; add a scarf if windy') };
  if (t >= 0) return { level: 'freezing', key: P('羽绒服，手脚都要护住', 'Down jacket — keep hands and feet warm') };
  return { level: 'ice', key: P('最厚的那件，别硬扛', 'Your warmest coat — no need to tough it out') };
}

/* --------------------------------------------------- 晨间三件事（E5） */

/**
 * 第一屏顶部那三行：什么时间、发生什么、要做什么。
 * 只在 04:00–11:00 之间出现，其余时间首页保持干净。
 */
export function buildMorningFacts(weather, now = new Date()) {
  const out = [];
  const rt = weather?.realtime;
  const hourly = Array.isArray(weather?.hourly) ? weather.hourly : [];
  const daily = Array.isArray(weather?.daily) ? weather.daily : [];
  const today = daily[0] || {};
  if (!rt) return out;

  // 1. 现在出门穿什么
  const wear = wearAdvice(rt.feelsLike ?? rt.temp, rt.windScale);
  out.push({ time: hh(now.getHours()), text: P('现在出门', 'Leaving now'), detail: wear.key, kind: 'wear' });

  // 2. 未来 12 小时内的第一场雨（有才说）
  const startHour = now.getHours();
  const rainAt = hourly.find((h) => {
    const hh2 = parseInt(String(h.fxTime || '').slice(11, 13), 10);
    const inWindow = hh2 >= startHour && hh2 <= Math.min(23, startHour + 12);
    const wet = String(h.text || '').includes('雨') || String(h.text || '').toLowerCase().includes('rain');
    return inWindow && wet;
  });
  if (rainAt) {
    const hh2 = parseInt(String(rainAt.fxTime || '').slice(11, 13), 10);
    out.push({
      time: hh(hh2),
      text: P(`${hh2} 点前后有雨`, `Rain around ${hh2}:00`),
      detail: P('出门带伞，别把外套晾在阳台', 'Take an umbrella; bring the laundry in'),
      kind: 'rain',
    });
  }

  // 3. 温度峰值或日落，取更靠前的那个
  const maxT = num(today.tempMax);
  const maxHour = hourly.reduce((acc, h) => {
    const t = num(h.temp);
    return t > acc.t ? { t, h: parseInt(String(h.fxTime || '').slice(11, 13), 10) } : acc;
  }, { t: -999, h: -1 });
  const sunset = weather?.astronomy?.sunset || '';
  if (maxHour.h >= 0 && Number.isFinite(maxT)) {
    out.push({
      time: hh(maxHour.h),
      text: P(`最热 ${Math.round(maxHour.t)}°`, `Peak ${Math.round(maxHour.t)}°`),
      detail: P('正午前后少在户外久待', 'Avoid long stretches outdoors at midday'),
      kind: 'temp',
    });
  } else if (sunset) {
    out.push({ time: sunset, text: P('日落', 'Sunset'), detail: P('适合散步的一小段光', 'A short window of good light'), kind: 'sun' });
  }
  return out.slice(0, 3);
}

/* ------------------------------------------------------- 屋檐（C1） */

/**
 * 「再等 23 分钟，雨会小一点」——只在下雨且分钟级数据可用时给。
 */
export function eavesAdvice(minutely, hourly, now = new Date()) {
  const list = Array.isArray(minutely) ? minutely : [];
  if (list.length) {
    let stopAt = -1;
    for (let i = 0; i < list.length; i += 1) {
      const p = num(list[i]?.precip, 0);
      if (p <= 0.03) { stopAt = i; break; }
    }
    if (stopAt > 0) {
      return { text: P(`再等 ${stopAt * 5} 分钟，雨会停`, `About ${stopAt * 5} min until it eases`), tone: 'wait' };
    }
  }
  const hourlyList = Array.isArray(hourly) ? hourly : [];
  const nowH = now.getHours();
  const rainHour = hourlyList.find((h) => {
    const hh2 = parseInt(String(h.fxTime || '').slice(11, 13), 10);
    const wet = String(h.text || '').includes('雨') || String(h.text || '').toLowerCase().includes('rain');
    return hh2 > nowH && hh2 <= nowH + 3 && wet;
  });
  if (rainHour) {
    const hh2 = parseInt(String(rainHour.fxTime || '').slice(11, 13), 10);
    return { text: P(`这阵雨大概 ${hh2} 点前后会过去`, `This rain should pass around ${hh2}:00`), tone: 'wait' };
  }
  return null;
}

/* ------------------------------------------------------- 通勤（C2） */

/**
 * 只给一个时间窗，不给「建议 7:45 出发」这种假精确。
 * 有雨优先避开雨最大的那一小时。
 */
export function commuteAdvice(weather, now = new Date()) {
  const hourly = Array.isArray(weather?.hourly) ? weather.hourly : [];
  if (!hourly.length) return null;
  const start = Math.max(6, now.getHours());
  const window = hourly.filter((h) => {
    const hh2 = parseInt(String(h.fxTime || '').slice(11, 13), 10);
    return hh2 >= start && hh2 <= 10;
  });
  if (!window.length) return null;

  const score = (h) => {
    const text = String(h.text || '');
    const wet = text.includes('雨') || text.toLowerCase().includes('rain');
    const pop = num(h.pop, 0);
    const temp = num(h.temp, 20);
    return (wet ? 60 : 0) + pop * 0.4 + Math.abs(temp - 20) * 0.6;
  };
  const best = window.reduce((a, b) => (score(b) < score(a) ? b : a), window[0]);
  const worst = window.reduce((a, b) => (score(b) > score(a) ? b : a), window[0]);
  if (score(best) >= 55) {
    return { text: P('今早通勤整体不太好，能晚半小时就晚半小时', 'Rough commute this morning — delay it if you can'), tone: 'bad' };
  }
  if (score(worst) - score(best) >= 30) {
    const h = parseInt(String(best.fxTime || '').slice(11, 13), 10);
    return { text: P(`${h} 点前后最好走，${parseInt(String(worst.fxTime || '').slice(11, 13), 10)} 点那段最差`, `Best around ${h}:00, worst at ${parseInt(String(worst.fxTime || '').slice(11, 13), 10)}:00`), tone: 'ok' };
  }
  return { text: P('今早路面和能见度都还正常', 'Roads and visibility look fine this morning'), tone: 'ok' };
}

/* ------------------------------------------------------- 周末（C4） */

export function weekendPlan(weather, now = new Date()) {
  const daily = Array.isArray(weather?.daily) ? weather.daily : [];
  if (!daily.length) return null;
  const weekday = now.getDay();
  const offsets = weekday === 6 ? [0, 1] : weekday === 0 ? [0] : [6 - weekday, 7 - weekday];
  const pick = offsets.map((o) => daily[o]).filter(Boolean);
  if (!pick.length) return null;

  const rank = (d) => {
    const text = String(d.textDay || '');
    const wet = text.includes('雨') || text.toLowerCase().includes('rain');
    const pop = num(d.pop, 0);
    const max = num(d.tempMax, 22);
    return (wet ? 80 : 0) + pop * 0.5 + Math.abs(max - 24) * 1.2;
  };
  const best = pick.reduce((a, b) => (rank(b) < rank(a) ? b : a), pick[0]);
  const text = String(best.textDay || '');
  const wet = text.includes('雨') || text.toLowerCase().includes('rain');
  const suggestion = wet
    ? P('带伞走一段，找家店坐一会儿也算出门', 'Take an umbrella for a short walk; a café counts too')
    : num(best.tempMax) >= 30
      ? P('早上或傍晚出门，中间留给室内', 'Go out early or late; keep midday indoors')
      : P('上午最适合到处走走', 'Late morning is the best window');
  return {
    day: P(weekday === 6 || weekday === 0 ? '这个周末' : '周末', 'This weekend'),
    date: best.fxDate || '',
    text: P(`${best.fxDate?.slice(5) || ''} ${text} ${Math.round(num(best.tempMin, 0))}–${Math.round(num(best.tempMax, 0))}°`, `${text} ${Math.round(num(best.tempMin, 0))}–${Math.round(num(best.tempMax, 0))}°`),
    suggestion,
  };
}

/* --------------------------------------------------- 身体感知（D1） */

export function bodySense(weather) {
  const rt = weather?.realtime;
  if (!rt) return null;
  const temp = num(rt.temp, 20);
  const hum = num(rt.humidity, 50);
  const press = num(rt.pressure, 1013);
  const tips = [];
  if (temp >= 30 && hum >= 70) tips.push(P('闷热，汗蒸发不掉，补水要比平时多', 'Muggy — sweat won’t evaporate; drink more than usual'));
  if (temp <= 5) tips.push(P('冷得直接，手指会僵，别长时间在户外拿着手机', 'Bone-cold — fingers stiffen fast outdoors'));
  if (hum <= 30) tips.push(P('空气干，喉咙和皮肤会先抗议', 'Dry air — your throat and skin will notice first'));
  if (press <= 1000) tips.push(P('气压偏低，容易犯困或头沉', 'Low pressure — expect drowsiness or a heavy head'));
  if (press >= 1025) tips.push(P('气压偏高，敏感的人会有点耳鸣', 'High pressure — sensitive ears may pop'));
  if (!tips.length) return null;
  return { text: tips[0] };
}

/* ------------------------------------------------------- 睡眠（D2） */

export function sleepTip(weather) {
  const hourly = Array.isArray(weather?.hourly) ? weather.hourly : [];
  const nightly = hourly.filter((h) => {
    const hh2 = parseInt(String(h.fxTime || '').slice(11, 13), 10);
    return hh2 >= 22 || hh2 <= 5;
  });
  if (!nightly.length) return null;
  const minT = nightly.reduce((m, h) => Math.min(m, num(h.temp, 99)), 99);
  const wet = nightly.some((h) => String(h.text || '').includes('雨'));
  if (minT <= 10) {
    return { text: P(`夜里会降到 ${Math.round(minT)}°，被子换厚的`, `Down to ${Math.round(minT)}° tonight — thicker duvet`) };
  }
  if (wet) return { text: P('夜里有雨声，开一点窗会更凉', 'Rain tonight — a cracked window will cool things down') };
  if (minT >= 27) return { text: P(`夜里还有 ${Math.round(minT)}°，风扇别对着头`, `${Math.round(minT)}° overnight — keep the fan off your head`) };
  return null;
}

/* ------------------------------------------------- 宠物遛弯（D4） */

/**
 * 地面温度不等于气温：晴天柏油路面比空气高十几度。
 * 这里只做保守估算，给出「烫脚 / 偏热 / 舒服 / 结冰」四档，不假装是红外测温。
 */
export function petAdvice(weather, now = new Date()) {
  const rt = weather?.realtime;
  if (!rt) return null;
  const air = num(rt.temp, NaN);
  if (!Number.isFinite(air)) return null;
  const hour = now.getHours();
  const isDay = hour >= 7 && hour < 19;
  const cloud = num(rt.cloud, 50);
  const wet = /雨|雪|rain|snow/i.test(String(rt.text || ''));
  const boost = isDay && !wet ? (cloud < 40 ? 15 : 9) : 3;
  const ground = Math.round(air + boost);

  if (ground >= 52) {
    return { ground, tone: 'alert', text: P(`地面约 ${ground}°，光脚会烫，等太阳弱些再出门`, `Ground ≈ ${ground}° — too hot for paws; wait until the sun eases`) };
  }
  if (ground >= 42) {
    return { ground, tone: 'warn', text: P(`地面约 ${ground}°，走阴面、别久留`, `Ground ≈ ${ground}° — keep to shade and keep it short`) };
  }
  if (air <= -5) {
    return { ground, tone: 'alert', text: P(`气温 ${Math.round(air)}°，路面可能结冰，短距离就好`, `Air is ${Math.round(air)}° — paths may be icy; keep it short`) };
  }
  if (air <= 2) {
    return { ground, tone: 'warn', text: P('接近冰点，出门前先试试地面滑不滑', 'Near freezing — test the ground before a longer walk') };
  }
  if (ground >= 18 && ground <= 30) {
    return { ground, tone: 'ok', text: P(`地面约 ${ground}°，正是遛弯的温度`, `Ground ≈ ${ground}° — a good temperature for a walk`) };
  }
  return null;
}

/* --------------------------------------------------- 节气（E3） */

const TERM_NAMES = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];
const TERM_NAMES_EN = ['Minor Cold', 'Major Cold', 'Start of Spring', 'Rain Water', 'Awakening', 'Spring Equinox', 'Clear and Bright', 'Grain Rain', 'Start of Summer', 'Grain Full', 'Grain in Ear', 'Summer Solstice', 'Minor Heat', 'Major Heat', 'Start of Autumn', 'End of Heat', 'White Dew', 'Autumn Equinox', 'Cold Dew', 'Frost Descent', 'Start of Winter', 'Minor Snow', 'Major Snow', 'Winter Solstice'];
// 21 世纪的节气系数（通用近似算法，误差 ±1 天，展示用途足够）
const TERM_C = [5.4055, 20.12, 3.87, 18.73, 5.63, 20.646, 4.81, 20.1, 5.52, 21.04, 5.678, 21.37, 7.108, 22.83, 7.5, 23.13, 7.646, 23.042, 8.318, 23.438, 7.438, 22.36, 7.18, 21.94];

function termDate(year, i) {
  const yy = year % 100;
  const month = Math.floor(i / 2) + 1;
  const day = Math.floor(yy * 0.2422 + TERM_C[i]) - Math.floor((yy - 1) / 4);
  const d = new Date(year, month - 1, Math.max(1, day));
  return d;
}

export function solarTermOf(now = new Date()) {
  const y = now.getFullYear();
  for (let i = 0; i < 24; i += 1) {
    const d = termDate(y, i);
    if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return { index: i, name: isZh() ? TERM_NAMES[i] : TERM_NAMES_EN[i] };
    }
  }
  // 最近的节气还有几天（首页只在 3 天内提示）
  let next = null;
  for (let i = 0; i < 24; i += 1) {
    const d = termDate(y, i);
    const diff = Math.round((d - new Date(y, now.getMonth(), now.getDate())) / 86400000);
    if (diff > 0 && diff <= 3) { next = { index: i, name: isZh() ? TERM_NAMES[i] : TERM_NAMES_EN[i], inDays: diff }; break; }
  }
  return next;
}

/* --------------------------------------------------- 节日（E3） */

const FIXED_FESTIVALS = [
  ['01-01', '元旦', 'New Year'],
  ['02-14', '情人节', "Valentine's Day"],
  ['03-08', '妇女节', "Women's Day"],
  ['05-01', '劳动节', 'Labour Day'],
  ['06-01', '儿童节', "Children's Day"],
  ['09-10', '教师节', "Teachers' Day"],
  ['10-01', '国庆', 'National Day'],
  ['12-24', '平安夜', 'Christmas Eve'],
  ['12-25', '圣诞', 'Christmas'],
];

// 农历大节的公历日期（2025–2030，仅用于温柔提示）
const LUNAR_FESTIVALS = {
  '2025-01-29': ['春节', 'Spring Festival'], '2026-02-17': ['春节', 'Spring Festival'],
  '2027-02-06': ['春节', 'Spring Festival'], '2028-01-26': ['春节', 'Spring Festival'],
  '2029-02-13': ['春节', 'Spring Festival'], '2030-02-03': ['春节', 'Spring Festival'],
  '2025-05-31': ['端午', 'Dragon Boat'], '2026-06-19': ['端午', 'Dragon Boat'],
  '2027-06-09': ['端午', 'Dragon Boat'], '2028-05-28': ['端午', 'Dragon Boat'],
  '2029-06-16': ['端午', 'Dragon Boat'], '2030-06-05': ['端午', 'Dragon Boat'],
  '2025-10-06': ['中秋', 'Mid-Autumn'], '2026-09-25': ['中秋', 'Mid-Autumn'],
  '2027-09-15': ['中秋', 'Mid-Autumn'], '2028-10-03': ['中秋', 'Mid-Autumn'],
  '2029-09-22': ['中秋', 'Mid-Autumn'], '2030-09-12': ['中秋', 'Mid-Autumn'],
};

export function festivalOf(now = new Date()) {
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lunar = LUNAR_FESTIVALS[key];
  if (lunar) return { name: isZh() ? lunar[0] : lunar[1] };
  const md = key.slice(5);
  const fixed = FIXED_FESTIVALS.find((f) => f[0] === md);
  return fixed ? { name: isZh() ? fixed[1] : fixed[2] } : null;
}

/* ------------------------------------------------- 问候（I6） */

export function greetingFor(now = new Date(), weather) {
  const h = now.getHours();
  const text = String(weather?.realtime?.text || '');
  const wet = text.includes('雨') || text.toLowerCase().includes('rain');
  if (now.getMonth() >= 2 && now.getMonth() <= 4 && h >= 5 && h < 9) return P('春天最好的时段，风是软的', 'The softest hour of spring');
  if (h < 5) return P('这个点还醒着，天亮还早', "Still up — dawn is a while away");
  if (h < 9) return wet ? P('下雨的早上，路上会慢一点', 'A rainy morning; the roads will be slower') : P('早，今天从一杯热的开始', 'Morning — start with something warm');
  if (h < 12) return P('上午', 'Late morning');
  if (h < 14) return P('中午了，别拖着不吃', "It's noon — don't skip lunch");
  if (h < 17) return P('下午', 'Afternoon');
  if (h < 19) return wet ? P('傍晚有雨，回去的路留点时间', 'Rain at dusk — leave earlier for home') : P('天要暗了', 'The light is going');
  return P('晚上了，把屏幕调暗一点', 'Evening — dim the screen a little');
}

/* --------------------------------------------------- 约定（E3） */

const PROMISE_KEY = 'apexon_promises';

export function getPromises() {
  const list = storage.get(PROMISE_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function addPromise(text, withPersonId) {
  const clean = String(text || '').trim().slice(0, 40);
  if (!clean) return getPromises();
  const list = getPromises();
  list.unshift({ id: `pr_${Date.now().toString(36)}`, text: clean, withPersonId: withPersonId || null, done: false, at: Date.now() });
  storage.set(PROMISE_KEY, list.slice(0, 50));
  return getPromises();
}

export function togglePromise(id) {
  const list = getPromises().map((p) => (p.id === id ? { ...p, done: !p.done } : p));
  storage.set(PROMISE_KEY, list);
  return list;
}

export function removePromise(id) {
  const list = getPromises().filter((p) => p.id !== id);
  storage.set(PROMISE_KEY, list);
  return list;
}

/** 基于今天/明天的天气给 3 条候选，用户可换一批（永不自动添加） */
export function promiseSuggestions(weather) {
  const daily = Array.isArray(weather?.daily) ? weather.daily : [];
  const today = daily[0] || {};
  const tomorrow = daily[1] || {};
  const t = String(today.textDay || '');
  const wet = t.includes('雨') || t.toLowerCase().includes('rain');
  const pool = wet
    ? [
      P('一起把伞送到楼下', 'Walk down with an umbrella'),
      P('雨天不出门，视频聊十分钟', 'Skip the trip — ten minutes on video'),
      P('点一份热的，别将就', 'Order something hot'),
      P('把这周的合照整理一下', "Sort this week's photos"),
    ]
    : [
      P('去楼下走一圈，二十分钟', 'A twenty-minute walk downstairs'),
      P('一起去买点水果', 'Go buy some fruit together'),
      P('找个有窗的位置坐一会儿', 'Find a seat by a window'),
      P('把想说的话说出口', 'Say the thing you have been holding'),
    ];
  if (num(tomorrow.tempMax) - num(today.tempMax) <= -6) {
    pool.unshift(P('提醒 TA 明天加件外套', 'Remind them about a warmer coat tomorrow'));
  }
  return pool.slice(0, 3);
}

/* --------------------------------------------- 天气色卡（F1） */

/**
 * 由天气 + 温度推导四段渐变，供「天气色卡」和分享图共用。
 * 不用图标映射表，避免出现二十几种花哨配色——只在冷/暖/雨/雪四个轴上偏移。
 */
export function skyPalette(weather, isDay = true) {
  const rt = weather?.realtime || {};
  const temp = num(rt.temp, 20);
  const text = String(rt.text || '');
  const wet = text.includes('雨') || text.toLowerCase().includes('rain');
  const snow = text.includes('雪') || text.toLowerCase().includes('snow');

  if (!isDay) return ['#0b1220', '#132037', '#1b2a44', '#24384f'];
  if (snow) return ['#dbe7f0', '#e9f1f7', '#cfdde9', '#b9cbd9'];
  if (wet) return ['#6f7f8e', '#8a99a6', '#a7b3bd', '#c2ccd3'];
  if (temp >= 30) return ['#ffd9a8', '#f7c58a', '#e8a86f', '#cf8b5e'];
  if (temp >= 20) return ['#fdf3d9', '#f5e6c4', '#e6d3ae', '#cfbe9c'];
  if (temp >= 10) return ['#eef3f8', '#dfe8f2', '#cfdceb', '#bfcfdf'];
  return ['#e8eef6', '#d7e2ee', '#c6d4e3', '#b3c3d4'];
}

/* ------------------------------------------------ 暖光（F5 / A5） */

/**
 * 日出后 / 日落前 90 分钟内，返回 0–1 的暖光强度。
 * 用于给整页加一层极淡的暖色，不是遮罩、不是光晕。
 */
export function warmLightFactor(weather, now = new Date()) {
  const a = weather?.astronomy;
  if (!a?.sunrise || !a?.sunset) return 0;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return Number.isFinite(h) ? h * 60 + (m || 0) : -1;
  };
  const sr = toMin(a.sunrise);
  const ss = toMin(a.sunset);
  if (sr < 0 || ss < 0) return 0;
  const near = (target) => 1 - Math.min(1, Math.abs(minutes - target) / 90);
  return Math.max(0, Math.min(1, Math.max(near(sr) * 0.8, near(ss))));
}

/* ------------------------------------------------ 字体情绪（F4） */

/**
 * 极小的差异：晴字更松、雨字更紧、雪字更轻。
 * 数值刻意克制（字重最多差 100，字距最多 0.02em），不做夸张变形。
 */
export function typographyMood(weather) {
  const text = String(weather?.realtime?.text || '');
  if (text.includes('雨') || text.toLowerCase().includes('rain')) return { weight: 600, spacing: '-0.02em' };
  if (text.includes('雪') || text.toLowerCase().includes('snow')) return { weight: 300, spacing: '0.01em' };
  if (text.includes('晴') || text.toLowerCase().includes('sun')) return { weight: 500, spacing: '0em' };
  return { weight: 450, spacing: '-0.005em' };
}

/* ------------------------------------------------ 同一片天空（B10） */

export function sameSkyLine(localKind, farKind) {
  const pair = `${localKind}-${farKind}`;
  const map = {
    'rain-rain': P('你们那边都在下雨', "It's raining in both places"),
    'sun-sun': P('两边都是好天气', 'Clear skies in both places'),
    'snow-snow': P('两边都在下雪', "It's snowing in both places"),
    'sun-rain': P('你这里晴，TA 那边在下雨', "Clear here, raining there"),
    'rain-sun': P('你这里在下雨，TA 那边晴', 'Raining here, clear there'),
    'cloud-cloud': P('两边都是灰灰的云', 'Overcast in both places'),
  };
  return map[pair] || map['cloud-cloud'];
}

export function weatherKindOf(text = '') {
  const s = String(text).toLowerCase();
  if (s.includes('雪') || s.includes('snow')) return 'snow';
  if (s.includes('雨') || s.includes('rain') || s.includes('storm') || s.includes('雷')) return 'rain';
  if (s.includes('晴') || s.includes('sun') || s.includes('clear')) return 'sun';
  return 'cloud';
}

/* ------------------------------------------------- 紫外线（D3） */

/**
 * 和风的逐小时接口不返回 uvIndex，只有 7 天预报里有。
 * 所以这里做「7 天条带」而不是假装有 24 小时曲线：
 * 数字来自接口，最强时段按地理常识给一句固定提醒，不编造分钟级数据。
 */
export function uvWindow(daily) {
  const list = Array.isArray(daily) ? daily.slice(0, 7) : [];
  if (!list.length) return null;
  const days = list.map((d) => ({
    date: d.fxDate || '',
    uv: num(d.uvIndex, NaN),
    text: d.textDay || '',
  })).filter((d) => Number.isFinite(d.uv));
  if (!days.length) return null;
  const max = Math.max(...days.map((d) => d.uv));
  let advice = P('紫外线不强，正常出门就好', 'UV is low — no special care needed');
  if (max >= 8) advice = P('11:00–15:00 最强，这段时间尽量在室内', 'Strongest 11:00–15:00 — stay indoors if you can');
  else if (max >= 6) advice = P('中午前后紫外线偏强，涂防晒、戴帽子', 'UV peaks around midday — sunscreen and a hat');
  else if (max >= 3) advice = P('下午短时间出门问题不大', 'A short trip out in the afternoon is fine');
  return { days, max, advice };
}

/* --------------------------------------------- 气压感知（A3） */

/**
 * 只解释、不吓人：低气压/高气压给一句事实 + 共情，绝不写「可能导致偏头痛」。
 */
export function pressureNote(weather) {
  const p = num(weather?.realtime?.pressure, NaN);
  if (!Number.isFinite(p)) return null;
  if (p < 1000) {
    return {
      hpa: Math.round(p),
      tone: 'low',
      text: P(`今天气压低（${Math.round(p)} hPa），如果有点累，不是你的问题。`, `Pressure is low today (${Math.round(p)} hPa). If you feel tired, it is not you.`),
    };
  }
  if (p >= 1025) {
    return {
      hpa: Math.round(p),
      tone: 'high',
      text: P(`今天气压偏高（${Math.round(p)} hPa），敏感的人可能有点耳鸣。`, `Pressure is high today (${Math.round(p)} hPa). Sensitive ears may notice.`),
    };
  }
  return null;
}

/* --------------------------------------------- 积温（E4） */

function gddStage(gdd, isZhText) {
  if (gdd >= 200) return isZhText ? '花已经开盛了' : 'Full bloom';
  if (gdd >= 120) return isZhText ? '桃花该开了' : 'Peach trees should be blooming';
  if (gdd >= 60) return isZhText ? '芽在动，还差一阵暖' : 'Buds are moving — a little more warmth';
  return isZhText ? '积温还早，慢慢等' : 'Still early — wait for more warmth';
}

/**
 * 从 2 月 1 日起按 max(0,(最高+最低)/2 - 5) 累加。
 * 只是物候估算，不承诺花期；数据不足 20 天直接不显示。
 */
export function gddSummary(capsules) {
  const list = Array.isArray(capsules) ? capsules : [];
  const year = new Date().getFullYear();
  const rows = list
    .filter((c) => String(c.date).startsWith(String(year)))
    .filter((c) => {
      const [, m, d] = String(c.date).split('-').map(Number);
      return m > 2 || (m === 2 && d >= 1);
    });
  if (rows.length < 20) return null;
  let gdd = 0;
  rows.forEach((c) => {
    const max = num(c.tempMax, num(c.temp, 0));
    const min = num(c.tempMin, num(c.temp, 0));
    gdd += Math.max(0, (max + min) / 2 - 5);
  });
  return {
    gdd: Math.round(gdd),
    days: rows.length,
    stage: gddStage(gdd, isZh()),
  };
}

/* --------------------------------------------- 温度距平（G3） */

/**
 * 优先与「同月同旬」的历史均值比；没有历史就退一步与上一个 10 天段比，
 * 并在返回里标明 scope，界面据此改口径，绝不把两种比较混着说。
 */
export function tempAnomaly(capsules) {
  const list = Array.isArray(capsules) ? capsules : [];
  if (list.length < 30) return null;
  const recent = list.slice(0, 10);
  const recentAvg = recent.reduce((s, c) => s + num(c.temp, 0), 0) / recent.length;

  const currentYear = new Date().getFullYear();
  const first = recent[0]?.date || '';
  const [, m, d] = first.split('-').map(Number);
  const block = Math.floor((d - 1) / 10);
  const history = list.filter((c) => {
    const [y, mm, dd] = String(c.date).split('-').map(Number);
    if (y >= currentYear) return false;
    if (Math.abs(mm - m) > 1) return false;
    return Math.floor((dd - 1) / 10) === block;
  });
  if (history.length >= 5) {
    const base = history.reduce((s, c) => s + num(c.temp, 0), 0) / history.length;
    const diff = Math.round(recentAvg - base);
    return {
      diff,
      scope: 'history',
      text: Math.abs(diff) < 1
        ? P('和常年同期差不多', 'About the same as usual for this time of year')
        : diff > 0
          ? P(`比常年同期高 ${diff} 度`, `${diff}° warmer than usual for this time of year`)
          : P(`比常年同期低 ${Math.abs(diff)} 度`, `${Math.abs(diff)}° cooler than usual for this time of year`),
    };
  }

  const prev = list.slice(10, 20);
  if (prev.length < 5) return null;
  const prevAvg = prev.reduce((s, c) => s + num(c.temp, 0), 0) / prev.length;
  const diff = Math.round(recentAvg - prevAvg);
  if (Math.abs(diff) < 1) return null;
  return {
    diff,
    scope: 'recent',
    text: diff > 0
      ? P(`比上一个十天的均温高 ${diff} 度`, `${diff}° warmer than the previous ten days`)
      : P(`比上一个十天的均温低 ${Math.abs(diff)} 度`, `${Math.abs(diff)}° cooler than the previous ten days`),
  };
}
