/**
 * APEXON Weather - 写实风天气背景系统（全场景视频）
 *
 * 所有天气类型均使用 MP4 视频循环播放，图片仅作降级后备：
 * - sunny-day.mp4     晴天（白天）
 * - cloudy-day.mp4    多云
 * - rainy.mp4         雨天
 * - clear-night.mp4   晴朗夜空
 * - thunderstorm.mp4  雷暴
 * - snowy.mp4         雪天
 * - overcast.mp4      阴天
 * - foggy.mp4         雾天
 */

/**
 * 视频资源（全场景 MP4）
 *
 * 注意：clear-night 刻意不在列表里。
 * v2.7 的月色视频观感生硬（月盘比例过大、云层循环接缝明显），
 * 实测直接换回静态夜景（clear-night.jpg + 夜空渐变）观感更好，
 * 也省掉一整路全屏视频解码 —— 夜间本来就是用户躺着刷手机的高频时段。
 */
const WEATHER_VIDEOS = {
  'sunny-day': 'assets/weather-bg/sunny-day.mp4',
  'cloudy-day': 'assets/weather-bg/cloudy-day.mp4',
  'rainy': 'assets/weather-bg/rainy.mp4',
  'thunderstorm': 'assets/weather-bg/thunderstorm.mp4',
  'snowy': 'assets/weather-bg/snowy.mp4',
  'overcast': 'assets/weather-bg/overcast.mp4',
  'foggy': 'assets/weather-bg/foggy.mp4',
};

/** 图片资源（没有视频的天气类型用图片，以及视频降级后备） */
const WEATHER_IMAGES = {
  'sunny-day': 'assets/weather-bg/sunny-day.jpg',
  'cloudy-day': 'assets/weather-bg/cloudy-day.jpg',
  'rainy': 'assets/weather-bg/rainy.jpg',
  'clear-night': 'assets/weather-bg/clear-night.jpg',
  'thunderstorm': 'assets/weather-bg/thunderstorm.jpg',
  'snowy': 'assets/weather-bg/snowy.jpg',
  'overcast': 'assets/weather-bg/overcast.jpg',
  'foggy': 'assets/weather-bg/foggy.jpg',
};

/** 天气场景对应的 CSS 渐变变量名 */
const SCENE_GRADIENTS = {
  'sunny-day': '--weather-sunny',
  'cloudy-day': '--weather-cloudy',
  'rainy': '--weather-rainy',
  'snowy': '--weather-snowy',
  'thunderstorm': '--weather-thunder',
  'foggy': '--weather-foggy',
  'overcast': '--weather-cloudy',
  'clear-night': '--weather-night',
};

/** 当前显示的场景类型 */
let currentScene = '';

/**
 * 依据和风天气的 text 描述解析场景。
 * text 是接口给出的权威人类可读描述，比 icon 数字更可靠
 * （实测部分城市 icon 会出现空值/错值，而 text 始终正常）。
 * 覆盖 zh / zh-hant / en / ja / ko / fr / de / es / pt / ru 十种语言。
 *
 * 判定顺序（越靠前优先级越高）：
 *   雪 → 雾霾沙尘 → 雷暴 → 雨 → 阴 → 多云 → 晴
 * 之所以把"雾霾沙尘"排在"雷暴"之前：英文沙尘暴是 Sandstorm / Dust storm，
 * 若先跑 `storm` 会被判成雷暴，而它其实是沙尘场景。
 * @returns {string|null}
 */
function resolveSceneFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;

  // 雪（含雨夹雪、阵雪、暴雪、冰雹、冻雨）
  if (/雪|冰雹|冻雨|hail|sleet|snow|blizzard|눈|설|neige|Schnee|nieve|neve|снег/i.test(s)) return 'snowy';

  // 雾 / 霾 / 沙尘 / 浮尘 / 扬沙（含 zh-hant 霧、塵）
  if (/雾|霧|霾|沙|尘|塵|fog|mist|haze|smog|dust|sand|smoke|안개|brouillard|Nebel|niebla|névoa|nevoeiro|туман|дымк/i.test(s)) return 'foggy';

  // 雷暴 / 雷电
  if (/雷|thunder|lightning|storm|뇌|번개|orage|Gewitter|tormenta|trovoada|гроза/i.test(s)) return 'thunderstorm';

  // 雨（含阵雨、毛毛雨、暴雨）
  if (/雨|rain|drizzle|shower|downpour|비|pluie|Regen|lluvia|chuva|дожд/i.test(s)) return 'rainy';

  // 阴（zh-hant 陰、日语也作 曇り 之外的阴天用词）
  if (/阴|陰|overcast|cloudy\s*sky|흐림|couvert|cubierto|bedeckt|encoberto|пасмурн/i.test(s)) return 'overcast';

  // 多云 / 少云 / 晴间多云 / 局部多云（zh-hant 多雲、日 曇、德 bewölkt、西 nuboso、葡 nublado、法 nuageux）
  if (/多云|多雲|少云|少雲|局部|曇|partly|mostly\s*cloudy|cloudy|few\s*clouds|scattered|구름|partiellement|teilweise|parcialmente|bewölk|nuag|nublad|nubos|облачн/i.test(s)) return 'cloudy-day';

  // 晴 / 晴朗 / 晴间多云
  if (/晴|clear|sunny|sunshine|맑|ensoleillé|sonnig|klar|despejado|limpo|ясн|солнечн|dégag|degage/i.test(s)) return 'sunny-day';

  return null;
}

/**
 * 依据 icon 代码区间兜底解析场景。
 * 和风代码为分段设计（3xx 雨 / 4xx 雪 / 5xx 雾霾沙尘 / 9xx 特殊），
 * 即使出现未列举的新代码也能落到合理场景，避免误判成雾天。
 */
function resolveSceneFromRange(code, isDay) {
  if (code >= 300 && code <= 399) return 'rainy';
  if (code >= 400 && code <= 499) return 'snowy';
  if (code >= 500 && code <= 599) return 'foggy';
  // 900 热 / 901 冷 / 999 未知都不是天气现象，不能当雷暴处理
  if (code >= 902 && code <= 998) return 'thunderstorm';
  return null;
}

/**
 * 根据和风天气 icon 代码映射到场景类型
 * @param {string} iconCode - 和风天气图标代码
 * @param {boolean} isDay - 是否白天
 * @returns {string} 场景类型 key
 */
function resolveWeatherScene(iconCode, isDay) {
  const code = parseInt(iconCode, 10);

  if (Number.isNaN(code)) return null;

  // 雷暴优先判断（白天黑夜都一样）
  if ([302, 303, 304, 307, 308, 314, 315, 317, 318, 350, 351].includes(code)) return 'thunderstorm';
  // 900/901（热/冷）、999（未知）不是天气现象本身，交给 text 与区间兜底，避免误判
  if (code >= 902 && code <= 998) return 'thunderstorm';

  // 雨类（白天黑夜都一样）
  if ([300, 301, 305, 306, 309, 310, 311, 312, 313, 316, 399].includes(code)) return 'rainy';

  // 雪类
  if ([400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 456, 457, 499].includes(code)) return 'snowy';

  // 沙尘类（503, 504, 507, 508）- 归为阴天场景
  if ([503, 504, 507, 508].includes(code)) return 'overcast';

  // 雾/霾类（500, 501, 502, 509-515, 599）
  if ([500, 501, 502, 509, 510, 511, 512, 513, 514, 515, 599].includes(code)) return 'foggy';

  // 阴天（104 白天 / 154 夜间）
  if (code === 104 || code === 154) return 'overcast';

  // 多云（101 多云 / 102 少云 / 103 晴间多云；151-153 为夜间对应值）
  if ([101, 102, 103].includes(code)) return isDay ? 'cloudy-day' : 'clear-night';
  if ([151, 152, 153].includes(code)) return 'clear-night';

  // 晴（100 白天 / 150 夜间）
  if (code === 100) return isDay ? 'sunny-day' : 'clear-night';
  if (code === 150) return 'clear-night';

  return null;
}

/**
 * 综合解析：优先用 text 描述判定（比 icon 代码可靠），
 * text 无法识别时退回 icon 代码与区间兜底。
 * 夜间非降水天气统一显示星空场景。
 */
function resolveScene(iconCode, text, isDay) {
  // 顺序很关键：text 比 icon 更可靠（实测部分城市 icon 会返回错值，
  // 例如晴天却返回 500 雾，导致"明明是晴却显示雾天"）。
  // 因此先按 text 判场景，text 无法识别时才退回 icon 代码。
  let scene = resolveSceneFromText(text);
  if (!scene) {
    scene = resolveWeatherScene(iconCode, isDay);
  }
  if (!scene) {
    // 未列举的 icon 代码按区间归类兜底
    const code = parseInt(iconCode, 10);
    if (!Number.isNaN(code)) scene = resolveSceneFromRange(code, isDay);
  }
  if (!scene) {
    console.warn('[APEXON BG] 无法解析天气:', iconCode, text, '→ 按默认处理');
    scene = isDay ? 'sunny-day' : 'clear-night';
  }
  // 夜间：只有降水/雾霾类保留自身场景，其余归为星空
  if (!isDay && ['sunny-day', 'cloudy-day', 'overcast'].includes(scene)) {
    scene = 'clear-night';
  }
  return scene;
}

/** 每个场景对应的规范 icon 代码（和风代码），用于纠正接口的错值 */
const SCENE_ICON = {
  'sunny-day': { day: '100', night: '150' },
  'clear-night': { day: '100', night: '150' },
  'cloudy-day': { day: '101', night: '151' },
  overcast: { day: '104', night: '154' },
  rainy: { day: '305', night: '305' },
  snowy: { day: '400', night: '400' },
  foggy: { day: '501', night: '501' },
  thunderstorm: { day: '302', night: '302' },
};

/** 把细分场景归成天气大类，近义差异（晴/多云/阴）不触发替换 */
function sceneGroup(scene) {
  if (scene === 'rainy' || scene === 'snowy' || scene === 'foggy' || scene === 'thunderstorm') return scene;
  return 'fair';
}

/**
 * 校正 icon 代码：接口偶发返回与 text 矛盾的 icon（如晴天却给 500 雾）时，
 * 以 text 为准返回该天气的规范代码，避免"明明是晴却显示雾图标"。
 * 只在 text 可判定、且 icon 所属大类与之冲突时才替换，否则原样返回。
 * @param {string} iconCode - 接口返回的 icon 代码
 * @param {string} text - 接口返回的天气描述（已是应用当前语言）
 * @param {boolean} isDay - 是否白天
 * @returns {string} 校正后的 icon 代码
 */
export function reconcileIcon(iconCode, text, isDay = true) {
  const scene = resolveSceneFromText(text);
  if (!scene) return iconCode;

  const canonical = SCENE_ICON[scene]?.[isDay ? 'day' : 'night'] || iconCode;
  const code = parseInt(iconCode, 10);
  if (Number.isNaN(code)) return canonical;

  const iconScene = resolveWeatherScene(iconCode, isDay) || resolveSceneFromRange(code, isDay);
  if (!iconScene) return canonical;

  return sceneGroup(scene) === sceneGroup(iconScene) ? iconCode : canonical;
}

/**
 * 场景 → Emoji。
 * 安卓桌面小组件的 RemoteViews 只能渲染系统控件，塞不进 SVG 图标，
 * 而 Emoji 是系统字体自带、各品牌 ROM 都有的一套彩色图形，
 * 因此小组件用 Emoji 表达天气，与 App 内的 qi-* 图标保持同一套语义。
 */
const SCENE_EMOJI = {
  'sunny-day': '☀️',
  'clear-night': '🌙',
  'cloudy-day': '⛅',
  overcast: '☁️',
  rainy: '🌧️',
  snowy: '❄️',
  thunderstorm: '⛈️',
  foggy: '🌫️',
};

/**
 * 取天气 Emoji（供桌面小组件使用）。
 * 复用与背景同一套「text 优先、icon 兜底」的判定，保证
 * 小组件上的天气图形和 App 内的背景/图标永远不会互相矛盾。
 * @param {string} iconCode - 和风天气图标代码
 * @param {string} text - 天气描述
 * @param {boolean} isDay - 是否白天
 * @returns {string} Emoji 字符
 */
export function weatherEmoji(iconCode, text, isDay = true) {
  return SCENE_EMOJI[resolveScene(iconCode, text, isDay)] || '☀️';
}

/**
 * 资源预热
 *
 * 图片体积小，作为兜底层直接预热；
 * 视频合计约 26MB，若在模块加载时就对 8 个场景 preload='auto'，
 * 会和首屏 HTML/CSS/JS、天气接口抢带宽（移动端尤其明显），
 * 也与 Service Worker 的"按需缓存"策略相冲突。
 * 因此视频改为浏览器空闲时逐个预热，不阻塞首屏。
 */
const preloadedResources = new Set();

function preloadImage(src) {
  if (preloadedResources.has(src)) return;
  preloadedResources.add(src);
  const img = new Image();
  img.src = src;
}

/**
 * 天气场景是否已完全滚出视口。
 * 场景层是 position: fixed 的顶部横幅（高度 --scene-h），
 * 内容滚动超过它的高度后，视频整块都在视口之外。
 */
let sceneOffscreen = false;

/**
 * 视频只在「页面可见 + 未开启减少动效 + 未滚出视口」时播放。
 * 后台运行时继续解码全屏视频是纯粹的耗电与发热来源，必须暂停；
 * 滚过首屏后同理——此时视频不可见，继续解码只会白白占用硬件解码器，
 * 并让首屏以下那些毛玻璃卡片在滚动时反复重新采样背景。
 */
function syncVideoPlayback() {
  const video = document.getElementById('weather-bg-video');
  if (!video) return;
  const reduced = document.documentElement.dataset.motion === 'reduced';
  // 浅色主题改走静态图：白底界面下视频解码几乎看不出差别，
  // 停掉能省一大块 GPU/电量，也避免亮部过曝把卡片压得发灰。
  const light = document.documentElement.dataset.theme === 'light';
  // 帧率守卫判定为中/低画质时同样停播：全屏视频是最稳定的一笔解码开销，
  // 滚动时它和列表合成抢的是同一个 GPU 队列。
  const tier = document.documentElement.dataset.perf;
  const cheap = tier === 'mid' || tier === 'low';
  // 手指/滚轮正在滚动：先暂停解码。
  // 场景层是 fixed 的，暂停后会保留最后一帧，视觉上只是这一小段不再动；
  // 但滚动期间 GPU 不必同时做「全屏视频解码 + 页面合成」，这是 120Hz 上最实在的一笔。
  if (scrollActive) {
    if (!video.paused) video.pause();
    return;
  }
  if (!document.hidden && !reduced && !light && !cheap && sceneOffscreen) {
    // 只是滚出了视口：暂停但保留最后一帧，滚回来时无需再等 0.8s 淡入
    if (!video.paused) video.pause();
    return;
  }
  const shouldPlay = !document.hidden && !reduced && !light && !cheap;
  if (!shouldPlay) {
    // 隐藏视频层退回图片兜底：暂停但保留最后一帧会定格成一个「假视频」
    if (video.style.opacity !== '0') video.style.opacity = '0';
    if (!video.paused) video.pause();
    return;
  }
  if (video.paused && video.readyState >= 2) {
    video.play().then(() => {
      video.style.opacity = '1';
    }).catch(() => { /* 自动播放被拦截，保留图片层 */ });
  }
}

document.addEventListener('visibilitychange', syncVideoPlayback);

/**
 * 跟踪首屏滚动：只在 .main 真正滚动时测量，且每帧最多一次。
 * 滚动事件用捕获阶段监听——元素的 scroll 事件不会冒泡到 document，
 * 只有捕获阶段能拿到，这样无需关心 .main 何时被创建。
 */
let scrollRaf = 0;
// 滚动活跃状态：滚动期间暂停视频，停止 160ms 后由 syncVideoPlayback 恢复。
// 160ms 覆盖惯性滚动的间歇，避免手指一顿一顿地滑动时反复重启解码。
let scrollActive = false;
let scrollIdleTimer = 0;
// 场景高度缓存：offsetHeight 会强制同步一次排版，滚动中每帧读等于每帧排一次版。
// 高度只随视口尺寸变化，缓存到 resize / 旋转屏幕再失效即可。
let sceneHeightCache = 0;
window.addEventListener('resize', () => { sceneHeightCache = 0; }, { passive: true });

function measureSceneOffscreen() {
  const scene = document.getElementById('weather-scene');
  const main = document.getElementById('main-content');
  if (!scene || !main) return;
  if (!sceneHeightCache) sceneHeightCache = scene.offsetHeight;
  const next = main.scrollTop > sceneHeightCache;
  if (next !== sceneOffscreen) {
    sceneOffscreen = next;
    // 同一个信号也给 CSS 用：首屏滚出视口后暂停 hero 的呼吸动画，
    // 否则那个 8s 循环会一直让合成器保持唤醒，白耗电量
    document.documentElement.dataset.scrolled = next ? '1' : '0';
    syncVideoPlayback();
  }
}
function onMainScroll(event) {
  // 捕获阶段会收到页面上所有滚动容器的事件，这里只关心首屏纵向滚动
  if (!event.target || event.target.id !== 'main-content') return;
  if (!scrollActive) {
    scrollActive = true;
    syncVideoPlayback();
  }
  clearTimeout(scrollIdleTimer);
  scrollIdleTimer = setTimeout(() => {
    scrollActive = false;
    syncVideoPlayback();
  }, 160);
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    measureSceneOffscreen();
  });
}
document.addEventListener('scroll', onMainScroll, { passive: true, capture: true });

new MutationObserver(syncVideoPlayback).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-motion', 'data-theme', 'data-perf'],
});

Object.values(WEATHER_IMAGES).forEach(preloadImage);

/**
 * 设置天气背景（视频或图片）
 * @param {string} iconCode - 和风天气图标代码
 * @param {boolean} isDay - 是否白天
 * @param {string} [text] - 和风天气中文天气描述，icon 异常时兜底
 */
export function setWeatherBackground(iconCode, isDay = true, text = '') {
  const sceneType = resolveScene(iconCode, text, isDay);
  if (sceneType === currentScene) return;

  currentScene = sceneType;
  console.log('[APEXON BG] 场景切换 →', sceneType, '(icon:', iconCode, 'text:', text, 'day:', isDay, ')');

  // 更新背景渐变（视频/图片加载前先显示对应颜色渐变）
  const gradientVar = SCENE_GRADIENTS[sceneType] || '--weather-sunny';
  const sceneEl = document.getElementById('weather-scene');
  if (sceneEl) {
    sceneEl.style.background = `var(${gradientVar})`;
  }

  const videoEl = document.getElementById('weather-bg-video');
  const imgEl = document.getElementById('weather-bg-img');

  if (!videoEl || !imgEl) return;

  const videoSrc = WEATHER_VIDEOS[sceneType];
  const imgSrc = WEATHER_IMAGES[sceneType] || 'assets/weather-bg/sunny-day.jpg';

  // 图片作为兜底层：始终先加载，保证任何情况下都有画面
  imgEl.onload = () => { imgEl.style.opacity = '1'; };
  imgEl.onerror = () => { imgEl.style.opacity = '0'; };
  imgEl.src = imgSrc;
  // 首屏 HTML 里已写好 sunny-day.jpg：若首个场景恰好也是晴天，src 没变化，
  // 浏览器不会再派发 load 事件，这里必须主动确认一次，
  // 否则自动播放被拦截时会只剩渐变、看不到图片兜底
  if (imgEl.complete && imgEl.naturalWidth > 0) {
    imgEl.style.opacity = '1';
  }

  if (!videoSrc) {
    videoEl.style.opacity = '0';
    return;
  }

  // 视频层：加载成功后淡入并压过图片层
  const source = videoEl.querySelector('source');
  if (source) {
    source.src = videoSrc;
    videoEl.load();
  }

  videoEl.style.opacity = '0';
  // 能否播放交给统一策略裁决：后台/减少动效时干脆不播，避免空耗解码
  const onReady = syncVideoPlayback;

  videoEl.oncanplay = onReady;
  videoEl.onerror = () => { videoEl.style.opacity = '0'; };
}
