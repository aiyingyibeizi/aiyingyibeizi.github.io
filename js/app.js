/**
 * APEXON Weather - Main Application Logic
 */

import { CONFIG, setProxyAccessToken, getDeviceId } from './config.js';
// 帧率守卫必须尽早加载：它要在首屏绘制前就把上次的判定挂到 <html data-perf> 上，
// 否则中低端机要先经历一段「满特效」的卡顿才被降级。
import './perf-guard.js';
import {
  $,
  $$,
  debounce,
  formatTemp,
  formatDate,
  formatHour,
  formatUpdateTime,
  formatRelativeTime,
  svgIcon,
  storage,
  clamp,
} from './common.js';
import { cityStore, locationStore, settingsStore, clearCache } from './cache.js';
import {
  getSyncCode,
  lastSyncedAt,
  pushCloud,
  pullCloud,
  exportBackup,
  importBackupFile,
} from './sync.js';
import {
  searchCities,
  searchCityByCoords,
  getTopCities,
  fetchWeatherBundle,
  getIndices,
  getRealtimeWeather,
  getDailyForecast,
  getAirQuality,
  getCurrentPosition,
} from './api.js';
import { setWeatherBackground, reconcileIcon, weatherEmoji } from './weather-background.js';
import {
  initUpdateManager,
  applyUpdate,
  UPDATE_EVENT,
  NATIVE_UPDATE_EVENT,
  checkRemoteUpdate,
  installRemoteUpdate,
  checkForWaitingUpdate,
  isNativeApp,
} from './update.js';
import { t, initI18n, setLanguage, getLanguage, onLanguageChange, getLanguages } from './i18n.js';
import { locateByIp } from './geo-fallback.js';
import { applyDeviceProfile } from './device-profiler.js';
import { initBlueprint, updateBlueprint, renderBlueprintTool } from './blueprint.js';
import {
  isSupabaseConfigured,
  initSupabase,
  onAuthStateChange,
  getUser,
  signOut,
  fetchUsage,
  isQuotaExhausted,
} from './supabase.js';
import { recordWarnings } from './memory.js';

const state = {
  currentPage: 'home',
  currentCity: null,
  weather: null,
  indices: [],
  searchResults: [],
  isLoading: false,
  // 「发现」子页当前工具 id（calendar / sunmoon / aqimap / compare / life / widget）
  currentTool: null,
  // 30 天预报缓存：{ cityId, days }
  daily30: null,
};

/* 工具子页请求序号：切页/切城市后旧请求结果直接丢弃，避免串页 */
let toolRequestId = 0;

const elements = {};
let loadingCount = 0;
let currentLoadId = 0;
let lastAqiValue = 0;
let lastObsTime = null;

/* ============================
   最小化错误上报（本地环形缓冲）
   仅收集运行时错误到 localStorage，便于用户反馈时自查；
   绝不发送到任何网络，原始错误仍照常输出到 console。
   所有逻辑自身也 try/catch 全包，避免记录器反过来影响主流程。
   ============================ */
const ERROR_LOG_KEY = 'apexon_error_log';
const ERROR_LOG_MAX = 20;

function recordError(message, source) {
  try {
    const msg = String(message || '').slice(0, 300);
    const src = String(source || '').slice(0, 200);
    const key = `${msg}|${src}`;
    let list = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(ERROR_LOG_KEY) || '[]');
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* 旧值损坏时从空列表重建 */ }
    const idx = list.findIndex((e) => e && e.k === key);
    if (idx >= 0) {
      const entry = list[idx];
      entry.count = (entry.count || 1) + 1;
      entry.t = Date.now();
      list.splice(idx, 1);
      list.push(entry); // 去重后移到队尾，保留最近发生的顺序
    } else {
      list.push({ k: key, m: msg, s: src, count: 1, t: Date.now() });
    }
    if (list.length > ERROR_LOG_MAX) list = list.slice(-ERROR_LOG_MAX);
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(list));
  } catch { /* 记录器自身失败必须静默 */ }
}

function setupErrorLogger() {
  try {
    window.addEventListener('error', (event) => {
      try {
        const src = event?.filename
          ? `${event.filename}:${event.lineno || 0}`
          : 'window.onerror';
        recordError(event?.message, src);
      } catch { /* ignore */ }
    });
    window.addEventListener('unhandledrejection', (event) => {
      try {
        const reason = event?.reason;
        const msg = reason && reason.message ? reason.message : String(reason);
        recordError(msg, 'unhandledrejection');
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}
setupErrorLogger();


/** AQI 六级分档（0 优 → 5 严重污染），供圆环、趋势条、颜色统一取档 */
const AQI_LEVELS = [50, 100, 150, 200, 300, Infinity];
function aqiLevelIndex(value) {
  const v = parseInt(value, 10);
  if (!Number.isFinite(v)) return 0;
  const idx = AQI_LEVELS.findIndex((max) => v <= max);
  return idx < 0 ? 5 : idx;
}

/* ============================
   刷新动效工具
   ============================ */
/**
 * 文本更新 + 变化动效。
 * 只有"上次已有值且本次不同"时才播放动画，
 * 这样首次渲染与静默刷新都不会整屏乱闪，仅在数据真正变化时给出反馈。
 */
function setAnimText(el, value) {
  if (!el) return;
  const next = String(value ?? '');
  if (el.dataset.anim !== next) {
    const hadValue = el.dataset.anim !== undefined;
    el.dataset.anim = next;
    el.textContent = next;
    if (hadValue) {
      el.classList.remove('is-updated');
      void el.offsetWidth; // 强制回流以重启动画
      el.classList.add('is-updated');
      setTimeout(() => el.classList.remove('is-updated'), 760);
    }
  }
}

/** 数字滚动到目标值（用于 AQI 等需要"跳动感"的单个数字） */
function countUp(el, from, to, duration = 620) {
  if (!el) return;
  // from === to 也要写回：重渲染会把 DOM 重置为 "0"，若此时直接 return 会永久停在 0
  if (from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 卡片"刷新掠过"效果：更新完成时一道极淡的高光扫过，提示内容已刷新 */
function playCardSweep() {
  if (!state.weather) return;
  document.querySelectorAll('.card').forEach((card) => {
    card.classList.remove('is-refreshed');
    void card.offsetWidth;
    card.classList.add('is-refreshed');
    setTimeout(() => card.classList.remove('is-refreshed'), 900);
  });
}

/* ---- A1：天气体感（沉浸开场，每次会话只播一次） ---- */
const IMMERSE_KEY = 'apexon_immerse_done';

/**
 * 用当前场景色做一层 900ms 的色温过渡，只走 opacity，不碰 filter，
 * 避免在低端 WebView 上为了开场动画多出一次全屏合成。
 */
function playWeatherImmersion() {
  if (sessionStorage.getItem(IMMERSE_KEY) === '1') return;
  if (document.documentElement.dataset.motion === 'reduced') return;
  sessionStorage.setItem(IMMERSE_KEY, '1');
  const layer = document.createElement('div');
  layer.className = 'immerse-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  requestAnimationFrame(() => layer.classList.add('immerse-layer--in'));
  setTimeout(() => layer.classList.add('immerse-layer--out'), 520);
  setTimeout(() => layer.remove(), 1600);
}

/* ---- X6：首屏卡片入场错落（仅首次进入播放 40ms 级联） ---- */
const STAGGER_KEY = 'apexon_stagger_done';

function applyCardStagger() {
  if (sessionStorage.getItem(STAGGER_KEY) === '1') return;
  const page = $('#page-home');
  if (!page) return;
  sessionStorage.setItem(STAGGER_KEY, '1');
  const children = Array.from(page.children);
  children.forEach((el, i) => {
    el.classList.add('card-in');
    el.style.setProperty('--stagger-i', String(i));
    setTimeout(() => {
      el.classList.remove('card-in');
      el.style.removeProperty('--stagger-i');
    }, 1200);
  });
}

/* ---- X7：数字滚动（湿度 / 气压等单值指标） ---- */
/**
 * 数值 + 单位拆成「数字节点 + 文本后缀」，只让数字节点滚动，单位保持不动，
 * 这样重绘时不会出现「%%」或「hPa hPa」的叠字。
 */
function setRollingStat(el, value, unit) {
  if (!el) return;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    el.textContent = '--';
    delete el.dataset.v;
    return;
  }
  const prev = Number(el.dataset.v);
  el.dataset.v = String(n);
  el.textContent = '';
  const num = document.createElement('span');
  el.appendChild(num);
  if (unit) el.appendChild(document.createTextNode(unit));
  if (Number.isFinite(prev) && prev !== n) countUp(num, prev, n, 560);
  else num.textContent = String(Math.round(n));
}

function displayTemp(value) {
  const settings = settingsStore.get();
  if (settings.unit === 'f') {
    return formatTemp((value * 9) / 5 + 32, '°F');
  }
  return formatTemp(value, '°C');
}

/**
 * 判断此刻是否白天：以 astronomy 的日出日落为准，缺失时按本地 6:00-18:00 兜底。
 * 背景场景、图标校正、每日/逐小时渲染都要用同一个口径，避免各处判断不一致。
 */
function isDaytime(astronomy) {
  const sr = astronomy?.sunrise;
  const ss = astronomy?.sunset;
  if (sr && ss) {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const [srH, srM] = sr.split(':').map(Number);
    const [ssH, ssM] = ss.split(':').map(Number);
    if (Number.isFinite(srH) && Number.isFinite(ssH)) {
      return nowMinutes >= srH * 60 + srM && nowMinutes < ssH * 60 + ssM;
    }
  }
  const h = new Date().getHours();
  return h >= 6 && h < 18;
}

/* ============================
   Initialization
   ============================ */
export async function initApp() {
  cacheElements();
  // 机型画像：写 data-device-os / data-device-family / data-cutout / data-device-nav
  // 与实测安全区变量，供 CSS 做像素级机型补偿（刘海/灵动岛/手势条/小屏）
  const applyProfile = () => {
    const profile = applyDeviceProfile();
    if (elements.aboutDevice) {
      elements.aboutDevice.textContent = profile?.model || t('settings.deviceUnknown');
    }
    // 安全区实测值直接亮出来：这正是「首次进入要刷新才认得出挖孔屏」的现场证据，
    // 用户刷新前后各看一次就能确认修复是否生效（数字会从 0 变成真实值）。
    if (elements.aboutSafe && profile?.safe) {
      const { top, bottom } = profile.safe;
      elements.aboutSafe.textContent = `${Math.round(top)} / ${Math.round(bottom)} px`;
    }
    return profile;
  };
  // 安全区校准：命中缓存时页面首帧就初始化完毕，抢在系统把 safe-area-inset 传给渲染树之前，
  // 只测一次会永远读到 0。这里按时间序列重测，直到拿到非 0 值；
  // device-profiler 内部会保留上次非 0 结果，因此任何一次读到的 0 都不会覆盖已生效的适配值。
  applyProfile();
  requestAnimationFrame(() => requestAnimationFrame(applyProfile));
  [80, 240, 600, 1200, 2400].forEach((delay) => setTimeout(applyProfile, delay));

  window.addEventListener('resize', applyProfile);
  window.visualViewport?.addEventListener('resize', applyProfile);
  window.addEventListener('load', applyProfile);
  document.fonts?.ready.then(applyProfile).catch(() => {});
  // 横竖屏切换后 insets 会重算：等布局稳定再读，避免取到旋转过程中的半成品值
  window.addEventListener('orientationchange', () => {
    setTimeout(applyProfile, 150);
    setTimeout(applyProfile, 600);
  });
  // 从后台回到前台时 WebView 可能重建渲染树，重新校准一次
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) applyProfile();
  });
  // 初始化多语言（settingsStore.get() 返回设置对象，语言存在 language 字段）
  const savedLang = settingsStore.get().language;
  initI18n(savedLang);
  applyI18nToDOM();
  onLanguageChange(() => {
    // 1) 静态 DOM（标题、按钮、卡片名等）
    applyI18nToDOM();
    // 1.2) 更新记录是数据驱动渲染的，切语言后按当前语言重建
    renderChangelog();
    // 1.5) 账号区（登录状态 / 今日调用次数）是运行时取的，切语言后需重新渲染
    void refreshAccountUI();
    // 2) 动态内容立即用现有数据重渲染（避免等待网络时空窗）
    rerenderDynamicContent();
    // 3) API 返回的文案（天气描述/风向/生活指数/预警）需按新语言重新拉取
    if (state.currentCity) {
      loadWeather(state.currentCity, false, true);
    }
  });
  applyTheme();
  applyMotionPreference();
  setupRouter();
  setupSearch();
  setupNavigation();
  // 蓝图功能（v2.7.4）：晨间三件事、牵挂、一天形状、节气、双向牵手等
  // 必须在 setupDiscover() 之前挂载，否则新增的工具卡片拿不到点击委托
  initBlueprint({
    getState: () => state,
    toast: showToast,
    rerender: rerenderDynamicContent,
    // 摇一摇等原生手势触发刷新时复用同一条静默刷新链路
    refresh: () => { if (state.currentCity) void loadWeather(state.currentCity, false, true); },
  });
  setupDiscover();
  setupHeaderActions();
  setupTopScrollGesture();
  setupKeyboardShortcuts();
  setupAppShortcuts();
  setupSettingsSheet();
  setupPullToRefresh();
  setupHourlyDayChip();
  setupDailyDetail();
  setupUpdatePrompt();
  setupErrorRetry();
  setupGestures();
  setupExitBackButton();
  setupOnboarding();
  setupDonate();
  setupAccount();
  initUpdateManager();
  setupNativeUpdate();

  // 原生版启动后静默检查一次远端更新（网页版由 Service Worker 热更新负责）
  if (isNativeApp()) {
    setTimeout(() => { checkRemoteUpdate(); }, 4000);
  }

  // 每5分钟静默自动刷新天气数据。
  // 两个必须的刹车：
  // 1. 页面在后台（document.hidden）时不刷新 —— 用户看不到，纯属浪费额度；
  // 2. 今日额度已用尽时不再刷新 —— 游客额度较小，否则会一直撞 429。
  setInterval(() => {
    if (state.currentCity && !state.isLoading && !document.hidden && !isQuotaExhausted()) {
      console.log('[APEXON] 5分钟自动刷新');
      loadWeather(state.currentCity, false, true);
    }
  }, 5 * 60 * 1000);

  // 回到前台时补一次刷新：后台暂停刷新的代价是数据可能已过期，
  // 所以回到前台且数据超过 5 分钟就静默补拉一次（仍然受额度约束）。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!state.currentCity || state.isLoading || isQuotaExhausted()) return;
    const fetchedAt = state.weather?.fetchedAt || 0;
    if (Date.now() - fetchedAt < 5 * 60 * 1000) return;
    loadWeather(state.currentCity, false, true);
  });

  // 更新时间注脚每分钟刷新一次相对时间（"3 分钟前" → "4 分钟前"）
  setInterval(renderUpdateNote, 60 * 1000);

  // 首启引导：仅首次打开时出现，完成/跳过后不再打扰。
  // 放在定位之前，避免引导遮罩与系统定位权限弹窗叠在一起。
  if (!settingsStore.get().onboarded) {
    await showOnboarding();
  }

  const lastLocation = locationStore.get();
  if (lastLocation && lastLocation.id) {
    state.currentCity = lastLocation;
    await loadWeather(lastLocation, false);
  } else {
    const permission = await getLocationPermissionState();
    if (permission === 'prompt') {
      showToast(t('loc.permissionNeeded'), 3000);
      await wait(600);
    }
    await locateAndLoad();
  }

  const mainEl = $('.main');
  // .main 未开启 scroll-behavior: smooth，behavior:'auto' 即为瞬时归顶
  if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'auto' });

  renderSavedCities();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLocationPermissionState() {
  if (!('permissions' in navigator)) return 'prompt';
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    return result.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'prompt';
  }
}

function cacheElements() {
  elements.pages = {
    home: $('#page-home'),
    cities: $('#page-cities'),
    discover: $('#page-discover'),
    tool: $('#page-tool'),
    donate: $('#page-donate'),
  };
  elements.navItems = {
    home: $('#nav-home'),
    cities: $('#nav-cities'),
    discover: $('#nav-discover'),
    settings: $('#nav-settings'),
  };
  elements.currentSection = $('#current-section');
  elements.hourlySection = $('#hourly-section');
  elements.dailySection = $('#daily-section');
  elements.aqiSection = $('#aqi-section');
  elements.detailsSection = $('#details-section');
  elements.outingBody = $('#outing-body');
  elements.warningSection = $('#warning-section');
  elements.searchInput = $('#search-input');
  elements.searchResults = $('#search-results');
  elements.savedCities = $('#saved-cities');
  elements.toast = $('#toast');
  elements.updateToast = $('#update-toast');
  elements.updateBtn = $('#btn-update-apply');
  elements.settingsSheet = $('#settings-sheet');
  elements.errorRetry = $('#error-retry');
  elements.errorRetryMsg = $('#error-retry-msg');
  elements.errorRetryBtn = $('#error-retry-btn');
  elements.headerCityName = $('#header-city-name');
  // v2.2.0 新增
  elements.alertBar = $('#alert-bar');
  elements.toolTitle = $('#tool-title');
  elements.toolBody = $('#tool-body');
  elements.toolBack = $('#tool-back');
  elements.exitOverlay = $('#exit-overlay');
  elements.onboard = $('#onboard');
  elements.aboutDevice = $('#about-device');
  elements.aboutSafe = $('#about-safe');
  // v2.3.0 新增：打赏页 + 账号区块
  elements.donateBack = $('#donate-back');
  elements.donateTiers = $('#donate-tiers');
  elements.donateUnavailable = $('#donate-unavailable');
  elements.accountGroup = $('#account-group');
  elements.accountStatus = $('#account-status');
  elements.accountUsage = $('#account-usage');
  elements.accountLogout = $('#account-logout');
  elements.appExit = $('#app-exit');
  // v2.3.1 新增：原生更新弹窗 + 检查更新入口
  elements.updateDialog = $('#update-dialog');
  elements.updateDialogVersion = $('#update-dialog-version');
  elements.updateDialogSize = $('#update-dialog-size');
  elements.updateDialogDate = $('#update-dialog-date');
  elements.updateDialogNotes = $('#update-dialog-notes');
  elements.updateDialogProgress = $('#update-dialog-progress');
  elements.updateDialogBar = $('#update-dialog-bar');
  elements.updateDialogStatus = $('#update-dialog-status');
  elements.updateDialogGo = $('#update-dialog-go');
  elements.updateDialogLater = $('#update-dialog-later');
  // 弹窗内的说明段落无 id，按类名取；强制更新时用它承载「必须更新」提示
  elements.updateDialogHint = elements.updateDialog?.querySelector('.update-dialog__hint') || null;
  elements.checkUpdateBtn = $('#check-update');
}

/* ============================
   Theme
   ============================ */
let themeTimer = null;
let themeInitialized = false;

function applyTheme() {
  const settings = settingsStore.get();
  const mode = settings.theme || 'auto';
  const root = document.documentElement;

  // 跟随系统（auto）：按实时日出日落判定昼夜——日出切浅色、日落切深色；
  // 尚无天文数据时 isDaytime 会回退到本地 6:00-18:00，不会出现空档。
  const resolved = mode === 'auto'
    ? (isDaytime(state.weather?.astronomy) ? 'light' : 'dark')
    : mode;

  // 仅手动切换时挂临时过渡类，首屏初始化不加，避免默认值→目标值也播一次动画
  if (themeInitialized) {
    root.classList.add('theme-transition');
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => root.classList.remove('theme-transition'), 320);
  }

  root.setAttribute('data-theme', resolved);
  themeInitialized = true;
}

const MOTION_KEY = 'apexon_reduce_motion';

/**
 * 减少动效：纯前端偏好，写 localStorage 并挂到 <html data-motion>。
 * CSS 侧统一降级动画与过渡，只有在用户主动关闭时才生效，不影响内容本身。
 */
function applyMotionPreference() {
  const reduced = localStorage.getItem(MOTION_KEY) === '1';
  document.documentElement.dataset.motion = reduced ? 'reduced' : 'normal';
}

/* ============================
   Router
   ============================ */
function setupRouter() {
  window.addEventListener('popstate', () => {
    const page = location.hash.replace('#', '') || 'home';
    navigateTo(page, false);
  });
  const initial = location.hash.replace('#', '') || 'home';
  navigateTo(initial, false);
}

function navigateTo(page, pushState = true) {
  // 设置页不再是一个独立页面，而是底部弹窗
  if (page === 'settings') {
    openSettingsSheet();
    return;
  }

  if (!elements.pages[page]) page = 'home';

  const prev = document.querySelector('.page--active');
  // X8：旧页向上淡出（绝对定位、不占位），新页从 +20px 淡入，180ms 对称收尾
  if (prev && prev !== elements.pages[page]) {
    prev.classList.remove('page--active');
    prev.classList.add('page--leaving');
    setTimeout(() => prev.classList.remove('page--leaving'), 200);
  }

  Object.values(elements.pages).forEach((el) => {
    if (el !== prev) el.classList.remove('page--active', 'page--leaving');
  });
  Object.values(elements.navItems).forEach((el) => {
    el.classList.remove('nav__item--active');
    el.removeAttribute('aria-current');
  });

  elements.pages[page].classList.add('page--active');
  // 「发现」的子页共用 #page-tool / #page-donate，导航高亮仍落在「发现」上
  const navKey = page === 'tool' || page === 'donate' ? 'discover' : page;
  if (elements.navItems[navKey]) {
    elements.navItems[navKey].classList.add('nav__item--active');
    elements.navItems[navKey].setAttribute('aria-current', 'page');
  }

  state.currentPage = page;
  if (pushState) {
    history.pushState(null, '', `#${page}`);
  }

  // 离开时收起退出提示遮罩
  hideExitOverlay();

  const main = $('.main');
  // 切页瞬间归顶，避免继承上一页的滚动位置
  if (main) main.scrollTo({ top: 0, behavior: 'auto' });

  if (page === 'cities') {
    renderSavedCities();
  } else if (page === 'tool') {
    renderToolPage();
  } else if (page === 'donate') {
    renderDonatePage();
  } else if (page === 'home') {
    hideExitOverlay();
  }
}

function setupNavigation() {
  // 必须限定在 .nav__item 上：device-profiler 会往 <html> 打 data-device-nav 标记
  // （手势条/虚拟键类型），若用裸 [data-nav] 全局选择器，<html> 也会被绑定，
  // 于是页面上任何一次点击都会冒泡到 <html> 触发 navigateTo('gesture') 兜底跳首页。
  $$('.nav__item[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(8);
      const target = btn.dataset.nav;
      // 二次点击「当前所在」的标签：不切页，直接回到该页顶端。
      // 城市列表 / 工具页都可能很长，这是比「一路滑回去」更顺手的出口。
      if (target === state.currentPage) {
        $('.main')?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      navigateTo(target);
    });
  });
}

function setupHeaderActions() {
  $('#btn-locate')?.addEventListener('click', async () => {
    if (navigator.vibrate) navigator.vibrate(10);
    showToast(t('loc.locating'));
    await locateAndLoad();
  });

  $('#btn-refresh')?.addEventListener('click', async () => {
    if (navigator.vibrate) navigator.vibrate(10);
    if (state.currentCity) {
      await loadWeather(state.currentCity, false, true);
    } else {
      showToast(t('loc.noCitySelected'));
      await locateAndLoad();
    }
  });

  $('#btn-city-name')?.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(8);
    navigateTo('cities');
  });

  // 功能7：分享当前天气（优先系统分享面板，不支持则复制到剪贴板）
  $('#btn-share')?.addEventListener('click', async () => {
    if (navigator.vibrate) navigator.vibrate(8);
    await shareWeather();
  });

  const main = $('.main');
  const header = $('.header');
  const progress = $('#scroll-progress');
  const toTop = $('#btn-top');

  toTop?.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(6);
    main?.scrollTo({ top: 0, behavior: 'smooth' });
  });

  if (main && header) {
    let ticking = false;
    // 上一次写入的进度（千分位取整）：值没变就不碰 DOM，
    // 120Hz 屏上滚动事件每秒可触发上百次，无谓的样式写入会直接吃掉帧预算。
    let lastProgressStep = -1;
    main.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const top = main.scrollTop;
          header.classList.toggle('header--scrolled', top > 100);

          // 阅读进度：只在内容确实可滚动时才显示，短页面不出现发丝线
          const scrollable = main.scrollHeight - main.clientHeight;
          const ratio = scrollable > 40 ? clamp(top / scrollable, 0, 1) : 0;
          const step = Math.round(ratio * 200);
          if (progress && step !== lastProgressStep) {
            lastProgressStep = step;
            progress.style.transform = `scaleX(${(step / 200).toFixed(3)})`;
          }
          if (progress) {
            progress.classList.toggle('scroll-progress--visible', top > 40);
          }
          // 归顶按钮：滚过一屏高度再出现，避免首屏就顶着「回到顶部」
          if (toTop) {
            const show = top > main.clientHeight * 0.9;
            // 环形进度只在按钮真正可见时更新，并且把变量写在按钮自身上：
            // 写在 documentElement 上会让整棵树的样式失效，滚动时每帧重算，是掉帧主因。
            if (show) {
              const percent = Math.round(ratio * 100);
              if (percent !== lastToTopPercent) {
                lastToTopPercent = percent;
                toTop.style.setProperty('--to-top-p', percent.toFixed(0));
              }
            }
            if (show !== toTop.classList.contains('to-top--visible')) {
              toTop.hidden = false;
              toTop.classList.toggle('to-top--visible', show);
              // 淡出后回收节点，避免一个透明按钮仍在响应点击
              if (!show) {
                clearTimeout(toTopHideTimer);
                toTopHideTimer = setTimeout(() => {
                  if (!toTop.classList.contains('to-top--visible')) toTop.hidden = true;
                }, 320);
              }
            }
          }

          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }
}

let toTopHideTimer = null;
/** 归顶按钮环形进度的上一次整数百分比：只有变化时才写 CSS 变量，避免每帧重绘。 */
let lastToTopPercent = -1;

/**
 * 点击顶栏空白处（含状态栏 / 刘海那一圈）立即回到页面顶端。
 * 顶栏恒定不动，这个手势是「内容被顶栏遮住」的顺滑出口：
 * 长页面不必一路滑回去，轻点顶部即可归位。
 */
function setupTopScrollGesture() {
  const header = $('.header');
  const main = $('.main');
  if (!header || !main) return;
  header.addEventListener('click', (e) => {
    // 只认空白区：点在按钮/城市名上时交给各自的 handler
    if (e.target.closest('button')) return;
    if (main.scrollTop <= 0) return;
    main.scrollTo({ top: 0, behavior: 'smooth' });
    if (navigator.vibrate) navigator.vibrate(6);
  });
}

/**
 * X17：Android 静态快捷方式通过 apexon:// 进来。
 * 只在原生壳内生效；纯网页打开不会触发，也不做任何权限请求。
 */
function setupAppShortcuts() {
  const App = window.Capacitor?.Plugins?.App;
  if (!App?.addListener) return;
  const handle = (url) => {
    let target = '';
    try {
      const parsed = new URL(String(url || ''));
      target = parsed.searchParams.get('target') || '';
    } catch (_) {
      // 形如 apexon://shortcut?target=refresh 在老 WebView 里可能解析失败，退回正则
      const m = String(url || '').match(/target=([a-z]+)/i);
      target = m ? m[1].toLowerCase() : '';
    }
    if (target === 'refresh') {
      setTimeout(() => {
        if (state.currentCity) void loadWeather(state.currentCity, false, true);
        showToast(t('a11y.refreshed'));
      }, 500);
    } else if (target === 'cities') {
      navigateTo('cities');
    } else if (target === 'discover') {
      navigateTo('discover');
    }
  };
  try { App.addListener('appUrlOpen', (data) => handle(data?.url)); } catch (_) { /* 忽略 */ }
  try { App.getLaunchUrl?.().then((data) => { if (data?.url) handle(data.url); }); } catch (_) { /* 忽略 */ }
}

/**
 * 桌面端键盘快捷键（≥768px 的浏览器 / 桌面 PWA 才有物理键盘，移动端静默无效）：
 *   /   → 打开城市页并聚焦搜索框
 *   t   → 回到页面顶端
 *   r   → 刷新当前城市天气
 *   c   → 切到下一座城市
 *   d   → 切换浅色/深色
 *   m   → 打开牵手对话
 *   1–4 → 切换底部四个标签
 *   ?   → 打开快捷键帮助浮层
 *   Esc → 关闭最上层弹层
 * 输入态一律不劫持，避免和中文输入法/搜索框冲突。
 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const el = e.target;
    const tag = (el?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;

    if (e.key === 'Escape') {
      if (closeTopOverlayForBack()) e.preventDefault();
      return;
    }

    const key = e.key.toLowerCase();
    if (key === '/') {
      e.preventDefault();
      navigateTo('cities');
      focusSearchWhenReady();
    } else if (key === 't') {
      $('.main')?.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (key === 'r') {
      e.preventDefault();
      $('#btn-refresh')?.click();
    } else if (key === 'c') {
      // H4：c 切到下一座城市，与左右滑动同一条路径
      const cities = cityStore.getAll();
      if (cities.length >= 2) {
        const i = cities.findIndex((c) => String(c.id) === String(state.currentCity?.id));
        const next = cities[(i + 1) % cities.length];
        if (next) {
          state.currentCity = next;
          loadWeather(next);
        }
      }
    } else if (key === 'd') {
      // H4：d 在浅色/深色之间切换（不改「跟随系统」选项本身）
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      $(`#theme-select .segmented__opt[data-value="${next}"]`)?.click();
    } else if (key === 'm') {
      // H4：m 打开牵手对话
      navigateTo('discover');
      setTimeout(() => $('[data-bp-tool="bond"]')?.click(), 80);
    } else if (['1', '2', '3', '4'].includes(key)) {
      const pages = ['home', 'cities', 'discover', 'settings'];
      navigateTo(pages[Number(key) - 1]);
    } else if (e.key === '?') {
      e.preventDefault();
      toggleShortcutHelp();
    }
  });

  setupShortcutHelp();
}

/** 快捷键帮助浮层：桌面端可发现性补丁，移动端手工打开也无害。 */
function setupShortcutHelp() {
  const overlay = $('#shortcut-help');
  if (!overlay) return;
  $('#shortcut-help-close')?.addEventListener('click', closeShortcutHelp);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeShortcutHelp();
  });
}

function toggleShortcutHelp() {
  const overlay = $('#shortcut-help');
  if (!overlay) return;
  if (overlay.hidden) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    overlay.querySelector('.shortcut-help__panel')?.focus?.();
  } else {
    closeShortcutHelp();
  }
}

function closeShortcutHelp() {
  const overlay = $('#shortcut-help');
  if (!overlay || overlay.hidden) return;
  overlay.classList.remove('is-open');
  setTimeout(() => { overlay.hidden = true; }, 180);
}

/**
 * 城市页切出后再聚焦搜索框：切换瞬间它还在 display:none，
 * 直接 focus() 会被浏览器忽略。这里逐帧等到元素真正可见再聚焦，
 * 最多等 12 帧（≈200ms），超时即放弃，不留下悬空定时器。
 */
function focusSearchWhenReady(attempt = 0) {
  const input = $('#search-input');
  if (input && input.offsetParent !== null) {
    input.focus();
    input.select?.();
    return;
  }
  if (attempt < 12) requestAnimationFrame(() => focusSearchWhenReady(attempt + 1));
}

/* 功能7：组装分享文案。优先调用系统分享，回退到剪贴板复制 */
async function shareWeather() {
  const w = state.weather;
  if (!w?.realtime) {
    showToast(t('share.failed'));
    return;
  }

  const { location, realtime, daily } = w;
  const today = daily?.[0] || {};
  const lines = [
    `${location.name} ${realtime.text || ''} ${displayTemp(realtime.temp)}`.trim(),
    today.tempMax != null && today.tempMin != null
      ? `${t('share.high')} ${displayTemp(today.tempMax)} / ${t('share.low')} ${displayTemp(today.tempMin)}`
      : '',
    `${t('share.from')} ${CONFIG.brand}`,
  ].filter(Boolean);
  const text = lines.join('\n');

  if (navigator.share) {
    try {
      await navigator.share({ title: `${location.name} · ${CONFIG.brand}`, text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // 用户主动取消，不提示
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast(t('share.copied'));
  } catch {
    showToast(t('share.failed'));
  }
}

/* 功能12：7 天详情弹窗的关闭交互 */
function setupDailyDetail() {
  const overlay = $('#daily-detail');
  if (!overlay) return;
  $('#daily-detail-close')?.addEventListener('click', closeDailyDetail);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDailyDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeDailyDetail();
  });
}

/* ============================
   In-App Update Prompt
   ============================ */
function setupUpdatePrompt() {
  if (!elements.updateToast || !elements.updateBtn) return;

  window.addEventListener(UPDATE_EVENT, () => {
    elements.updateToast.hidden = false;
    // Force reflow to ensure transition plays after removing hidden
    void elements.updateToast.offsetWidth;
    elements.updateToast.classList.add('update-toast--visible');
  });

  elements.updateBtn.addEventListener('click', () => {
    elements.updateBtn.textContent = t('update.updating');
    elements.updateBtn.disabled = true;
    applyUpdate();
  });
}

/* ============================
   Native Update（Android 应用内下载安装）
   ============================ */
// 当前待安装的远端清单，点「安装」时使用
let pendingUpdateManifest = null;
// 强制更新锁：为 true 时禁止关闭弹窗（隐藏「稍后」、屏蔽遮罩点击与 ESC）
let updateForceLock = false;

function escapeNoteText(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setUpdateStatus(text) {
  const el = elements.updateDialogStatus;
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function setUpdateProgress(pct) {
  const value = clamp(pct, 0, 100);
  if (elements.updateDialogProgress) elements.updateDialogProgress.hidden = false;
  if (elements.updateDialogBar) elements.updateDialogBar.style.width = `${value}%`;
  setUpdateStatus(`${t('updateNative.downloading')} ${value}%`);
}

/** 按当前语言挑选更新说明，缺失时回退 en → zh-CN */
function pickManifestNotes(manifest) {
  const notes = (manifest && manifest.notes) || {};
  const lang = getLanguage();
  const list = notes[lang] || notes.en || notes['zh-CN'];
  return Array.isArray(list) ? list : [];
}

function openNativeUpdateDialog(manifest) {
  pendingUpdateManifest = manifest;
  if (!elements.updateDialog) return;

  // 强制更新位：仅当清单显式 force:true 才生效；缺省 false，旧升级通道用户不受影响
  const forced = manifest && manifest.force === true;
  updateForceLock = forced;

  if (elements.updateDialogVersion) elements.updateDialogVersion.textContent = `v${manifest.version || ''}`;
  if (elements.updateDialogSize) elements.updateDialogSize.textContent = manifest.sizeText || '';
  if (elements.updateDialogDate) elements.updateDialogDate.textContent = manifest.releaseDate || '';
  if (elements.updateDialogNotes) {
    elements.updateDialogNotes.innerHTML = pickManifestNotes(manifest)
      .map((line) => `<li>${escapeNoteText(line)}</li>`)
      .join('');
  }
  if (elements.updateDialogProgress) elements.updateDialogProgress.hidden = true;
  if (elements.updateDialogBar) elements.updateDialogBar.style.width = '0%';
  if (elements.updateDialogGo) {
    elements.updateDialogGo.disabled = false;
    elements.updateDialogGo.textContent = t('updateNative.install');
  }
  // 强制更新：隐藏「稍后」，并把说明段落换成「本次更新为必须更新」
  if (elements.updateDialogLater) elements.updateDialogLater.hidden = forced;
  if (elements.updateDialogHint) {
    elements.updateDialogHint.textContent = t(forced ? 'updateNative.mandatory' : 'updateNative.hint');
    elements.updateDialogHint.classList.toggle('update-dialog__hint--force', forced);
    // 强制文案不走 data-i18n 绑定，避免切换语言时被 applyI18nToDOM 覆盖回默认提示
    if (forced) elements.updateDialogHint.removeAttribute('data-i18n');
    else elements.updateDialogHint.setAttribute('data-i18n', 'updateNative.hint');
  }
  setUpdateStatus('');

  elements.updateDialog.hidden = false;
}

function closeNativeUpdateDialog() {
  // 强制更新时不允许关闭：拦截「稍后」按钮、遮罩点击与 ESC
  if (updateForceLock) return;
  if (elements.updateDialog) elements.updateDialog.hidden = true;
}

/* 供原生下载过程回传状态（由 AppUpdater.java 调用） */
window.__apexonUpdateProgress = function (pct) {
  setUpdateProgress(pct);
};

window.__apexonUpdateResult = function (code) {
  if (elements.updateDialogBar) elements.updateDialogBar.style.width = '0%';
  if (code === 0) {
    // 系统安装器已拉起，停留在弹窗提示即可
    setUpdateStatus(t('updateNative.installing'));
    return;
  }
  if (elements.updateDialogGo) {
    elements.updateDialogGo.disabled = false;
    elements.updateDialogGo.textContent = t('updateNative.retry');
  }
  setUpdateStatus(t(code === 2 ? 'updateNative.hashFailed' : 'updateNative.downloadFailed'));
};

function setupNativeUpdate() {
  if (!elements.updateDialog) return;

  window.addEventListener(NATIVE_UPDATE_EVENT, (event) => {
    openNativeUpdateDialog(event.detail || {});
  });

  elements.updateDialogLater?.addEventListener('click', closeNativeUpdateDialog);

  elements.updateDialog.addEventListener('click', (e) => {
    if (e.target === elements.updateDialog) closeNativeUpdateDialog();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !elements.updateDialog.hidden) closeNativeUpdateDialog();
  });

  elements.updateDialogGo?.addEventListener('click', () => {
    if (!pendingUpdateManifest) return;
    const result = installRemoteUpdate(pendingUpdateManifest);
    if (result === 'downloading') {
      elements.updateDialogGo.disabled = true;
      elements.updateDialogGo.textContent = t('updateNative.downloadingBtn');
      setUpdateProgress(0);
    } else if (result === 'need-permission') {
      setUpdateStatus(t('updateNative.needPermission'));
    } else if (result === 'no-url') {
      setUpdateStatus(t('updateNative.noUrl'));
    } else {
      setUpdateStatus(t('updateNative.external'));
    }
  });

  // 设置页「检查更新」：原生查远端清单；网页版查 Service Worker 是否有等待中的更新
  elements.checkUpdateBtn?.addEventListener('click', async () => {
    if (isNativeApp()) {
      const manifest = await checkRemoteUpdate();
      if (!manifest) showToast(t('updateNative.upToDate'));
      return;
    }
    const hasWaiting = await checkForWaitingUpdate();
    if (hasWaiting) {
      applyUpdate();
    } else {
      showToast(t('updateNative.upToDate'));
    }
  });
}

/* ============================
   Loading & Toast
   ============================ */
/* 加载状态统一由顶部进度条表达（不再使用全屏遮罩） */
function setLoading(show) {
  if (show) {
    loadingCount += 1;
  } else {
    loadingCount = Math.max(0, loadingCount - 1);
  }
  state.isLoading = loadingCount > 0;
  if (state.isLoading) {
    showRefreshBar();
  } else {
    hideRefreshBar();
  }
}

let toastTimer = null;
function showToast(message, duration = 2500) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove('toast--visible');
  }, duration);
}

/* 进度条引用计数：并发请求时不互相打断 */
let refreshBarCount = 0;
function showRefreshBar() {
  refreshBarCount += 1;
  $('#refresh-bar')?.classList.add('refresh-bar--active');
}
function hideRefreshBar() {
  refreshBarCount = Math.max(0, refreshBarCount - 1);
  if (refreshBarCount === 0) {
    $('#refresh-bar')?.classList.remove('refresh-bar--active');
  }
}

/* 无障碍播报：写入视觉隐藏的 aria-live 区域，屏幕阅读器会朗读 */
let a11yTimer = null;
function announceA11y(message) {
  const el = $('#sr-live');
  if (!el || !message) return;
  // 先清空再加内容，确保相同文本再次播报时也能触发
  el.textContent = '';
  clearTimeout(a11yTimer);
  a11yTimer = setTimeout(() => {
    el.textContent = message;
  }, 60);
}

/* ============================
   Weather Loading
   ============================ */
async function locateAndLoad() {
  setLoading(true);
  try {
    if (!('geolocation' in navigator)) {
      throw new Error('Geolocation not supported');
    }

    const permission = await getLocationPermissionState();
    if (permission === 'denied') {
      // 明确拒绝过系统定位：不反复弹请求，直接用 IP 估一个城市级位置
      if (await applyIpLocation()) return;
      showToast(t('loc.permissionOff'), 3500);
      navigateTo('cities');
      return;
    }

    showToast(t('loc.requestingPermission'), 2000);
    const coords = await getCurrentPosition();
    const city = await searchCityByCoords(coords.longitude, coords.latitude);
    if (city) {
      city.longitude = coords.longitude;
      city.latitude = coords.latitude;
      state.currentCity = city;
      locationStore.set(city);
      cityStore.add(city);
      await loadWeather(city, false);
    } else {
      await loadDefaultCity(t('loc.successButNoCity'));
    }
  } catch (error) {
    console.warn('Location failed:', error);
    // 系统定位失败（网页端最常见）：退到 IP 定位，不要让用户卡在空页面
    if (await applyIpLocation()) return;
    let message = t('loc.failed');
    if (error?.code === 1 || error?.message?.includes('denied') || error?.message?.includes('Denied')) {
      message = t('loc.denied');
    } else if (error?.code === 2) {
      message = t('loc.unavailable');
    } else if (error?.code === 3) {
      message = t('loc.timeout');
    } else if (error?.message?.includes('Network') || error?.message?.includes('fetch') || error?.message?.includes('HTTP')) {
      message = t('loc.loadFailed');
    }
    showToast(message, 3500);
    navigateTo('cities');
  } finally {
    setLoading(false);
  }
}

/**
 * 用 IP 估位置并加载天气。
 * 拿不到城市名时，用「经度,纬度」直接当和风 location 参数，
 * 这样即使 GeoAPI 反查失败，天气本身仍然能出来。
 */
async function applyIpLocation() {
  let ip;
  try {
    ip = await locateByIp();
  } catch (_) {
    return false;
  }

  try {
    let city = await searchCityByCoords(ip.lon, ip.lat).catch(() => null);
    if (!city && ip.city) {
      city = {
        id: `${ip.lon.toFixed(2)},${ip.lat.toFixed(2)}`,
        name: ip.city,
        adm1: ip.region || '',
        adm2: '',
        country: ip.country || '',
      };
    }
    if (!city) return false;

    // 反查坐标常常返回区县级（如「二七」），而 IP 归属地是市级（如「郑州」）。
    // 首页标题用区县名会显得莫名其妙，因此有市级名时一律以它为准。
    if (ip.city && city.name !== ip.city) {
      city.name = ip.city;
      if (ip.region) city.adm1 = ip.region;
    }

    city.longitude = ip.lon;
    city.latitude = ip.lat;
    state.currentCity = city;
    locationStore.set(city);
    cityStore.add(city);
    showToast(t('loc.ipLocated'), 2600);
    await loadWeather(city, false);
    return true;
  } catch (_) {
    return false;
  }
}

async function loadDefaultCity(errorContext = '') {
  try {
    const cities = cityStore.getAll();
    if (cities.length > 0) {
      state.currentCity = cities[0];
    } else {
      const top = await getTopCities(1);
      if (top.length > 0) {
        state.currentCity = top[0];
        cityStore.add(top[0]);
      }
    }
    if (state.currentCity) {
      await loadWeather(state.currentCity, false);
      return;
    }
    showToast(t('default.noCity'));
  } catch (error) {
    console.error('loadDefaultCity failed:', error);
    const reason = error?.message || '';
    let msg = t('default.loadFailed');
    if (reason.includes('HTTP')) msg = `${t('default.networkError')} (${reason})`;
    else if (reason.includes('API')) msg = `${t('default.apiError')}${reason}`;
    else if (reason.includes('fetch') || reason.includes('Network')) msg = t('default.networkFail');
    showToast(errorContext ? `${errorContext}，${msg}` : msg, 3500);
  }
}

async function loadWeather(city, showLoading = true, silent = false) {
  const loadId = (currentLoadId += 1);
  const isStale = () => loadId !== currentLoadId;

  hideErrorRetry();
  // 首屏尚未有数据时先铺与完成态同构的骨架，避免数据到达时高度跳变
  if (!state.weather) renderCurrentSkeleton();
  if (showLoading && !silent) {
    setLoading(true);
  } else if (silent) {
    showRefreshBar();
  }
  try {
    const data = await fetchWeatherBundle(city);
    if (isStale()) return;

    // 额外获取生活指数（不阻塞主流程）
    getIndices(city.id).then((indices) => {
      if (!isStale()) {
        state.indices = indices;
        renderIndices(indices);
      }
    }).catch(() => {
      // 拉取失败时收起卡片，避免骨架屏永久停留
      if (!isStale()) {
        state.indices = [];
        renderIndices([]);
      }
    });

    state.weather = data;
    state.currentCity = city;
    locationStore.set(city);

    renderCurrentWeather(data);
    renderHourly(data.hourly);
    renderDaily(data.daily);
    renderSunPosition(data.astronomy);
    renderAirQuality(data.airQuality);
    renderAqiTrend(data.airForecast);
    renderDetails(data);
    renderWarnings(data.warnings);

    // X11：把这次成功的结果留一份「最后已知」，下次断网时用灰显方式兜底
    saveLastGood(city, data);
    clearStaleState();

    // v2.2.0：极限天气提醒条 / 场景强调色 / 数据保鲜度角标 / 历史快照（对比页用）
    renderAlertBar(data);
    applySceneAccent(data);
    renderFreshness(data);
    recordHistorySnapshot(data);
    recordCitySnapshot(city, data);
    // 蓝图功能：晨间三件事 / 牵挂卡片 / 一天形状 / 节气 / 暖光
    updateBlueprint(state);
    // 工具子页正打开时用新数据刷新一次
    // 空气榜自带取数（最多 12 城），交给它自己的 TTL 缓存，避免周期性重复打 API
    if (state.currentPage === 'tool' && state.currentTool !== 'aqimap') renderToolPage();

    // 白天/夜间判断：以 astronomy 接口的日出日落为准
    // （/weather/7d 不返回 sr/ss，此前导致 isDay 恒为 true、夜晚背景永不出现）
    const iconCode = data.realtime?.icon;
    const weatherText = data.realtime?.text || '';
    const isDay = isDaytime(data.astronomy);
    setWeatherBackground(iconCode, isDay, weatherText);

    // 跟随系统模式：按实时日出日落判定昼夜，日落即切深色、日出切浅色
    applyTheme();

    // 静默刷新（自动/手动）时给卡片一次极淡的"已更新"掠过提示
    if (silent) playCardSweep();

    // A1 天气体感 + X6 首屏卡片错落（都只在本次会话首次生效）
    playWeatherImmersion();
    applyCardStagger();

    // 无障碍播报：当前天气概况 + 预警数量
    const warnCount = data.warnings?.length || 0;
    const announceParts = [
      t('a11y.announce', data.location?.name || '', weatherText || '', displayTemp(data.realtime?.temp)),
      warnCount > 0 ? t('a11y.warningCount', warnCount) : '',
      silent ? t('a11y.refreshed') : '',
    ].filter(Boolean);
    announceA11y(announceParts.join('，'));
  } catch (error) {
    if (isStale()) return;
    console.error('[APEXON] Load weather failed:', error);
    const reason = error?.message || '';
    let msg = t('error.title');
    if (reason.includes('quota_exhausted')) msg = t('account.exhausted');
    else if (reason.includes('HTTP 401') || reason.includes('API 401')) msg = t('error.apiKeyInvalid');
    else if (reason.includes('HTTP 403') || reason.includes('API 403')) msg = t('error.apiDenied');
    else if (reason.includes('HTTP')) msg = `${t('error.network')}${reason}`;
    else if (reason.includes('API')) msg = `${t('error.api')}${reason}`;
    else if (reason.includes('fetch') || reason.includes('Network') || reason.includes('abort')) msg = t('error.networkFail');
    // X11：请求失败但本地留着上次成功的结果 —— 用灰显数据继续把页面填满，
    // 比整屏骨架 + 报错更接近「真的能用」。
    if (renderLastGood(city)) return;
    showErrorRetry(msg);
  } finally {
    if (showLoading && !silent) {
      setLoading(false);
    } else if (silent) {
      hideRefreshBar();
    }
  }
}

/**
 * 语言切换时用现有数据重渲染所有动态内容，
 * 让界面立刻变成新语言，而不必等待网络返回。
 */
function rerenderDynamicContent() {
  renderSavedCities();
  const w = state.weather;
  if (w) {
    renderCurrentWeather(w);
    renderHourly(w.hourly);
    renderDaily(w.daily);
    renderSunPosition(w.astronomy);
    renderAirQuality(w.airQuality);
    renderAqiTrend(w.airForecast);
    renderDetails(w);
    renderWarnings(w.warnings);
    renderAlertBar(w);
    applySceneAccent(w);
    renderFreshness(w);
  }
  if (state.indices) renderIndices(state.indices);
  if (w) updateBlueprint(state);
  // 工具子页（含 i18n 文案）跟随语言即时重渲染
  if (state.currentPage === 'tool') renderToolPage();
  // 打赏页的档位名称/说明是动态生成的，同样需要跟随语言
  if (state.currentPage === 'donate') renderDonatePage();
}

/* ============================
   Render Life Indices (生活指数)
   ============================ */
/* 和风天气生活指数 type 与图标映射 */
const INDICES_ICONS = {
  '1': { icon: '👕', key: 'indices.clothing' },
  '2': { icon: '🚗', key: 'indices.carWash' },
  '3': { icon: '🤒', key: 'indices.cold' },
  '4': { icon: '🏃', key: 'indices.sport' },
  '5': { icon: '🚴', key: 'indices.cycling' },
  '6': { icon: '🚦', key: 'indices.traffic' },
  '7': { icon: '☀️', key: 'indices.uv' },
  '8': { icon: '🎒', key: 'indices.travel' },
  '9': { icon: '🧴', key: 'indices.sunscreen' },
  '10': { icon: '🌸', key: 'indices.pollen' },
  '11': { icon: '🎣', key: 'indices.fishing' },
  '12': { icon: '❄️', key: 'indices.coldness' },
  '13': { icon: '🧊', key: 'indices.ac' },
  '14': { icon: '🌫️', key: 'indices.airPollution' },
  '15': { icon: '🚦', key: 'indices.commuting' },
  '16': { icon: '🧴', key: 'indices.shopping' },
};

/**
 * 生活指数渲染：用 API 返回的 name + category + text
 * category 作为等级标签，text 截取前 50 字作为简短建议
 */
function renderIndices(indices) {
  let indicesCard = $('#indices-section');

  if (!indices || indices.length === 0) {
    // 空态不再整卡隐藏：保留卡片与标题，用紧凑提示告诉用户"这里本就没有数据"，
    // 避免用户误以为是加载失败。卡片尚未创建时（首屏）则不做任何处理。
    if (!indicesCard) return;
    const emptyGrid = indicesCard.querySelector('.indices__grid');
    if (emptyGrid) {
      emptyGrid.innerHTML = `
        <div class="empty empty--compact" style="grid-column:1 / -1">
          ${svgIcon('alertCircle').outerHTML}
          <div class="empty__title">${t('empty.indices')}</div>
          <div class="empty__desc">${t('empty.indicesDesc')}</div>
        </div>
      `;
    }
    return;
  }

  if (indicesCard) {
    // 语言切换时同步刷新卡片标题
    const titleEl = indicesCard.querySelector('.card__title');
    if (titleEl) titleEl.textContent = t('card.indices');
  } else {
    indicesCard = document.createElement('div');
    indicesCard.id = 'indices-section';
    indicesCard.className = 'card indices-card';
    indicesCard.innerHTML = `
      <div class="card__title">${t('card.indices')}</div>
      <div class="indices__grid"></div>
    `;
    elements.detailsSection?.after(indicesCard);
  }

  const container = indicesCard.querySelector('.indices__grid');
  if (!container) return;

  container.innerHTML = indices.slice(0, 6).map((item) => {
    const mapping = INDICES_ICONS[item.type] || { icon: '📋', key: 'indices.default' };
    const icon = mapping.icon;
    const label = item.name || t(mapping.key);
    const level = item.category || '--';
    const advice = item.text
      ? (item.text.length > 50 ? item.text.slice(0, 50) + '…' : item.text)
      : '';
    return `
      <div class="indices__item">
        <div class="indices__header">
          <span class="indices__icon">${icon}</span>
          <span class="indices__label">${label}</span>
        </div>
        <div class="indices__value">${level}</div>
        ${advice ? `<div class="indices__advice">${advice}</div>` : ''}
      </div>
    `;
  }).join('');
}

/* ============================
   Render Current Weather
   ============================ */

/* 温度数字滚动（odometer）
   每个数字位是一条 0-9 的竖条，靠 translateY 滚到目标位。
   关键点：单元格必须在首次构建后常驻，只改 transform。
   若每次渲染都重建 DOM，竖条会重新从 0 开始滚，看到的是"从 0 滚到目标"而不是"从旧值滚到新值"。 */
function buildTempCell(ch) {
  const cell = document.createElement('span');
  cell.className = 'temp-roll__cell';
  if (ch >= '0' && ch <= '9') {
    cell.dataset.kind = 'digit';
    const strip = document.createElement('span');
    strip.className = 'temp-roll__strip';
    for (let d = 0; d <= 9; d += 1) {
      const item = document.createElement('span');
      item.className = 'temp-roll__d';
      item.textContent = String(d);
      strip.appendChild(item);
    }
    cell.appendChild(strip);
  } else {
    cell.dataset.kind = 'static';
    cell.textContent = ch;
  }
  return cell;
}

function setTempCell(cell, ch, animate) {
  if (cell.dataset.kind !== 'digit') {
    if (cell.textContent !== ch) cell.textContent = ch;
    return;
  }
  const strip = cell.querySelector('.temp-roll__strip');
  if (animate) {
    strip.style.transform = `translateY(${-Number(ch)}em)`;
    return;
  }
  // 首次就位：先关掉过渡，强制回流后再恢复，避免从 0 滚一遍
  strip.style.transition = 'none';
  strip.style.transform = `translateY(${-Number(ch)}em)`;
  void strip.offsetHeight;
  strip.style.transition = '';
}

function renderTempRoll(text) {
  const container = elements.tempRoll;
  if (!container) return;

  const chars = String(text ?? '--').split('');

  while (container.children.length < chars.length) {
    container.appendChild(buildTempCell('0'));
  }
  while (container.children.length > chars.length) {
    container.removeChild(container.lastChild);
  }

  const animate = container.dataset.ready === '1';
  chars.forEach((ch, i) => {
    const cell = container.children[i];
    const isDigit = ch >= '0' && ch <= '9';
    const wasDigit = cell.dataset.kind === 'digit';

    // 数字位与符号位互换时只能换节点，新节点直接就位不做滚动
    if (isDigit !== wasDigit) {
      const next = buildTempCell(ch);
      container.replaceChild(next, cell);
      if (isDigit) setTempCell(next, ch, false);
      return;
    }
    setTempCell(cell, ch, animate);
  });

  container.dataset.ready = '1';
}

/* 降水趋势：优先用分钟级实况撑满未来 2 小时，没有则回退到逐小时 3 格。
   只在超宽屏显示，用来填掉 hero 两侧的空白。 */
function renderPrecipTrend(hourly, minutely) {
  const el = elements.currentPrecip;
  if (!el) return;

  // 和风 minutely 是 5 分钟一格；两两合并成 10 分钟，12 格正好 2 小时，
  // 格数太多会把窄栏挤成一堆发丝，格数太少又看不出趋势拐点。
  const slots = [];
  if (Array.isArray(minutely)) {
    for (let i = 0; i < minutely.length && slots.length < 12; i += 2) {
      const pair = minutely.slice(i, i + 2);
      const precip = Math.max(...pair.map((m) => parseFloat(m.precip) || 0));
      if (!Number.isFinite(precip)) continue;
      slots.push({ precip });
    }
  }

  if (slots.length >= 6) {
    const max = Math.max(...slots.map((s) => s.precip), 0);
    const wet = slots.some((s) => s.precip > 0);
    const scale = (v) => (max > 0 ? Math.max(6, Math.round((v / max) * 100)) : 6);
    const label = (i) => (i === 0 ? t('hourly.now') : i % 3 === 0 ? `+${i * 10}′` : '');
    el.hidden = false;
    el.innerHTML = `
      <div class="precip__title">${svgIcon('droplet').outerHTML}<span>${t('card.minutely')}</span></div>
      <div class="precip__summary">${wet ? t('precip.minuteWet') : t('precip.minuteDry')}</div>
      <div class="precip__grid precip__grid--minute">
        ${slots.map((slot, index) => {
          const tone = slot.precip >= 0.6 ? 'high' : slot.precip > 0 ? 'mid' : 'low';
          const amount = slot.precip > 0 ? `${slot.precip.toFixed(1)} mm` : '';
          return `
          <div class="precip__cell">
            <div class="precip__time precip__time--minute">${label(index)}</div>
            <div class="precip__bar"><span class="precip__fill precip__fill--${tone}" style="height:${scale(slot.precip)}%"></span></div>
            <div class="precip__amount">${amount}</div>
          </div>`;
        }).join('')}
      </div>
    `;
    return;
  }

  const hours = (hourly || []).slice(0, 3);
  if (!hours.length) {
    el.hidden = true;
    return;
  }

  el.hidden = false;
  el.innerHTML = `
    <div class="precip__title">${svgIcon('droplet').outerHTML}<span>${t('card.precipTrend')}</span></div>
    <div class="precip__grid">
      ${hours.map((item, index) => {
        const pop = parseInt(item.pop, 10) || 0;
        const precip = parseFloat(item.precip) || 0;
        const label = index === 0 ? t('hourly.now') : formatHour(item.fxTime);
        const amount = precip > 0 ? `${precip.toFixed(1)} mm` : t('detail.noPrecip');
        const tone = pop >= 60 ? 'high' : pop >= 30 ? 'mid' : 'low';
        return `
          <div class="precip__cell">
            <div class="precip__time">${label}</div>
            <div class="precip__bar"><span class="precip__fill precip__fill--${tone}" style="height:${Math.max(pop, 6)}%"></span></div>
            <div class="precip__pop">${pop}%</div>
            <div class="precip__amount">${amount}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/* hero 结构只建一次，之后只更新文本。
   这样温度数字的竖条不会被销毁重建，滚动动效才连续。
   加载态与完成态共用同一套块级结构（同 class、同间距），
   只把文字槽位换成等高占位块，避免数据到达时首屏高度跳变（CLS）。 */
function heroStructureHTML(skeleton) {
  if (skeleton) {
    const ph = (w, h) => `<span class="skeleton" style="display:block;width:${w};height:${h};border-radius:var(--radius-sm)"></span>`;
    return `
    <div class="current__icon" id="current-icon"><span class="skeleton" style="display:block;width:4rem;height:4rem;border-radius:50%"></span></div>
    <div class="current__temp">
      <span class="temp-roll" id="temp-roll">${ph('0.6em', '0.95em')}</span><sup id="current-unit">°C</sup>
    </div>
    <div class="current__desc" id="current-desc">${ph('6rem', '1.1rem')}</div>
    <div class="current__summary" id="current-summary">${ph('70%', '1.1rem')}</div>
    <div class="current__delta" id="current-delta" hidden></div>
    <div class="current__range" id="current-range">
      <span class="current__range-high" id="current-range-high"></span>
      <span class="current__range-divider"></span>
      <span class="current__range-low" id="current-range-low"></span>
    </div>
    <div class="current__stats">
      <div class="current__stat">
        <span class="current__stat-label" data-i18n="detail.feelsLike"></span>
        <span class="current__stat-value" id="current-feels">${ph('2.5rem', '0.95rem')}</span>
      </div>
      <div class="current__stat">
        <span class="current__stat-label" data-i18n="detail.humidity"></span>
        <span class="current__stat-value" id="current-humidity">${ph('2.5rem', '0.95rem')}</span>
      </div>
      <div class="current__stat">
        <span class="current__stat-label" data-i18n="detail.wind"></span>
        <span class="current__stat-value" id="current-wind">${ph('3.5rem', '0.95rem')}</span>
      </div>
    </div>
    <div class="current__precip" id="current-precip" hidden></div>
    <div class="current__update" id="current-update"><span class="skeleton" style="display:block;width:7rem;height:0.8rem;border-radius:var(--radius-sm);margin:0 auto"></span></div>
  `;
  }

  return `
    <div class="current__icon" id="current-icon"></div>
    <div class="current__temp">
      <span class="temp-roll" id="temp-roll"></span><sup id="current-unit">°C</sup>
    </div>
    <div class="current__desc" id="current-desc"></div>
    <div class="current__summary" id="current-summary" hidden></div>
    <div class="current__delta" id="current-delta" hidden></div>
    <div class="current__range" id="current-range" hidden>
      <span class="current__range-high" id="current-range-high"></span>
      <span class="current__range-divider"></span>
      <span class="current__range-low" id="current-range-low"></span>
    </div>
    <div class="current__stats">
      <div class="current__stat">
        <span class="current__stat-label" data-i18n="detail.feelsLike"></span>
        <span class="current__stat-value" id="current-feels"></span>
      </div>
      <div class="current__stat">
        <span class="current__stat-label" data-i18n="detail.humidity"></span>
        <span class="current__stat-value" id="current-humidity"></span>
      </div>
      <div class="current__stat">
        <span class="current__stat-label" data-i18n="detail.wind"></span>
        <span class="current__stat-value" id="current-wind"></span>
      </div>
    </div>
    <div class="current__precip" id="current-precip" hidden></div>
    <div class="current__update" id="current-update"></div>
  `;
}

function cacheCurrentElements() {
  elements.currentIcon = $('#current-icon');
  elements.currentUnit = $('#current-unit');
  elements.currentDesc = $('#current-desc');
  elements.currentSummary = $('#current-summary');
  elements.currentDelta = $('#current-delta');
  elements.currentRange = $('#current-range');
  elements.currentRangeHigh = $('#current-range-high');
  elements.currentRangeLow = $('#current-range-low');
  elements.currentFeels = $('#current-feels');
  elements.currentHumidity = $('#current-humidity');
  elements.currentWind = $('#current-wind');
  elements.currentPrecip = $('#current-precip');
  elements.currentUpdate = $('#current-update');
  elements.tempRoll = $('#temp-roll');
}

/* 加载态：与完成态同构的占位块，仅在首屏尚未有数据时调用一次 */
function renderCurrentSkeleton() {
  if (!elements.currentSection) return;
  if (elements.heroSkeleton || elements.currentIcon) return;
  elements.currentSection.innerHTML = heroStructureHTML(true);
  cacheCurrentElements();
  elements.heroSkeleton = true;
  applyI18nToDOM();
}

function ensureCurrentSkeleton() {
  // 已有真实 hero 则复用；若当前是加载态骨架，则换成完成态结构（同高，无跳变）
  if (elements.currentIcon && !elements.heroSkeleton) return;

  elements.currentSection.innerHTML = heroStructureHTML(false);
  cacheCurrentElements();
  elements.heroSkeleton = false;
  applyI18nToDOM();
}

function renderCurrentWeather(data) {
  const { location, realtime, daily, hourly } = data;
  if (!elements.currentSection) return;

  ensureCurrentSkeleton();

  if (elements.headerCityName) {
    elements.headerCityName.textContent = location.name;
    elements.headerCityName.title = location.name;
  }

  lastObsTime = realtime.obsTime || null;

  const currentTemp = displayTemp(realtime.temp);
  const currentTempValue = currentTemp.replace(/°.*$/, '');
  const currentTempUnit = currentTemp.match(/°[CF]/)?.[0] || '°C';
  const feelsLikeTemp = displayTemp(realtime.feelsLike);

  const today = daily?.[0] || {};
  const highTemp = today.tempMax ? displayTemp(today.tempMax).replace(/°.*$/, '') : '';
  const lowTemp = today.tempMin ? displayTemp(today.tempMin).replace(/°.*$/, '') : '';

  const windText = realtime.windSpeed
    ? `${realtime.windDir} ${realtime.windSpeed}km/h`
    : `${realtime.windDir} ${realtime.windScale}${t('current.windLevel')}`;

  // 城市名由顶部导航承载，hero 只保留天气本体 + 毛玻璃数据胶囊；
  // 更新时间放在末尾作为注脚，避免抢占首屏视觉重心
  // icon 用 text 校正：接口偶发给错代码（如晴天返 500 雾），以文字为准
  const heroIcon = reconcileIcon(realtime.icon, realtime.text, isDaytime(data.astronomy));
  elements.currentIcon.className = `current__icon qi-${heroIcon}`;
  elements.currentUnit.textContent = currentTempUnit;
  setAnimText(elements.currentDesc, realtime.text);
  if (elements.currentDesc) elements.currentDesc.title = realtime.text || '';
  setAnimText(elements.currentFeels, feelsLikeTemp);
  setRollingStat(elements.currentHumidity, realtime.humidity, '%');
  setAnimText(elements.currentWind, windText);
  if (elements.currentWind) elements.currentWind.title = windText;

  // 功能3：更新时间用相对表述（"3 分钟前"），title 保留绝对时间
  renderUpdateNote();

  // 功能1：今日一句话综述（天气 + 高低温 + 一句建议）
  if (elements.currentSummary) {
    const summary = buildSummary(data);
    elements.currentSummary.hidden = !summary;
    setAnimText(elements.currentSummary, summary);
    elements.currentSummary.title = summary || '';
  }

  // 功能：与昨天同一时刻的均温对比（只用本地快照，零额外请求）
  if (elements.currentDelta) {
    const todayAvg = snapshotFrom(data).avg;
    const yKey = dayKey(new Date(Date.now() - 86400000));
    const yesterday = readHistory().find((e) => e?.d === yKey) || null;
    const diff = yesterday && Number.isFinite(todayAvg) && Number.isFinite(yesterday.avg)
      ? todayAvg - yesterday.avg : null;
    if (diff != null && Math.abs(diff) >= 0.5) {
      const value = Math.abs(diff).toFixed(0);
      const text = diff > 0 ? t('current.deltaWarmer', value) : t('current.deltaColder', value);
      elements.currentDelta.textContent = text;
      elements.currentDelta.hidden = false;
      elements.currentDelta.classList.toggle('current__delta--warmer', diff > 0);
      elements.currentDelta.classList.toggle('current__delta--colder', diff < 0);
    } else {
      elements.currentDelta.hidden = true;
      elements.currentDelta.textContent = '';
    }
  }

  if (highTemp && lowTemp) {
    setAnimText(elements.currentRangeHigh, `↑ ${highTemp}°`);
    setAnimText(elements.currentRangeLow, `↓ ${lowTemp}°`);
    elements.currentRange.hidden = false;
  } else {
    elements.currentRange.hidden = true;
  }

  renderTempRoll(currentTempValue);
  renderPrecipTrend(hourly, data.minutely);
  renderOuting(hourly);
  saveDiaryEntry(data);

  document.title = `${location.name} ${currentTemp} · ${CONFIG.brand}`;

  pushHomeWidget(data);
}

/**
 * 把当前天气推给安卓桌面小组件。
 *
 * 小组件是原生 RemoteViews，跑在 Launcher 进程里，读不到 WebView 的 localStorage，
 * 因此改由 App 在每次拿到新数据后经 ApexonShell 桥写进原生 SharedPreferences，
 * 再由 WeatherWidgetProvider 重绘所有尺寸的小组件实例。
 * 网页版没有这个桥，函数直接静默返回，不做任何降级处理。
 */
function pushHomeWidget(data) {
  const bridge = window.ApexonShell;
  if (!bridge || typeof bridge.saveWidgetData !== 'function') return;

  const { location, realtime, daily } = data;
  if (!location || !realtime) return;

  const isDay = isDaytime(data.astronomy);
  const temp = displayTemp(realtime.temp);
  // 小组件只显示数字，单位单独传：这样中文 12°C 与华氏 54°F 都能正确排版
  const strip = (v) => (v === undefined || v === null || v === '' ? '' : String(v).replace(/°.*$/, ''));

  const obs = realtime.obsTime ? new Date(realtime.obsTime) : new Date();
  const pad = (n) => String(n).padStart(2, '0');

  // 原生自主刷新（App 未打开也能更新）需要的请求参数：
  // 坐标来自当前城市，lang 用和风的语言码（不是界面语言码），设备号用于代理配额计数。
  const lang = getLanguage();
  const apiLang = { 'zh-CN': 'zh', 'zh-TW': 'zh-hant' }[lang] || lang || 'zh';
  const city = state.currentCity || {};
  const lat = city.lat ?? location.lat ?? '';
  const lon = city.lon ?? location.lon ?? '';

  // 原生侧 v2.7 起按 icon 码选矢量图标与渐变底板；
  // 之前这里只传 emoji，Java 一直取不到 icon 而走兜底「晴」，是个静默的降级 bug。
  const heroIcon = reconcileIcon(realtime.icon, realtime.text, isDay);
  const alertTitle = (data.warnings || [])[0]?.title || '';

  const payload = {
    city: location.name || '',
    temp: strip(temp),
    unit: temp.match(/°[CF]/)?.[0] || '',
    text: realtime.text || '',
    icon: heroIcon,
    night: !isDay,
    alert: alertTitle,
    emoji: weatherEmoji(realtime.icon, realtime.text, isDay),
    hi: strip(daily?.[0]?.tempMax ? displayTemp(daily[0].tempMax) : ''),
    lo: strip(daily?.[0]?.tempMin ? displayTemp(daily[0].tempMin) : ''),
    days: (daily || []).slice(1, 4).map((d) => ({
      label: formatDate(d.fxDate, { weekday: 'short', day: false }),
      icon: d.iconDay || '',
      emoji: weatherEmoji(d.iconDay, d.textDay, true),
      hi: strip(displayTemp(d.tempMax)),
      lo: strip(displayTemp(d.tempMin)),
    })),
    updated: `${pad(obs.getHours())}:${pad(obs.getMinutes())}`,
    // 小组件底部的「更新时间」前缀由前端给出，这样十种语言的文案与 App 内完全一致
    updatedLabel: t('current.updatedAt'),
    // ↓ 供原生定时刷新使用；缺了这些字段，App 退出后小组件就只能读旧缓存
    lat: lat === undefined || lat === null ? '' : String(lat),
    lon: lon === undefined || lon === null ? '' : String(lon),
    lang: apiLang,
    device_id: getDeviceId() || '',
  };

  try {
    bridge.saveWidgetData(JSON.stringify(payload));
  } catch (_) {
    // 桥调用异常（页面正在销毁等）不能影响主流程渲染
  }
}

/* 更新时间注脚：优先相对时间（xx 分钟前），title 保留精确时刻 */
function renderUpdateNote() {
  if (!elements.currentUpdate) return;
  const abs = formatUpdateTime(lastObsTime);
  const rel = formatRelativeTime(lastObsTime);
  elements.currentUpdate.textContent = `${t('current.updatedAt')} ${rel || abs || t('current.justNow')}`;
  if (abs) elements.currentUpdate.title = abs;
}

/* 今日一句话综述：按降水 → 空气 → 风 → 温度优先级挑一句建议，再拼接今日高低温 */
function buildSummary(data) {
  const { realtime, daily, hourly, airQuality } = data;
  const today = daily?.[0] || {};
  const high = today.tempMax != null && today.tempMax !== '' ? displayTemp(today.tempMax) : '';
  const low = today.tempMin != null && today.tempMin !== '' ? displayTemp(today.tempMin) : '';

  const cur = parseFloat(realtime?.temp);
  const pop = parseInt(hourly?.[0]?.pop, 10) || 0;
  const precip = parseFloat(realtime?.precip) || 0;
  const windScale = parseInt(realtime?.windScale, 10) || 0;
  const aqi = parseInt(airQuality?.aqi, 10);

  let advice;
  if (precip > 0 || pop >= 50) advice = t('summary.advice.rain');
  else if (Number.isFinite(aqi) && aqi > 100) advice = t('summary.advice.smog');
  else if (windScale >= 5) advice = t('summary.advice.wind');
  else if (Number.isFinite(cur) && cur >= 32) advice = t('summary.advice.hot');
  else if (Number.isFinite(cur) && cur <= 5) advice = t('summary.advice.cold');
  else advice = t('summary.advice.nice');

  return high && low ? t('summary.tpl', advice, high, low) : advice;
}

/* ============================
   Render Hourly
   ============================ */
function renderHourly(hourly) {
  if (!elements.hourlySection) return;
  const list = hourly.slice(0, 24);
  const container = elements.hourlySection.querySelector('.hourly__cards');
  if (!container) return;

  const now = new Date();
  const currentHour = now.getHours();

  container.innerHTML = list.map((item, index) => {
    const itemDate = new Date(item.fxTime);
    const isNow = index === 0 || (itemDate.getHours() === currentHour && itemDate.getDate() === now.getDate());
    const timeLabel = isNow ? t('hourly.now') : formatHour(item.fxTime);
    const icon = reconcileIcon(item.icon, item.text, itemDate.getHours() >= 6 && itemDate.getHours() < 18);
    const pop = Math.max(0, Math.min(100, parseInt(item.pop, 10) || 0));
    return `
    <div class="hourly__item${isNow ? ' hourly__item--now' : ''}" role="listitem">
      <span class="hourly__time">${timeLabel}</span>
      <span class="hourly__icon qi-${icon}"></span>
      <span class="hourly__temp">${displayTemp(item.temp)}</span>
      <span class="hourly__pop"${pop > 0 ? '' : ' data-empty="1"'}>${svgIcon('droplet').outerHTML}<b>${pop}%</b></span>
    </div>`;
  }).join('');

  renderHourlyTrend(list);
}

/* 功能2 + 功能7：24 小时温度曲线 + 降水概率柱。
 *
 * 关键设计（旧版被诟病"难看"的根因都在这里）：
 *  1. 曲线不再是独立滚动区。它和小时列同处 .hourly__scroll 内，宽度由列宽撑开，
 *     两者共用一次横向滑动，永远不会错位（旧版两块滚动条各自为政）。
 *  2. 不再使用 preserveAspectRatio="none" 去压扁 circle —— 旧版把圆拉成 31×6px 的
 *     椭圆，是"难看"最直观的来源。现在只画线与面（靠 vector-effect 保粗），
 *     横向拉伸对线条没有影响。
 *  3. 横坐标不是按 index 均分，而是实测首列中心与列间距后外推，
 *     因此换断点、换列宽、换语言（"现在"比"10时"宽）都不会偏。
 */
function renderHourlyTrend(hourly) {
  const el = $('#hourly-trend');
  const legend = $('#hourly-legend');
  if (!el) return;

  const list = (hourly || [])
    .slice(0, 24)
    .map((h) => ({
      temp: parseFloat(h.temp),
      pop: Math.max(0, Math.min(100, parseFloat(h.pop) || 0)),
      time: h.fxTime,
      day: (h.fxTime || '').slice(0, 10),
    }))
    .filter((h) => Number.isFinite(h.temp));

  if (list.length < 4) {
    el.hidden = true;
    el.innerHTML = '';
    if (legend) {
      legend.hidden = true;
      legend.innerHTML = '';
    }
    return;
  }

  const temps = list.map((h) => h.temp);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const span = Math.max(max - min, 1);
  const maxPop = Math.max(...list.map((h) => h.pop));

  // 与卡片对齐：读真实布局（offsetLeft 不受滚动位置影响），再线性外推。
  const track = el.parentElement;
  const cards = track ? track.querySelectorAll('.hourly__item') : null;
  const totalPx = track ? track.clientWidth : 0;
  let xs = null;
  let barW = 1;
  if (cards && cards.length >= 2 && totalPx > 0) {
    const c0 = cards[0].offsetLeft + cards[0].offsetWidth / 2;
    const pitch = cards[1].offsetLeft + cards[1].offsetWidth / 2 - c0;
    if (pitch > 0) {
      xs = Array.from(cards).map((_, i) => ((c0 + pitch * i) / totalPx) * 100);
      barW = (pitch * 0.3) / totalPx * 100;
    }
  }
  if (!xs) {
    const step = 100 / (list.length - 1);
    xs = list.map((_, i) => (i / (list.length - 1)) * (100 - step) + step / 2);
    barW = 1;
  }

  // 纵向：曲线占 6~26，面积下沿 30，降水柱贴底 40 向上生长，三者互不重叠
  const curveTop = 6;
  const curveBottom = 26;
  const toY = (v) => curveBottom - ((v - min) / span) * (curveBottom - curveTop);

  const pts = list.map((h, i) => [xs[i], toY(h.temp)]);
  // 水平控制点的三次贝塞尔：转折圆润但不会过冲（过冲会画出低于最低温的假谷）
  let curve = `M ${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    curve += ` C ${mx.toFixed(2)},${y0.toFixed(2)} ${mx.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  const area = `${curve} L ${pts[pts.length - 1][0].toFixed(2)},30 L ${pts[0][0].toFixed(2)},30 Z`;

  // 降水柱：pop 为 0 的时段不画，避免底部出现一排"牙签"
  const bars = list
    .map((h, i) => {
      if (h.pop <= 0) return '';
      const hUnits = 0.8 + (h.pop / 100) * 4.2;
      return `<rect class="trend__pop-bar" x="${(xs[i] - barW / 2).toFixed(2)}" y="${(40 - hUnits).toFixed(2)}" width="${barW.toFixed(2)}" height="${hUnits.toFixed(2)}" rx="${(barW / 2).toFixed(2)}"></rect>`;
    })
    .join('');

  // 跨天分隔线
  const breaks = list
    .map((h, i) => (i > 0 && h.day && h.day !== list[i - 1].day ? xs[i] : null))
    .filter((x) => x !== null)
    .map((x) => `<line class="trend__daybreak" x1="${x.toFixed(2)}" y1="2" x2="${x.toFixed(2)}" y2="40"></line>`)
    .join('');

  el.hidden = false;
  el.innerHTML = `
    <svg class="hourly__chart-svg" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="hourlyAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.26"></stop>
          <stop offset="100%" stop-color="currentColor" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${breaks}
      <path class="trend__area" d="${area}"></path>
      ${bars}
      <path class="trend__line" d="${curve}"></path>
    </svg>
  `;

  if (legend) {
    const maxIdx = temps.indexOf(max);
    const minIdx = temps.indexOf(min);
    legend.hidden = false;
    legend.innerHTML = `
      <span class="hourly__legend-chip">${t('share.high')} <b>${displayTemp(max)}</b><i>${formatHour(list[maxIdx].time)}</i></span>
      <span class="hourly__legend-chip">${t('share.low')} <b>${displayTemp(min)}</b><i>${formatHour(list[minIdx].time)}</i></span>
      ${maxPop > 0 ? `<span class="hourly__legend-chip hourly__legend-chip--pop">${svgIcon('droplet').outerHTML}<b>${Math.round(maxPop)}%</b></span>` : ''}
      <span class="hourly__day-chip" id="hourly-day-chip" hidden>${t('hourly.tomorrow')}</span>
    `;
  }

  // X14：记下"明天"第一格的横向位置，滚动到那里时点亮标题旁的「明天」角标
  if (cards && cards.length) {
    const breakIdx = list.findIndex((h, i) => i > 0 && h.day && h.day !== list[i - 1].day);
    hourlyDayBreak = breakIdx > 0 ? cards[breakIdx].offsetLeft : -1;
    updateHourlyDayChip();
  }
}

/* 当前滚动位置是否已经进入「明天」
   阈值取 8px：滑到明日首格贴边时才亮起，早一点晚一点都不会误判 */
let hourlyDayBreak = -1;

function updateHourlyDayChip() {
  const chip = $('#hourly-day-chip');
  if (!chip) return;
  const scroller = elements.hourlySection?.querySelector('.hourly__scroll');
  if (!scroller || hourlyDayBreak < 0) {
    chip.hidden = true;
    return;
  }
  chip.hidden = scroller.scrollLeft + 8 < hourlyDayBreak;
}

function setupHourlyDayChip() {
  const scroller = elements.hourlySection?.querySelector('.hourly__scroll');
  if (!scroller || scroller.dataset.dayChipBound === '1') return;
  scroller.dataset.dayChipBound = '1';
  let raf = 0;
  scroller.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      updateHourlyDayChip();
    });
  }, { passive: true });
}

/* ============================
   Render Daily
   ============================ */
function renderDaily(daily) {
  if (!elements.dailySection) return;
  const container = elements.dailySection.querySelector('.daily__list');
  if (!container) return;

  // Calculate overall min/max for temp range bar
  const allTemps = daily.flatMap((d) => [parseInt(d.tempMin, 10), parseInt(d.tempMax, 10)]);
  const overallMin = Math.min(...allTemps);
  const overallMax = Math.max(...allTemps);
  const tempRange = Math.max(overallMax - overallMin, 1);

  container.innerHTML = daily.map((item, index) => {
    const tMin = parseInt(item.tempMin, 10);
    const tMax = parseInt(item.tempMax, 10);
    const barLeft = ((tMin - overallMin) / tempRange) * 100;
    const barWidth = ((tMax - tMin) / tempRange) * 100;
    const icon = reconcileIcon(item.iconDay, item.textDay, true);

    return `
    <div class="daily__item ${index === 0 ? 'daily__item--today' : ''}" data-index="${index}" role="button" tabindex="0" aria-label="${item.textDay || ''} ${t('daily.tapHint')}">
      <div class="daily__day">${formatDate(item.fxDate)}</div>
      <div class="daily__icon qi-${icon}"></div>
      <div class="daily__text">${item.textDay || ''}</div>
      <div class="daily__temp-bar">
        <div class="daily__temp-bar-fill" style="left: ${barLeft}%; width: ${Math.max(barWidth, 8)}%;"></div>
      </div>
      <div class="daily__temp">
        <span class="daily__temp-low">${displayTemp(item.tempMin)}</span>
        <span class="daily__temp-high">${displayTemp(item.tempMax)}</span>
      </div>
    </div>
  `;
  }).join('');

  // 功能12：点击任意一天打开详情弹窗；X13 支持按住滑动"刷"出每天明细
  $$('.daily__item', container).forEach((row) => {
    const open = () => {
      // 刚结束一次滑动浏览时不打开弹窗，避免"一滑就弹"
      if (Date.now() - scrubGuard.last < 320) return;
      openDailyDetail(daily[Number(row.dataset.index)]);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });

  setupDailyScrub(container, daily);
}

/* X13：按住温度区间条左右滑动，逐日显示明细（松手不打开弹窗） */
const scrubGuard = { last: 0 };

function setupDailyScrub(container, daily) {
  const card = container.closest('.card');
  if (!card) return;
  let tip = card.querySelector('.daily__scrub-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'daily__scrub-tip';
    tip.hidden = true;
    card.appendChild(tip);
  }

  let active = false;

  const rowAt = (y) => {
    const rows = $$('.daily__item', container);
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return rows[i];
    }
    return null;
  };

  const paint = (row) => {
    if (!row) return;
    const i = Number(row.dataset.index);
    const d = daily[i];
    if (!d) return;
    const pop = parseInt(d.pop, 10) || 0;
    tip.innerHTML = `<b>${formatDate(d.fxDate)}</b><span>${d.textDay || ''}</span><i>${displayTemp(d.tempMin)} ~ ${displayTemp(d.tempMax)}</i>${pop ? `<em>${t('daily.pop')} ${pop}%</em>` : ''}`;
    tip.hidden = false;
    container.querySelectorAll('.daily__item--scrub').forEach((el) => el.classList.remove('daily__item--scrub'));
    row.classList.add('daily__item--scrub');
  };

  const stop = () => {
    if (!active) return;
    active = false;
    scrubGuard.last = Date.now();
    tip.hidden = true;
    container.querySelectorAll('.daily__item--scrub').forEach((el) => el.classList.remove('daily__item--scrub'));
    if (navigator.vibrate) navigator.vibrate(8);
  };

  container.addEventListener('pointerdown', (e) => {
    // 只接管温度条那一条横带，点日期/图标仍然照常打开详情
    const bar = e.target.closest('.daily__temp-bar');
    if (!bar) return;
    active = true;
    paint(rowAt(e.clientY));
  });

  container.addEventListener('pointermove', (e) => {
    if (!active) return;
    paint(rowAt(e.clientY));
  });

  container.addEventListener('pointerup', stop);
  container.addEventListener('pointercancel', stop);
  container.addEventListener('pointerleave', (e) => {
    // 手指滑出列表时结束浏览，但不当作"点了一下"
    if (active && e.pointerType === 'mouse') stop();
  });
}

/* 功能12：单日详情弹窗内容 */
function openDailyDetail(day) {
  const overlay = $('#daily-detail');
  const body = $('#daily-detail-body');
  if (!overlay || !body || !day) return;

  const dayIcon = reconcileIcon(day.iconDay, day.textDay, true);
  const nightIcon = reconcileIcon(day.iconNight, day.textNight, false);

  const cells = [
    { icon: 'droplet', label: t('detail.humidity'), value: day.humidity ? `${day.humidity}%` : '--' },
    { icon: 'gauge', label: t('detail.pressure'), value: day.pressure ? `${day.pressure} hPa` : '--' },
    { icon: 'cloudRain', label: t('detail.precip'), value: day.precip ? `${day.precip} mm` : t('detail.noPrecip') },
    { icon: 'eye', label: t('detail.visibility'), value: day.vis ? `${day.vis} km` : '--' },
    { icon: 'wind', label: t('detail.wind'), value: `${day.windDirDay || ''} ${day.windScaleDay || ''}${day.windScaleDay ? t('current.windLevel') : ''}`.trim() || '--' },
    { icon: 'sun', label: t('daily.uv'), value: day.uvIndex || '--' },
  ];

  body.innerHTML = `
    <div class="detail-day__hero">
      <div class="detail-day__icon qi-${dayIcon}"></div>
      <div class="detail-day__main">
        <div class="detail-day__date">${formatDate(day.fxDate)}</div>
        <div class="detail-day__desc">${day.textDay || ''}</div>
      </div>
      <div class="detail-day__temp">
        <div class="detail-day__temp-high">${displayTemp(day.tempMax)}</div>
        <div class="detail-day__temp-low">${displayTemp(day.tempMin)}</div>
      </div>
    </div>
    <div class="detail-day__daynight">
      <div class="detail-day__phase">
        <div class="detail-day__phase-icon qi-${dayIcon}"></div>
        <div>
          <div class="detail-day__phase-label">${t('daily.day')}</div>
          <div class="detail-day__phase-value">${day.textDay || '--'}</div>
        </div>
      </div>
      <div class="detail-day__phase">
        <div class="detail-day__phase-icon qi-${nightIcon}"></div>
        <div>
          <div class="detail-day__phase-label">${t('daily.night')}</div>
          <div class="detail-day__phase-value">${day.textNight || '--'}</div>
        </div>
      </div>
    </div>
    <div class="detail-day__grid">
      ${cells.map((c) => `
        <div class="detail-day__cell">
          <div class="detail-day__cell-icon">${svgIcon(c.icon).outerHTML}</div>
          <div>
            <div class="detail-day__cell-label">${c.label}</div>
            <div class="detail-day__cell-value">${c.value}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  overlay.hidden = false;
  void overlay.offsetWidth;
  overlay.classList.add('sheet-overlay--visible');
}

function closeDailyDetail() {
  const overlay = $('#daily-detail');
  if (!overlay) return;
  overlay.classList.remove('sheet-overlay--visible');
  setTimeout(() => {
    overlay.hidden = true;
  }, 300);
}

/* ============================
   Render Air Quality
   ============================ */
function renderAirQuality(aqi) {
  if (!elements.aqiSection) return;
  let container = elements.aqiSection.querySelector('.aqi');

  if (!container) {
    container = document.createElement('div');
    container.className = 'aqi';
    elements.aqiSection.appendChild(container);
  }

  if (!aqi) {
    container.className = 'aqi';
    container.innerHTML = `
      <div class="empty" style="padding: var(--space-8) var(--space-4);">
        ${svgIcon('alertCircle').outerHTML}
        <div class="empty__title">${t('aqi.noData')}</div>
      </div>
    `;
    return;
  }

  const levelMap = [
    { max: 50, label: t('aqi.level.0'), advice: t('aqi.advice.0') },
    { max: 100, label: t('aqi.level.1'), advice: t('aqi.advice.1') },
    { max: 150, label: t('aqi.level.2'), advice: t('aqi.advice.2') },
    { max: 200, label: t('aqi.level.3'), advice: t('aqi.advice.3') },
    { max: 300, label: t('aqi.level.4'), advice: t('aqi.advice.4') },
    { max: Infinity, label: t('aqi.level.5'), advice: t('aqi.advice.5') },
  ];

  const value = parseInt(aqi.aqi, 10) || 0;
  const levelIndex = levelMap.findIndex((l) => value <= l.max);
  const level = levelMap[levelIndex];
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (Math.min(value, 500) / 500) * circumference;

  const pollutants = [
    { label: 'PM2.5', value: aqi.pm2p5 },
    { label: 'PM10', value: aqi.pm10 },
    { label: 'O₃', value: aqi.o3 },
    { label: 'SO₂', value: aqi.so2 },
    { label: 'NO₂', value: aqi.no2 },
    { label: 'CO', value: aqi.co },
  ];

  // 等级配色由 .aqi--lN 提供 --aqi-color（见 main.css），不在 DOM 上写内联颜色
  container.className = `aqi aqi--l${levelIndex}`;
  // --aqi-off 供 CSS 在挂载时从"满圈"收拢到目标值，形成圆环生长动画
  container.innerHTML = `
    <div class="aqi__ring">
      <svg viewBox="0 0 100 100">
        <circle class="aqi__ring-bg" cx="50" cy="50" r="45"></circle>
        <circle class="aqi__ring-fill" cx="50" cy="50" r="45" style="--aqi-off: ${offset};"></circle>
      </svg>
      <div class="aqi__value">0</div>
    </div>
    <div class="aqi__info">
      <div class="aqi__level">${level.label}</div>
      <div class="aqi__advice" title="${level.advice}">${level.advice}</div>
    </div>
    <div class="aqi__pollutants">
      ${pollutants.map((p) => `
        <div class="aqi__pollutant">
          <span class="aqi__pollutant-label">${p.label}</span>
          <span class="aqi__pollutant-value">${p.value || '--'}</span>
        </div>
      `).join('')}
    </div>
  `;

  // AQI 数字从上一值滚动到新值，等级变化时有明显的"跳动"反馈
  const aqiValueEl = container.querySelector('.aqi__value');
  countUp(aqiValueEl, lastAqiValue, value);
  lastAqiValue = value;
}

/* 功能13：未来数日空气质量趋势对比（点开前 5 天，条形高度按 AQI 分档配色） */
function renderAqiTrend(forecast) {
  const el = $('#aqi-trend');
  if (!el) return;

  const days = (forecast || [])
    .map((d) => ({ date: d.fxDate, aqi: parseInt(d.aqi, 10), primary: d.primaryPollutant }))
    .filter((d) => Number.isFinite(d.aqi));

  if (days.length < 2) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  const first = days[0].aqi;
  const last = days[days.length - 1].aqi;
  const diff = last - first;
  const deltaClass = diff <= -5 ? 'better' : diff >= 5 ? 'worse' : 'flat';
  const deltaText = diff <= -5 ? t('aqi.trendBetter') : diff >= 5 ? t('aqi.trendWorse') : t('aqi.trendFlat');
  const deltaLabel = `${t('aqi.trendDelta')} ${diff > 0 ? '+' : ''}${diff}`;

  el.hidden = false;
  el.innerHTML = `
    <div class="aqi__trend-head">
      <span class="aqi__trend-title">${t('aqi.trend')}</span>
      <span class="aqi__trend-delta aqi__trend-delta--${deltaClass}">${deltaText} · ${deltaLabel}</span>
    </div>
    <div class="aqi__trend-bars">
      ${days.slice(0, 5).map((d, i) => {
        const lv = aqiLevelIndex(d.aqi);
        const height = Math.max(12, Math.min(100, (d.aqi / 300) * 100));
        const label = i === 0 ? t('date.today') : String(Number(d.date.slice(8, 10)));
        return `
          <div class="aqi__trend-bar">
            <span class="aqi__trend-value">${d.aqi}</span>
            <div class="aqi__trend-track">
              <div class="aqi__trend-fill" style="height:${height}%;background:var(--aqi-${lv})"></div>
            </div>
            <span class="aqi__trend-label">${label}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/* ============================
   Render Details
   ============================ */
/* X7：详情数值滚动需要「上一轮的值」，而详情卡每次都是重建的，
   所以把旧值按稳定 key 存在内存里，重绘后从旧值滚到新值。 */
const lastDetailNum = Object.create(null);

function renderDetails(data) {
  if (!elements.detailsSection) return;
  const container = elements.detailsSection.querySelector('.details__grid');
  if (!container) return;

  const { realtime } = data;

  // 降水量：优先用实时数据，为0时取小时预报数据，仍为0则显示"无降水"
  const realtimePrecip = parseFloat(realtime.precip) || 0;
  const hourlyPrecip = parseFloat(data.hourly?.[0]?.precip) || 0;
  const precipValue = realtimePrecip > 0 ? realtimePrecip : (hourlyPrecip > 0 ? hourlyPrecip : 0);
  const precip = precipValue > 0 ? `${precipValue} mm` : t('detail.noPrecip');

  // 风速：优先用 windSpeed，没有则用 windScale
  const windDisplay = realtime.windSpeed
    ? `${realtime.windDir} ${realtime.windSpeed}km/h`
    : `${realtime.windDir} ${realtime.windScale}${t('detail.windLevel')}`;

  const details = [
    { icon: 'thermometer', label: t('detail.feelsLike'), value: displayTemp(realtime.feelsLike) },
    { icon: 'droplet', label: t('detail.humidity'), value: `${realtime.humidity}%`, key: 'humidity', num: realtime.humidity, unit: '%' },
    { icon: 'wind', label: t('detail.wind'), value: windDisplay },
    { icon: 'gauge', label: t('detail.pressure'), value: `${realtime.pressure} hPa`, key: 'pressure', num: realtime.pressure, unit: ' hPa' },
    { icon: 'cloudRain', label: t('detail.precip'), value: precip },
    { icon: 'eye', label: t('detail.visibility'), value: `${realtime.vis} km` },
    { icon: 'cloud', label: t('detail.cloud'), value: realtime.cloud ? `${realtime.cloud}%` : '--', key: 'cloud', num: realtime.cloud, unit: '%' },
    { icon: 'droplet', label: t('detail.dew'), value: realtime.dew ? `${realtime.dew}°` : '--' },
    { icon: 'sun', label: t('daily.uv'), value: data.daily?.[0]?.uvIndex || '--', uv: true },
  ];

  container.innerHTML = details.map((d, i) => `
    <div class="detail${d.uv ? ' detail--tap' : ''}" ${d.uv ? 'data-uv-open role="button" tabindex="0"' : ''}>
      <div class="detail__icon">${svgIcon(d.icon).outerHTML}</div>
      <div>
        <div class="detail__label">${d.label}</div>
        <div class="detail__value"${d.key ? ` data-roll="${i}"` : ''}>${d.value}</div>
      </div>
    </div>
  `).join('');

  // 数值变化时从旧值滚到新值；首次渲染直接落位，不演一遍从 0 起跳
  details.forEach((d, i) => {
    if (!d.key) return;
    const n = Number(d.num);
    if (!Number.isFinite(n)) return;
    const el = container.querySelector(`[data-roll="${i}"]`);
    const prev = lastDetailNum[d.key];
    if (el && Number.isFinite(prev) && prev !== n) {
      el.textContent = '';
      const span = document.createElement('span');
      el.appendChild(span);
      if (d.unit) el.appendChild(document.createTextNode(d.unit));
      countUp(span, prev, Math.round(n), 520);
    }
    lastDetailNum[d.key] = n;
  });
}

/* ---- X11：最后一次成功的天气，用来在断网时灰显兜底 ---- */
const LAST_GOOD_KEY = 'apexon_last_good_weather';

function saveLastGood(city, data) {
  if (!city?.id || !data?.realtime) return;
  try {
    storage.set(LAST_GOOD_KEY, {
      id: city.id,
      at: data.fetchedAt || Date.now(),
      data: {
        location: data.location,
        realtime: data.realtime,
        hourly: data.hourly || [],
        daily: data.daily || [],
        airQuality: data.airQuality || null,
        airForecast: [],
        warnings: data.warnings || [],
        astronomy: data.astronomy || null,
        minutely: data.minutely || null,
        fetchedAt: data.fetchedAt || Date.now(),
      },
    });
  } catch (_) {
    /* 存储满时静默放弃，不影响主流程 */
  }
}

function readLastGood(city) {
  const saved = storage.get(LAST_GOOD_KEY, null);
  if (!saved?.data?.realtime) return null;
  if (city?.id && String(saved.id) !== String(city.id)) return null;
  return saved;
}

/** 页面顶部一条低调的「数据截至」，同时把卡片降饱和度 */
function markStaleState(at) {
  document.documentElement.dataset.stale = '1';
  const page = $('#page-home');
  if (!page) return;
  let note = $('#stale-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'stale-note';
    note.className = 'stale-note';
    page.insertBefore(note, page.firstChild);
  }
  const time = at ? new Date(at) : null;
  const hhmm = time && !Number.isNaN(time.getTime())
    ? `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
    : '--:--';
  note.textContent = t('fresh.staleNote', hhmm);
  note.hidden = false;
}

function clearStaleState() {
  delete document.documentElement.dataset.stale;
  const note = $('#stale-note');
  if (note) note.hidden = true;
}

/** 有上次结果就用它把页面铺满，返回是否成功兜底 */
function renderLastGood(city) {
  if (state.weather) {
    markStaleState(state.weather.fetchedAt);
    return true;
  }
  const saved = readLastGood(city);
  if (!saved) return false;
  const data = saved.data;
  state.weather = data;
  state.currentCity = city || state.currentCity;
  renderCurrentWeather(data);
  renderHourly(data.hourly);
  renderDaily(data.daily);
  renderSunPosition(data.astronomy);
  renderAirQuality(data.airQuality);
  renderDetails(data);
  renderWarnings(data.warnings);
  renderAlertBar(data);
  applySceneAccent(data);
  renderFreshness(data);
  updateBlueprint(state);
  setWeatherBackground(data.realtime?.icon, isDaytime(data.astronomy), data.realtime?.text || '');
  markStaleState(saved.at);
  return true;
}

/* ============================
   Render Warnings
   ============================ */
/* 预警严重度：和风 severityColor 取值 blue < yellow < orange < red */
const SEVERITY_ORDER = { blue: 0, yellow: 1, orange: 2, red: 3 };
function warningSeverity(w) {
  const color = (w?.severityColor || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, color) ? color : 'blue';
}

function renderWarnings(warnings) {
  if (!elements.warningSection) return;
  if (!warnings || warnings.length === 0) {
    elements.warningSection.innerHTML = '';
    // 空态必须 hidden：容器本身是网格/弹性子项，
    // 留一个空盒子会额外吃掉一个 gap，在卡片列表末尾留下空白
    elements.warningSection.hidden = true;
    return;
  }

  const topSeverity = warnings
    .map(warningSeverity)
    .reduce((a, b) => (SEVERITY_ORDER[b] > SEVERITY_ORDER[a] ? b : a), 'blue');
  const collapse = warnings.length > 2;

  // G2：预警年表只归档真实出现过的条目，同城同日同标题只记一次
  if (state.currentCity) recordWarnings(state.currentCity, warnings);

  elements.warningSection.hidden = false;
  elements.warningSection.innerHTML = `
    <div class="card warning-card warning-card--${topSeverity}">
      <div class="card__title warning-card__title warning-card__head">
        <span class="warning-card__dot" aria-hidden="true"></span>
        ${svgIcon('alertCircle').outerHTML}
        <span>${t('card.warnings')}</span>
        <span class="warning-card__count">${t('warning.count', warnings.length)}</span>
      </div>
      <div class="warning-card__list ${collapse ? 'warning-card__list--collapsed' : ''}">
        ${warnings.map((w) => `
          <div class="warning-card__item">
            <div class="warning-card__headline">
              <div class="warning-card__title-text">${w.title}</div>
              <svg class="warning-card__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
            <div class="warning-card__time">${w.pubTime || ''}</div>
            ${w.text ? `<div class="warning-card__text">${w.text}</div>` : ''}
          </div>
        `).join('')}
      </div>
      ${collapse ? `<button type="button" class="warning-card__more" data-action="expand-warnings">${t('warning.hint')}</button>` : ''}
    </div>
  `;

  // 点击单条预警展开/收起详细说明
  $$('.warning-card__item', elements.warningSection).forEach((item) => {
    item.addEventListener('click', () => item.classList.toggle('warning-card__item--open'));
  });

  // 超过两条时默认折叠，点"查看更多"展开全部
  const moreBtn = elements.warningSection.querySelector('[data-action="expand-warnings"]');
  moreBtn?.addEventListener('click', () => {
    const list = elements.warningSection.querySelector('.warning-card__list');
    list?.classList.remove('warning-card__list--collapsed');
    moreBtn.remove();
  });
}

/* ============================
   Render Sun Position (日出日落弧)
   ============================ */
function renderSunPosition(astronomy) {
  const sunSection = $('#sun-section');
  const sunrise = astronomy?.sunrise;
  const sunset = astronomy?.sunset;
  if (!sunSection) return;
  if (!sunrise || !sunset) {
    // 没有日出日落数据时隐藏卡片，避免显示空白区块
    sunSection.style.display = 'none';
    return;
  }

  sunSection.style.display = '';

  const riseTimeEl = $('#sun-rise-time');
  const setTimeEl = $('#sun-set-time');
  if (riseTimeEl) riseTimeEl.textContent = sunrise;
  if (setTimeEl) setTimeEl.textContent = sunset;

  const progressEl = sunSection.querySelector('.sun-arc__progress');
  const dotEl = sunSection.querySelector('.sun-arc__dot');
  if (!progressEl || !dotEl) return;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [srH, srM] = sunrise.split(':').map(Number);
  const [ssH, ssM] = sunset.split(':').map(Number);
  const sunriseMin = srH * 60 + srM;
  const sunsetMin = ssH * 60 + ssM;

  let progress = 0;
  if (nowMinutes >= sunriseMin && nowMinutes <= sunsetMin) {
    progress = (nowMinutes - sunriseMin) / (sunsetMin - sunriseMin);
  } else if (nowMinutes < sunriseMin) {
    progress = 0;
  } else {
    progress = 1;
  }

  // Update arc progress (pathLength=100, so dashoffset = 100 - progress*100)
  const dashOffset = 100 - progress * 100;
  progressEl.style.strokeDashoffset = dashOffset.toFixed(1);

  // Calculate dot position on the quadratic bezier curve
  // Path: M 20 100 Q 150 -20 280 100
  // Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
  const t = progress;
  const x = (1 - t) * (1 - t) * 20 + 2 * (1 - t) * t * 150 + t * t * 280;
  const y = (1 - t) * (1 - t) * 100 + 2 * (1 - t) * t * (-20) + t * t * 100;
  dotEl.setAttribute('cx', x.toFixed(1));
  dotEl.setAttribute('cy', y.toFixed(1));
}

/* ============================
   Search
   ============================ */
function setupSearch() {
  if (!elements.searchInput) return;

  const debouncedSearch = debounce(async (keyword) => {
    if (!keyword || keyword.length < CONFIG.minSearchChars) {
      renderSearchResults([]);
      return;
    }
    // Show loading state
    if (elements.searchResults) {
      elements.searchResults.innerHTML = `
        <div class="search__loading">
          <div class="search__loading-spinner"></div>
          <span>${t('search.searching')}</span>
        </div>
      `;
    }
    try {
      const results = await searchCities(keyword);
      state.searchResults = results;
      renderSearchResults(results);
    } catch (error) {
      console.error('Search failed:', error);
      const reason = error?.message || '';
      let msg = t('search.failed');
      if (reason.includes('HTTP')) msg = `${t('search.failedHttp')}${reason}`;
      else if (reason.includes('API')) msg = `${t('search.failedApi')}${reason}`;
      else if (reason.includes('fetch') || reason.includes('Network')) msg = t('search.networkError');
      if (elements.searchResults) {
        elements.searchResults.innerHTML = `
          <div class="search__no-results">
            <span>${msg}</span>
          </div>
        `;
      }
    }
  }, CONFIG.debounceMs);

  elements.searchInput.addEventListener('input', (e) => {
    debouncedSearch(e.target.value.trim());
  });

  $('#search-clear')?.addEventListener('click', () => {
    elements.searchInput.value = '';
    renderSearchResults([]);
    elements.searchInput.focus();
  });
}

function renderSearchResults(results) {
  if (!elements.searchResults) return;

  if (results.length === 0) {
    const keyword = elements.searchInput?.value?.trim() || '';
    if (keyword && keyword.length >= CONFIG.minSearchChars) {
      elements.searchResults.innerHTML = `
        <div class="search__no-results">
          <span>${t('search.noResults', keyword)}</span>
        </div>
      `;
    } else {
      elements.searchResults.innerHTML = '';
    }
    return;
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  elements.searchResults.innerHTML = results.map((city) => `
    <div class="city-item" role="listitem" data-city-id="${city.id}">
      <div class="city-item__front">
        <div class="city-item__main">
          <div class="city-item__name" title="${esc(city.name)}">${esc(city.name)}</div>
          <div class="city-item__path" title="${esc(`${city.adm2} · ${city.adm1}`)}">${esc(city.adm2)} · ${esc(city.adm1)}</div>
        </div>
        <button type="button" class="icon-btn" data-action="add-city" data-city='${JSON.stringify(city).replace(/'/g, '&#39;')}' aria-label="${esc(t('search.addCity'))}">
          ${svgIcon('arrowRight').outerHTML}
        </button>
      </div>
    </div>
  `).join('');

  $$('[data-action="add-city"]', elements.searchResults).forEach((btn) => {
    btn.addEventListener('click', () => {
      try {
        const city = JSON.parse(btn.dataset.city);
        addCity(city);
      } catch {
        showToast(t('search.addFailed'));
      }
    });
  });
}

function addCity(city) {
  const added = cityStore.add(city);
  showToast(added ? `${t('search.added')} ${city.name}` : `${t('search.switchedTo')} ${city.name}`);
  renderSavedCities();
  state.currentCity = city;
  loadWeather(city);
  navigateTo('home');
}

/* ============================
   Saved Cities
   ============================ */
function renderSavedCities() {
  if (!elements.savedCities) return;
  const cities = cityStore.getAll();

  if (cities.length === 0) {
    elements.savedCities.innerHTML = `
      <div class="empty">
        ${svgIcon('mapPin').outerHTML}
        <div class="empty__title">${t('cities.noCities')}</div>
        <div class="empty__desc">${t('cities.noCitiesDesc')}</div>
      </div>
    `;
    return;
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const compareCities = cities.slice(0, 2);
  const compareEntries = [];

  elements.savedCities.innerHTML = `
    <div id="commute-card" class="commute" hidden></div>
    ${cities.map((city) => {
    const active = String(state.currentCity?.id) === String(city.id) ? ' city-item--active' : '';
    const name = city.name || '';
    const pathText = [city.adm2, city.adm1].filter(Boolean).join(' ');
    return `
    <div class="city-item${active}" role="listitem" data-city-id="${city.id}">
      <button type="button" class="city-item__remove" data-action="remove-city" data-city-id="${city.id}" aria-label="${esc(t('cities.remove'))}" tabindex="-1">
        ${svgIcon('trash').outerHTML}
      </button>
      <div class="city-item__front">
        <div class="city-item__main">
          <div class="city-item__name" title="${esc(name)}">${esc(name)}</div>
          ${pathText ? `<div class="city-item__path" title="${esc(pathText)}">${esc(pathText)}</div>` : '<div class="city-item__path"></div>'}
        </div>
        <div class="city-item__weather" data-weather-city="${city.id}">
          <div class="city-item__weather-icon skeleton" style="width:1.5rem;height:1.5rem;border-radius:50%"></div>
          <div class="city-item__weather-temp skeleton" style="height:1.25rem;width:2.5rem;border-radius:var(--radius-md)"></div>
        </div>
      </div>
    </div>
  `;
  }).join('')}
  `;

  // 双城通勤对照：只用前两个城市的实时数据，不发额外请求
  const paintCommute = () => {
    const card = elements.savedCities?.querySelector('#commute-card');
    if (!card || compareEntries.length < 2) return;
    const [a, b] = compareEntries;
    if (!Number.isFinite(a.temp) || !Number.isFinite(b.temp)) return;

    const diff = a.temp - b.temp;
    const abs = Math.abs(diff);
    let note;
    if (abs < 0.5) note = t('cities.compareSame');
    else if (diff > 0) note = t('cities.compareWarmer', a.name, b.name, Math.round(abs));
    else note = t('cities.compareColder', a.name, b.name, Math.round(abs));

    card.innerHTML = `
      <div class="commute__head">
        <span class="commute__title">${t('cities.compareTitle')}</span>
        <span class="commute__hint">${t('cities.compareHint')}</span>
      </div>
      <div class="commute__row">
        <div class="commute__city">
          <div class="commute__name">${esc(a.name)}</div>
          <div class="commute__temp">${displayTemp(a.temp)}</div>
          <div class="commute__text">${esc(a.text)}</div>
        </div>
        <div class="commute__delta" aria-hidden="true">Δ ${Math.round(abs)}°</div>
        <div class="commute__city">
          <div class="commute__name">${esc(b.name)}</div>
          <div class="commute__temp">${displayTemp(b.temp)}</div>
          <div class="commute__text">${esc(b.text)}</div>
        </div>
      </div>
      <div class="commute__note">${esc(note)}</div>
    `;
    card.hidden = false;
  };

  const cityById = (id) => cities.find((c) => String(c.id) === String(id));

  $$('.city-item', elements.savedCities).forEach((item) => {
    setupCityCardGestures(item, cities, cityById);
  });

  $$('[data-action="remove-city"]', elements.savedCities).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.cityId;
      cityStore.remove(id);
      renderSavedCities();
      showToast(t('cities.removed'));
    });
  });

  // Asynchronously fetch weather for each city
  cities.forEach((city) => {
    getRealtimeWeather(city.id).then((realtime) => {
      const weatherEl = elements.savedCities.querySelector(`[data-weather-city="${city.id}"]`);
      if (weatherEl) {
        // 功能8：城市卡同时给出图标、温度与一句天气描述（图标同样按文字校正）
        const icon = reconcileIcon(realtime.icon, realtime.text, isDaytime(null));
        weatherEl.innerHTML = `
          <div class="city-item__weather-icon qi-${icon}"></div>
          <div class="city-item__weather-temp">${displayTemp(realtime.temp)}</div>
          <div class="city-item__weather-desc" title="${String(realtime.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}">${realtime.text || ''}</div>
        `;
      }
      if (compareCities.some((c) => String(c.id) === String(city.id))) {
        compareEntries.push({
          id: city.id,
          name: city.name || '',
          temp: parseFloat(realtime.temp),
          text: realtime.text || '',
        });
        paintCommute();
      }
    }).catch(() => {
      const weatherEl = elements.savedCities.querySelector(`[data-weather-city="${city.id}"]`);
      if (weatherEl) {
        weatherEl.innerHTML = '<div class="city-item__weather-text">--</div>';
      }
      // 网络失败时退回本地快照，对照卡仍可用
      if (compareCities.some((c) => String(c.id) === String(city.id))) {
        const snap = readCitySnapshots().find((s) => String(s.id) === String(city.id));
        if (snap) {
          compareEntries.push({ id: city.id, name: snap.name || city.name || '', temp: snap.temp, text: snap.text || '' });
          paintCommute();
        }
      }
    });
  });
}

/* ============================
   城市卡手势：长按拖拽排序 + 左滑露出删除
   统一用 Pointer Events 兼容触摸与鼠标，不引入第三方库。
   ============================ */
let openCityCard = null;      // 当前左滑展开删除按钮的卡片
let cityOutsideBound = false;

function closeOpenCityCard() {
  if (!openCityCard) return;
  const front = openCityCard.querySelector('.city-item__front');
  if (front) {
    front.style.transition = '';
    front.style.transform = '';
  }
  openCityCard.classList.remove('city-item--swiped', 'city-item--swiping');
  const btn = openCityCard.querySelector('.city-item__remove');
  if (btn) btn.tabIndex = -1;
  openCityCard = null;
}

// 点击卡片以外的任意位置收回已展开的删除按钮（只需绑定一次）
function bindCityOutsideClose() {
  if (cityOutsideBound) return;
  cityOutsideBound = true;
  document.addEventListener('pointerdown', (e) => {
    if (!openCityCard) return;
    if (e.target.closest('.city-item') === openCityCard) return;
    closeOpenCityCard();
  }, true);
}

function setupCityCardGestures(item, cities, cityById) {
  bindCityOutsideClose();
  const front = item.querySelector('.city-item__front');
  const removeBtn = item.querySelector('.city-item__remove');
  if (!front) return;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const LONG_PRESS_MS = 400;   // 长按进入拖拽的判定时长
  const MOVE_CANCEL = 8;       // 超过该位移即判定为滑动而非长按

  let pointerId = null;
  let mode = null;             // 'press' | 'swipe' | 'drag'
  let startX = 0;
  let startY = 0;
  let lastDx = 0;
  let lastDy = 0;
  let pressTimer = null;
  let suppressClick = false;
  let step = 0;                // 相邻卡片纵向间距（含 gap）
  let fromIndex = 0;
  let target = 0;
  let dragItems = [];

  const removeWidth = () => (removeBtn ? removeBtn.offsetWidth : 72);
  const frontItems = () => $$('.city-item', elements.savedCities);

  const setFrontOffset = (px, animate) => {
    front.style.transition = animate && !reduceMotion ? `transform 220ms ${EASE}` : 'none';
    front.style.transform = px ? `translate3d(${px.toFixed(1)}px, 0, 0)` : '';
  };

  const clearTimer = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  const beginDrag = () => {
    pressTimer = null;
    if (mode !== 'press') return;
    mode = 'drag';
    suppressClick = true;
    closeOpenCityCard();
    dragItems = frontItems();
    fromIndex = dragItems.indexOf(item);
    target = fromIndex;
    const rects = dragItems.map((el) => el.getBoundingClientRect());
    step = rects.length > 1 ? rects[1].top - rects[0].top : 0;
    item.classList.add('city-item--dragging');
    document.body.classList.add('city-dragging');
    item.style.transition = 'none';
    // X12：抄起卡片的一刻放大 1.05 并加深阴影，给一次 10ms 短震
    if (!reduceMotion) item.style.transform = 'translate3d(0, 0, 0) scale(1.05)';
    if (navigator.vibrate) navigator.vibrate(10);
  };

  const layoutOthers = () => {
    dragItems.forEach((el, i) => {
      if (el === item) return;
      let t = 0;
      if (target > fromIndex && i > fromIndex && i <= target) t = -step;
      else if (target < fromIndex && i >= target && i < fromIndex) t = step;
      el.style.transition = reduceMotion ? 'none' : `transform 200ms ${EASE}`;
      el.style.transform = t ? `translate3d(0, ${t}px, 0)` : '';
    });
  };

  const dropDrag = () => {
    document.body.classList.remove('city-dragging');
    item.classList.remove('city-item--dragging');
    item.style.zIndex = '';
    const moved = target !== fromIndex;

    if (moved && step) {
      // DOM 重排：让其余卡片的让位位移正好等于重排后的落位，避免闪跳
      const ids = dragItems.map((el) => el.dataset.cityId);
      const [source] = ids.splice(fromIndex, 1);
      ids.splice(target, 0, source);
      ids.forEach((id) => {
        const el = dragItems.find((x) => x.dataset.cityId === id);
        if (el) elements.savedCities.appendChild(el);
      });
      const ordered = ids.map((id) => cityById(id)).filter(Boolean);
      if (ordered.length === cities.length) cityStore.reorder(ordered);
    }

    // 其余卡片：先落位（无过渡，直接清位移）；被拖卡片用残余位移平滑归位，
    // 并从 1.05 的放大态一起收回到原尺寸，落位过程因此没有跳变
    const residual = moved && step ? lastDy - (target - fromIndex) * step : lastDy;
    dragItems.forEach((el) => {
      el.style.transition = 'none';
      el.style.transform = el === item
        ? `translate3d(0, ${residual.toFixed(1)}px, 0) scale(1.05)`
        : '';
    });
    if (dragItems[0]) void dragItems[0].offsetHeight; // 强制 reflow，避免过渡被合并掉
    item.style.transition = reduceMotion ? 'none' : `transform 180ms ${EASE}`;
    item.style.transform = '';
    item.style.zIndex = '';
    setTimeout(() => { item.style.transition = ''; }, 220);
  };

  const finish = () => {
    clearTimer();
    if (pointerId != null && item.releasePointerCapture) {
      try { item.releasePointerCapture(pointerId); } catch { /* ignore */ }
    }
    pointerId = null;
    const m = mode;
    mode = null;

    if (m === 'swipe') {
      const w = removeWidth();
      const open = lastDx < -w / 2;
      setFrontOffset(open ? -w : 0, true);
      item.classList.remove('city-item--swiping');
      item.classList.toggle('city-item--swiped', open);
      if (removeBtn) removeBtn.tabIndex = open ? 0 : -1;
      openCityCard = open ? item : null;
    } else if (m === 'drag') {
      dropDrag();
    }

    // 滑动/拖拽后浏览器可能补一个 click，用一帧时间窗吞掉它，避免误切换城市
    if (suppressClick) setTimeout(() => { suppressClick = false; }, 0);
  };

  item.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('[data-action="remove-city"]')) return;
    if (pointerId != null) return;
    if (openCityCard && openCityCard !== item) closeOpenCityCard();
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    lastDx = 0;
    lastDy = 0;
    mode = 'press';
    suppressClick = false;
    try { item.setPointerCapture(pointerId); } catch { /* ignore */ }
    clearTimer();
    pressTimer = setTimeout(beginDrag, LONG_PRESS_MS);
  });

  item.addEventListener('pointermove', (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    lastDx = dx;
    lastDy = dy;

    if (mode === 'press') {
      if (Math.abs(dx) < MOVE_CANCEL && Math.abs(dy) < MOVE_CANCEL) return;
      clearTimer();
      if (Math.abs(dx) >= Math.abs(dy)) {
        mode = 'swipe';
        item.classList.add('city-item--swiping');
      } else {
        // 纵向滑动：交还页面滚动
        mode = null;
        return;
      }
    }

    if (mode === 'swipe') {
      const w = removeWidth();
      const base = item.classList.contains('city-item--swiped') ? -w : 0;
      let off = base + dx;
      off = Math.max(-w - 8, Math.min(0, off));
      setFrontOffset(off, false);
      if (e.cancelable) e.preventDefault();
      return;
    }

    if (mode === 'drag') {
      item.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0) scale(1.05)`;
      if (step) {
        const next = Math.min(dragItems.length - 1, Math.max(0, fromIndex + Math.round(dy / step)));
        if (next !== target) {
          target = next;
          layoutOthers();
          // 越过一张：极短一次 8ms 触觉，确认「位置换了」
          if (navigator.vibrate) navigator.vibrate(8);
        }
      }
      if (e.cancelable) e.preventDefault();
    }
  });

  item.addEventListener('pointerup', finish);
  item.addEventListener('pointercancel', finish);

  // touchmove 兜底：拖拽期间禁止页面纵向滚动（passive:false 才可 preventDefault）
  item.addEventListener('touchmove', (e) => {
    if (mode === 'drag' || mode === 'swipe') e.preventDefault();
  }, { passive: false });

  item.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="remove-city"]')) return;
    if (suppressClick) return;
    // 已展开删除按钮时，点卡片本体先收回
    if (item.classList.contains('city-item--swiped')) { closeOpenCityCard(); return; }
    const city = cityById(item.dataset.cityId);
    if (city) {
      state.currentCity = city;
      loadWeather(city);
      navigateTo('home');
    }
  });
}

/* ============================
   Pull to Refresh
   ============================ */
function setupPullToRefresh() {
  let startY = 0;
  let isPulling = false;
  let dragging = false;
  let pullDistance = 0;
  let ptrArmed = false;
  let refreshing = false;
  const main = $('.main');
  if (!main) return;

  // 下拉指示器挂到 body 上：fixed 定位，独立于 .main 的下拉位移，避免错位
  let ptrIndicator = $('.ptr-indicator');
  if (!ptrIndicator) {
    ptrIndicator = document.createElement('div');
    ptrIndicator.className = 'ptr-indicator';
    ptrIndicator.innerHTML = `
      <div class="ptr-indicator__spinner"></div>
      <div class="ptr-indicator__text">${t('ptr.refreshing')}</div>
    `;
    document.body.appendChild(ptrIndicator);
  }
  const ptrText = ptrIndicator.querySelector('.ptr-indicator__text');
  const setPtrText = (label) => {
    if (ptrText && ptrText.textContent !== label) ptrText.textContent = label;
  };

  // 阻尼参数：MAX_PULL 为最大下拉位移，THRESHOLD 为触发刷新的位移
  const MAX_PULL = 110;
  const THRESHOLD = 56;
  const PULL_EASE = 'transform 340ms cubic-bezier(0.22, 1, 0.36, 1)';
  let lastRefreshTime = 0;
  const MIN_REFRESH_INTERVAL = 2000; // 手动刷新最短间隔，仅用于防抖

  // 整页跟随手指下移，营造"拽动页面"的自然手感；松手后统一回弹
  // 归零时清空内联 transform（而不是留 translate3d(0,0,0)），
  // 否则会一直保持 containing block，影响 .main 内 fixed 子元素
  const setPullTransform = (distance, animate) => {
    main.style.transition = animate ? PULL_EASE : 'none';
    main.style.transform = distance > 0.5
      ? `translate3d(0, ${distance.toFixed(2)}px, 0)`
      : '';
  };

  const hidePtr = () => {
    ptrIndicator.classList.remove('ptr-indicator--visible', 'ptr-indicator--ready', 'ptr-indicator--armed');
  };

  // 手势位移先攒起来，每帧只提交一次（见 touchmove 里的说明）
  let pendingPull = 0;
  let ptrRaf = 0;
  const flushPull = () => {
    ptrRaf = 0;
    if (!isPulling || pendingPull <= 3) return;
    dragging = true;
    setPullTransform(pendingPull, false);
    if (!ptrIndicator.classList.contains('ptr-indicator--visible')) {
      ptrIndicator.classList.add('ptr-indicator--visible');
    }

    // 越阈值前提示"下拉刷新"，越阈值后提示"松手刷新"
    const ready = pendingPull >= THRESHOLD;
    ptrIndicator.classList.toggle('ptr-indicator--ready', ready);
    ptrIndicator.classList.toggle('ptr-indicator--armed', !ready);
    setPtrText(ready ? t('ptr.release') : t('ptr.pull'));

    // 刚好越过阈值的那一刻给一次轻微触觉反馈
    if (ready && !ptrArmed) {
      ptrArmed = true;
      if (navigator.vibrate) navigator.vibrate(6);
    } else if (!ready) {
      ptrArmed = false;
    }
  };

  main.addEventListener('touchstart', (e) => {
    if (refreshing || main.scrollTop > 0) return;
    if (ptrRaf) {
      cancelAnimationFrame(ptrRaf);
      ptrRaf = 0;
    }
    startY = e.touches[0].clientY;
    isPulling = true;
    dragging = false;
    pendingPull = 0;
    pullDistance = 0;
  }, { passive: true });

  main.addEventListener('touchmove', (e) => {
    if (!isPulling) return;
    const diff = e.touches[0].clientY - startY;
    // 上滑或已离开顶部：交还浏览器滚动，并把内容平滑收回
    if (diff <= 0 || main.scrollTop > 0) {
      if (dragging) {
        dragging = false;
        setPullTransform(0, true);
        hidePtr();
      }
      isPulling = false;
      return;
    }

    // 这里刻意不 preventDefault、监听也保持 passive：
    // 滚动容器上只要挂一个非 passive 的 touchmove，浏览器就无法把滚动交给合成线程，
    // 只能每帧等主线程跑完这个回调——120Hz 屏上直接把滚动拖到 40fps 上下。
    // 顶部下拉时容器本来已经滚到 0、无法继续滚动，不拦默认行为也不会有内容跟着动。
    // 非线性阻尼：越拉越沉，避免"一拉到底"的廉价感
    pullDistance = MAX_PULL * (1 - 1 / (diff / MAX_PULL + 1));
    // touchmove 在 120Hz 屏上一秒可触发 120 次，而 DOM 写入只要一次/帧就够；
    // 把多次移动合并到下一帧统一提交，避免同一帧重复排版掉帧。
    pendingPull = pullDistance;
    if (!ptrRaf) ptrRaf = requestAnimationFrame(flushPull);
  }, { passive: true });

  main.addEventListener('touchend', async () => {
    // 松手时先取消尚未提交的那一帧，避免把手势结束后的旧位移再写回 DOM
    if (ptrRaf) {
      cancelAnimationFrame(ptrRaf);
      ptrRaf = 0;
    }
    if (!isPulling) return;
    isPulling = false;
    ptrArmed = false;
    const triggered = dragging && pullDistance >= THRESHOLD;

    if (!triggered) {
      setPullTransform(0, true);
      hidePtr();
      dragging = false;
      pullDistance = 0;
      return;
    }

    const now = Date.now();
    if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
      // 距上次刷新过近：直接回弹，不做无意义的重复请求
      setPullTransform(0, true);
      hidePtr();
      dragging = false;
      pullDistance = 0;
      return;
    }

    lastRefreshTime = now;
    refreshing = true;
    if (navigator.vibrate) navigator.vibrate(12);
    ptrIndicator.classList.remove('ptr-indicator--ready', 'ptr-indicator--armed');
    ptrIndicator.classList.add('ptr-indicator--visible');
    setPtrText(t('ptr.refreshing'));
    // 内容停在略低处，给指示器留出空间，刷新完成后再一起收回
    setPullTransform(46, true);

    if (state.currentCity) {
      await loadWeather(state.currentCity, false, true);
    }

    setPullTransform(0, true);
    hidePtr();
    dragging = false;
    pullDistance = 0;
    refreshing = false;
  }, { passive: true });

  main.addEventListener('touchcancel', () => {
    isPulling = false;
    dragging = false;
    pullDistance = 0;
    ptrArmed = false;
    setPullTransform(0, true);
    hidePtr();
  }, { passive: true });
}

/* ============================
   Settings Bottom Sheet
   ============================ */
let sheetCloseTimer = null;

function openSettingsSheet() {
  if (!elements.settingsSheet) return;
  if (sheetCloseTimer) {
    clearTimeout(sheetCloseTimer);
    sheetCloseTimer = null;
  }
  elements.settingsSheet.hidden = false;
  // 触发 reflow 确保过渡动画生效
  void elements.settingsSheet.offsetWidth;
  elements.settingsSheet.classList.add('sheet-overlay--visible');
  // 弹窗隐藏时元素尺寸为 0，分段控件滑块需要在可见后重新对位
  themeControl?.__sync?.();
  unitControl?.__sync?.();
  // 额度会随使用变化，每次打开设置都重新取一次（登录用户读数据库、游客读代理快照）
  void refreshAccountUI();
}

function closeSettingsSheet() {
  if (!elements.settingsSheet) return;
  if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
  // 菜单已挂到 overlay 上，若开着就一并收起，否则下次打开设置会"自带"一个展开的列表
  langControl?.__close?.();
  elements.settingsSheet.classList.remove('sheet-overlay--visible');
  sheetCloseTimer = setTimeout(() => {
    elements.settingsSheet.hidden = true;
    sheetCloseTimer = null;
  }, 300);
}

/* 分段控件：滑块跟随选中项移动（用于主题、温度单位） */
function setupSegmented(rootId, current, onChange) {
  const root = document.getElementById(rootId);
  if (!root) return null;
  const opts = [...root.querySelectorAll('.segmented__opt')];
  const thumb = root.querySelector('.segmented__thumb');

  const sync = () => {
    const active = root.querySelector('.segmented__opt.is-active');
    if (!thumb || !active) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft}px)`;
  };

  const apply = (value) => {
    root.dataset.value = value;
    opts.forEach((o) => {
      const on = o.dataset.value === value;
      o.classList.toggle('is-active', on);
      o.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    sync();
  };

  opts.forEach((o) => {
    o.addEventListener('click', () => {
      if (o.dataset.value === root.dataset.value) return;
      apply(o.dataset.value);
      onChange(o.dataset.value);
    });
  });

  root.__sync = sync;
  apply(current);
  // 字体/语言变化会改变按钮宽度，重新对位滑块
  window.addEventListener('resize', sync);
  return root;
}

/* 自定义下拉：语言有 10 个选项，用弹出列表而非原生 select */
function setupLangDropdown(current, onChange) {
  const root = document.getElementById('lang-select');
  if (!root) return null;
  const trigger = root.querySelector('.dropdown__trigger');
  const valueEl = root.querySelector('.dropdown__value');
  const menu = root.querySelector('.dropdown__menu');
  const opts = [...root.querySelectorAll('.dropdown__opt')];

  // 菜单挂到 .sheet-overlay 之下：它原本在 .sheet__body 内，10 个选项会被滚动
  // 容器的 overflow 裁掉；.sheet 自身 overflow:hidden 也会裁。overlay 是 inset:0
  // 的固定层，既不滚动也不裁切，是唯一能完整容纳弹出列表的宿主。
  const host = root.closest('.sheet-overlay') || root;
  if (host !== root) host.appendChild(menu);

  const close = () => {
    menu.hidden = true;
    root.classList.remove('dropdown--open');
    trigger.setAttribute('aria-expanded', 'false');
  };

  // 相对 .sheet 计算位置，空间不足时自动向上弹出
  const position = () => {
    const hostRect = host.getBoundingClientRect();
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${rect.left - hostRect.left}px`;
    menu.style.width = `${rect.width}px`;
    // 宽度确定后再量高度，避免因换行导致的高估
    const menuH = menu.getBoundingClientRect().height || 240;
    const below = hostRect.bottom - rect.bottom - 8;
    const above = rect.top - hostRect.top - 8;
    if (below < menuH && above > below) {
      menu.style.top = 'auto';
      menu.style.bottom = `${hostRect.bottom - rect.top + 8}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${rect.bottom - hostRect.top + 8}px`;
    }
  };

  const open = () => {
    menu.hidden = false;
    root.classList.add('dropdown--open');
    trigger.setAttribute('aria-expanded', 'true');
    position();
    const active = opts.find((o) => o.dataset.value === root.dataset.value);
    active?.scrollIntoView({ block: 'nearest' });
  };

  const apply = (value) => {
    root.dataset.value = value;
    const active = opts.find((o) => o.dataset.value === value);
    opts.forEach((o) => o.setAttribute('aria-selected', o === active ? 'true' : 'false'));
    if (active && valueEl) valueEl.textContent = active.textContent.trim();
  };

  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });

  opts.forEach((o) => {
    o.addEventListener('click', () => {
      const value = o.dataset.value;
      close();
      if (value === root.dataset.value) return;
      apply(value);
      onChange(value);
    });
  });

  // 菜单已脱离 root，点击判断需要把菜单自身也算作"内部"
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !root.contains(e.target) && !menu.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });
  // 菜单固定在 .sheet 上，滚动表单会让它与触发按钮错位，直接收起
  root.closest('.sheet__body')?.addEventListener('scroll', () => {
    if (!menu.hidden) close();
  }, { passive: true });

  root.__apply = apply;
  root.__close = close;
  apply(current);
  return root;
}

let themeControl = null;
let unitControl = null;
let langControl = null;
let motionControl = null;

function setupSettingsSheet() {
  const clearCacheBtn = $('#clear-cache');
  const aboutVersion = $('#about-version');
  const sheetClose = $('#sheet-close');

  if (aboutVersion) aboutVersion.textContent = CONFIG.appVersion;

  const settings = settingsStore.get();

  themeControl = setupSegmented('theme-select', settings.theme, (value) => {
    settingsStore.set({ theme: value });
    applyTheme();
    showToast(t('settings.themeUpdated'));
  });

  unitControl = setupSegmented('unit-select', settings.unit, (value) => {
    settingsStore.set({ unit: value });
    // 功能11：单位换算纯粹是本地运算，用现有数据即时重渲染即可，无需重新联网
    rerenderDynamicContent();
    showToast(t('settings.unitUpdated'));
  });

  langControl = setupLangDropdown(getLanguage(), (value) => {
    if (setLanguage(value)) {
      // settingsStore.set 只接受对象：传 ('key', value) 会把字符串按字符展开写入
      settingsStore.set({ language: value });
      showToast(t('settings.languageUpdated'));
    }
  });

  motionControl = setupSegmented(
    'motion-select',
    localStorage.getItem(MOTION_KEY) === '1' ? 'reduced' : 'normal',
    (value) => {
      localStorage.setItem(MOTION_KEY, value === 'reduced' ? '1' : '0');
      applyMotionPreference();
      showToast(t('settings.motionUpdated'));
    },
  );

  clearCacheBtn?.addEventListener('click', async () => {
    await clearCache();
    showToast(t('settings.cacheCleared'));
  });

  setupSyncGroup();

  sheetClose?.addEventListener('click', closeSettingsSheet);

  // 点击遮罩关闭
  elements.settingsSheet?.addEventListener('click', (e) => {
    if (e.target === elements.settingsSheet) {
      closeSettingsSheet();
    }
  });

  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && elements.settingsSheet && !elements.settingsSheet.hidden) {
      closeSettingsSheet();
    }
  });

  renderChangelog();
}

/* ============================
   同步与备份（设置页）
   ============================ */

/**
 * 三端同步的入口都收在这里：
 *   - 同步码：本机生成一次，之后固定；用户把它抄到另外两端即可共用一份数据
 *   - 上传 / 恢复：走 Cloudflare Worker 的 /sync，只传城市、设置、牵挂名单
 *   - 导出 / 导入：本地 JSON 文件，APK 走系统分享，浏览器走下载
 * 恢复与导入之后整页重载：城市列表、主题、语言都可能在另一台设备上改过，
 * 逐块刷新比重载更容易漏掉状态。
 */
function setupSyncGroup() {
  const codeEl = $('#sync-code');
  const lastEl = $('#sync-last');
  const statusEl = $('#sync-status');
  const fileInput = $('#sync-import-file');
  if (!codeEl || !lastEl) return;

  const busyButtons = ['sync-upload', 'sync-download', 'sync-export', 'sync-import']
    .map((id) => $(`#${id}`))
    .filter(Boolean);

  const renderLast = () => {
    const at = lastSyncedAt();
    lastEl.textContent = at ? new Date(at).toLocaleString() : t('sync.never');
  };

  const setBusy = (busy) => {
    busyButtons.forEach((btn) => { btn.disabled = !!busy; });
  };

  const setStatus = (text) => {
    if (!statusEl) return;
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
  };

  codeEl.textContent = getSyncCode();
  renderLast();

  $('#sync-copy')?.addEventListener('click', async () => {
    const code = getSyncCode();
    try {
      await navigator.clipboard.writeText(code);
      showToast(t('sync.copied'));
    } catch (_) {
      showToast(t('sync.copyFail'));
    }
  });

  $('#sync-upload')?.addEventListener('click', async () => {
    setBusy(true);
    setStatus(t('sync.uploading'));
    try {
      await pushCloud();
      renderLast();
      showToast(t('sync.uploaded'));
    } catch (_) {
      showToast(t('sync.failed'));
    } finally {
      setBusy(false);
      setStatus('');
    }
  });

  $('#sync-download')?.addEventListener('click', async () => {
    if (!window.confirm(t('sync.confirmDownload'))) return;
    setBusy(true);
    setStatus(t('sync.downloading'));
    try {
      const result = await pullCloud();
      if (result.empty) {
        showToast(t('sync.empty'));
        return;
      }
      showToast(t('sync.downloaded'));
      setTimeout(() => location.reload(), 900);
    } catch (_) {
      showToast(t('sync.failed'));
    } finally {
      setBusy(false);
      setStatus('');
    }
  });

  $('#sync-export')?.addEventListener('click', () => {
    const result = exportBackup();
    showToast(result.ok ? t('sync.exported') : t('sync.failed'));
  });

  $('#sync-import')?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await importBackupFile(file);
      showToast(t('sync.imported'));
      setTimeout(() => location.reload(), 900);
    } catch (_) {
      showToast(t('sync.importFail'));
    } finally {
      fileInput.value = '';
    }
  });
}

/* ============================
   Changelog（更新记录时间线）
   ============================ */

/**
 * 版本更新记录。
 * 以后新增版本只需要在数组头部加一条：
 *   { version: '2.7.8', date: '2026-11-20', key: 'changelog.v278', kind: 'fix' }
 * 并在 i18n.js 里补上对应语言的文案数组即可。
 * 渲染器会自动套用「最新一版展开、旧版本折叠」的紧凑时间线，
 * 不再需要手写 HTML，也不会因为条目增加而撑高设置页。
 */
const CHANGELOG_RELEASES = [
  { version: '2.8.5', date: '2026-11-18', key: 'changelog.v285', kind: 'improve' },
  { version: '2.8.0', date: '2026-11-17', key: 'changelog.v280', kind: 'feature' },
  { version: '2.7.7', date: '2026-11-14', key: 'changelog.v277', kind: 'fix' },
  { version: '2.7.6', date: '2026-10-25', key: 'changelog.v276', kind: 'feature' },
  { version: '2.7.5', date: '2026-10-25', key: 'changelog.v275' },
  { version: '2.7.4', date: '2026-10-25', key: 'changelog.v274' },
  { version: '2.7.3', date: '2026-10-25', key: 'changelog.v273' },
  { version: '2.7.2', date: '2026-10-24', key: 'changelog.v272' },
  { version: '2.7.1', date: '2026-10-24', key: 'changelog.v271' },
  { version: '2.7.0', date: '2026-10-24', key: 'changelog.v270' },
  { version: '2.6.0', date: '2026-10-23', key: 'changelog.v260' },
  { version: '2.5.0', date: '2026-10-17', key: 'changelog.v250' },
  { version: '2.4.1', date: '', key: 'changelog.v241' },
  { version: '2.4.0', date: '', key: 'changelog.v240' },
  { version: '2.3.2', date: '', key: 'changelog.v232' },
  { version: '2.3.1', date: '', key: 'changelog.v231' },
  { version: '2.3.0', date: '', key: 'changelog.v230' },
  { version: '2.2.0', date: '', key: 'changelog.v220' },
  { version: '2.1.1', date: '', key: 'changelog.v211' },
  { version: '2.1.0', date: '', key: 'changelog.v210' },
  { version: '2.0.0', date: '', key: 'changelog.v200' },
];

const CHANGELOG_KIND_LABEL = {
  fix: 'settings.changelogFix',
  feature: 'settings.changelogFeature',
  improve: 'settings.changelogImprove',
};

/** 生成一条版本记录：折叠行 / 最新卡片共用同一套结构，保证视觉一致 */
function buildChangelogItem(release, isLatest) {
  const item = document.createElement('details');
  item.className = isLatest ? 'changelog__item changelog__item--latest' : 'changelog__item';
  item.open = isLatest;

  const summary = document.createElement('summary');

  const version = document.createElement('span');
  version.className = 'changelog__ver';
  version.textContent = `v${release.version}`;
  summary.appendChild(version);

  const kindLabel = CHANGELOG_KIND_LABEL[release.kind];
  if (kindLabel) {
    const tag = document.createElement('span');
    tag.className = `changelog__tag changelog__tag--${release.kind}`;
    tag.textContent = t(kindLabel);
    summary.appendChild(tag);
  }

  const spacer = document.createElement('span');
  spacer.className = 'changelog__spacer';
  summary.appendChild(spacer);

  if (release.date) {
    const date = document.createElement('span');
    date.className = 'changelog__date';
    date.textContent = release.date;
    summary.appendChild(date);
  }

  const chevron = document.createElement('i');
  chevron.className = 'changelog__chevron';
  summary.appendChild(chevron);

  item.appendChild(summary);

  const list = document.createElement('ul');
  list.className = 'sheet__changelog-list';
  const items = t(release.key);
  (Array.isArray(items) ? items : []).forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  });
  item.appendChild(list);

  return item;
}

function renderChangelog() {
  const latestHost = $('#changelog-latest');
  const historyHost = $('#changelog-history-list');
  if (!latestHost || !historyHost || !CHANGELOG_RELEASES.length) return;

  const current = $('#changelog-current');
  if (current) current.textContent = `v${CHANGELOG_RELEASES[0].version}`;

  latestHost.replaceChildren(buildChangelogItem(CHANGELOG_RELEASES[0], true));
  historyHost.replaceChildren(
    ...CHANGELOG_RELEASES.slice(1).map((release) => buildChangelogItem(release, false)),
  );

  const count = $('#changelog-history-count');
  if (count) count.textContent = `· ${Math.max(CHANGELOG_RELEASES.length - 1, 0)}`;
}

/* ============================
   Error Retry
   ============================ */
function setupErrorRetry() {
  elements.errorRetryBtn?.addEventListener('click', async () => {
    hideErrorRetry();
    if (state.currentCity) {
      await loadWeather(state.currentCity, true);
    } else {
      await locateAndLoad();
    }
  });
}

function showErrorRetry(message) {
  if (!elements.errorRetry) return;
  if (elements.errorRetryMsg) elements.errorRetryMsg.textContent = message || t('error.title');
  elements.errorRetry.hidden = false;
  void elements.errorRetry.offsetWidth;
  elements.errorRetry.style.opacity = '1';
}

function hideErrorRetry() {
  if (!elements.errorRetry) return;
  elements.errorRetry.style.opacity = '0';
  setTimeout(() => {
    elements.errorRetry.hidden = true;
  }, 300);
}

function applyI18nToDOM() {
  // 文本内容
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const type = el.getAttribute('data-i18n-type');
    if (type === 'array') {
      const items = t(key);
      if (Array.isArray(items)) {
        el.innerHTML = items.map((item) => `<li>${item}</li>`).join('');
      }
    } else {
      el.textContent = t(key);
    }
  });

  // placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });

  // aria-label
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });

  // title
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });

  // 分段控件的文字由 data-i18n 处理；语言变化后按钮宽度会变，需重新对位滑块
  themeControl?.__sync?.();
  unitControl?.__sync?.();
  langControl?.__apply?.(getLanguage());
}

/* ============================================================
   Feature Pack v2.2.0
   发现页工具（30 天日历 / 日月轨迹 / 空气榜 / 天气对比 / 生活建议 / 小组件）
   + 首页增强（极限提醒 / 场景配色 / 保鲜度角标 / 手势）
   + 首启引导 + 安卓双击返回退出
   ============================================================ */

/* ---- 通用：极简线性空态插画（功能14） ---- */
const ART_PATHS = {
  cloud: '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path><path d="M16 17h5"></path>',
  offline: '<line x1="1" y1="1" x2="23" y2="23"></line><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path><path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line>',
  map: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2.5"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>',
};

/* X10：空态插画随当前天气变化 —— 同一套线性图标，只换动作。
   全部走 transform / opacity，停掉旋转时也不会留下错位。 */
function currentSceneKind() {
  const text = String(state.weather?.realtime?.text || '').toLowerCase();
  if (/雪|snow|sleet/.test(text)) return 'snow';
  if (/雨|rain|drizzle|shower|thunder|storm|雷/.test(text)) return 'rain';
  if (/雾|霾|fog|haze|mist/.test(text)) return 'fog';
  if (/晴|sun|clear/.test(text)) return 'sun';
  return 'cloud';
}

function stateArtHTML(title, desc, art = 'cloud') {
  return `
    <div class="state-art" data-wx="${currentSceneKind()}">
      <div class="state-art__svg">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${ART_PATHS[art] || ART_PATHS.cloud}</svg>
      </div>
      ${title ? `<div class="state-art__title">${title}</div>` : ''}
      ${desc ? `<div class="state-art__desc">${desc}</div>` : ''}
    </div>
  `;
}

function toolSkeletonHTML(lines = 5) {
  const rows = Array.from({ length: lines }, (_, i) => `
    <div class="skeleton" style="height:0.875rem;width:${i % 2 ? 72 : 100}%;border-radius:var(--radius-sm)"></div>
  `).join('');
  return `<div class="card" style="display:flex;flex-direction:column;gap:var(--space-3)">${rows}</div>`;
}

/* ---- 功能13：数据"保鲜度"角标 ---- */
/* 把角标挂到三张主卡片的标题行末尾（只创建一次，之后仅更新文本与样式） */
function ensureFreshBadge(sectionEl) {
  if (!sectionEl) return null;
  const title = sectionEl.querySelector('.card__title');
  if (!title) return null;
  let badge = title.querySelector('.fresh');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'fresh';
    title.appendChild(badge);
  }
  return badge;
}

function renderFreshness(data) {
  const at = data?.fetchedAt || 0;
  const offline = navigator.onLine === false;
  let label = t('fresh.cached');
  let live = false;

  if (offline && at) {
    // 离线时最有价值的信息不是「多久以前」，而是「这份数据是什么时候的」
    const d = new Date(at);
    label = t('fresh.offline', `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  } else if (at) {
    const min = Math.floor((Date.now() - at) / 60000);
    if (min < 1) {
      label = t('fresh.live');
      live = true;
    } else if (min < 60) {
      label = t('fresh.minutes', min);
    } else {
      label = t('fresh.hours', Math.floor(min / 60));
    }
  }

  [elements.hourlySection, elements.dailySection, elements.aqiSection].forEach((section) => {
    const badge = ensureFreshBadge(section);
    if (!badge) return;
    badge.textContent = label;
    badge.classList.toggle('fresh--live', live);
    badge.classList.toggle('fresh--offline', offline);
  });
}

// 网络状态切换时不用重新请求，光把角标改成离线/在线态即可
window.addEventListener('offline', () => {
  if (state.weather) renderFreshness(state.weather);
});
window.addEventListener('online', () => {
  if (state.weather) renderFreshness(state.weather);
});

/* ---- 功能11：场景强调色（随天气场景联动） ---- */

/* 只用和风的数字 icon 编码判断，不依赖会被翻译的 text 字段 */
function sceneKeyOf(data) {
  const code = parseInt(data?.realtime?.icon, 10);
  const isDay = isDaytime(data?.astronomy);
  if (Number.isFinite(code)) {
    if (code >= 302 && code <= 304) return 'thunder';
    if (code >= 300 && code <= 399) return 'rainy';
    if (code >= 400 && code <= 499) return 'snowy';
    if (code >= 500 && code <= 515) return 'foggy';
    if (code === 104 || code === 152 || (code >= 101 && code <= 103) || code === 151 || code === 153) return 'cloudy';
  }
  return isDay ? 'sunny' : 'night';
}

function applySceneAccent(data) {
  document.documentElement.setAttribute('data-scene', sceneKeyOf(data));
}

/* ---- 功能8：极限天气 / 灾害预警提醒条（吸顶常驻，可展开） ---- */
const ALERT_DANGER_COLORS = ['orange', 'red'];
let alertExpanded = false;

function renderAlertBar(data) {
  const el = elements.alertBar;
  if (!el) return;
  alertExpanded = false;
  bindAlertBar();

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const d0 = data?.daily?.[0] || {};
  const d1 = data?.daily?.[1] || {};
  const rt = data?.realtime || {};
  const alerts = [];

  const tMax = parseFloat(d0.tempMax);
  if (Number.isFinite(tMax) && tMax >= 35) {
    alerts.push({ sev: tMax >= 37 ? 'danger' : 'warn', text: t('alert.heat', `${Math.round(tMax)}°`) });
  }

  const drop = Number.isFinite(tMax) ? tMax - parseFloat(d1.tempMax) : NaN;
  if (Number.isFinite(drop) && drop >= 8) {
    alerts.push({ sev: drop >= 12 ? 'danger' : 'warn', text: t('alert.cold', `${Math.round(drop)}°`) });
  }

  const windScale = parseFloat(rt.windScale);
  if (Number.isFinite(windScale) && windScale >= 7) {
    alerts.push({ sev: windScale >= 9 ? 'danger' : 'warn', text: t('alert.wind', Math.round(windScale)) });
  }

  const uv = parseFloat(d0.uvIndex);
  if (Number.isFinite(uv) && uv >= 8) {
    alerts.push({ sev: 'warn', text: t('alert.uv', Math.round(uv)) });
  }

  const maxPop = Math.max(0, ...(data?.hourly || []).slice(0, 12).map((h) => parseFloat(h.pop) || 0));
  const precip = parseFloat(d0.precip) || 0;
  if (maxPop >= 80 && precip >= 4) {
    alerts.push({ sev: 'warn', text: t('alert.rain', `${precip}mm`) });
  }

  // 灾害/极端天气官方预警优先呈现：橙色及以上升级为 danger 强调色
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  if (warnings.length > 0) {
    const topSeverity = warnings
      .map(warningSeverity)
      .reduce((a, b) => (SEVERITY_ORDER[b] > SEVERITY_ORDER[a] ? b : a), 'blue');
    const head = warnings[0] || {};
    const title = String(head.title || '').trim();
    alerts.push({
      sev: ALERT_DANGER_COLORS.includes(topSeverity) ? 'danger' : 'warn',
      weight: 2,
      text: title || t('alert.warning', warnings.length),
      detail: String(head.text || '').trim()
        || warnings.slice(1).map((w) => String(w?.title || '').trim()).filter(Boolean).join(' · '),
    });
  }

  if (alerts.length === 0) {
    el.hidden = true;
    el.className = 'alert-bar';
    el.innerHTML = '';
    el.closest('.page')?.classList.remove('page--alert');
    return;
  }

  // 灾害预警权重最高；同级只呈现最严重的一条，单行信息比堆叠更易读
  alerts.sort((a, b) => ((b.weight || 1) - (a.weight || 1))
    || (a.sev === b.sev ? 0 : a.sev === 'danger' ? -1 : 1));
  const top = alerts[0];
  const detail = top.detail || '';

  el.className = `alert-bar alert-bar--${top.sev}`;
  // 提醒条出现时会占据 hero 上方的高度：给页面打标记，让 hero 取消
  // 「抵消 .main 顶栏内边距」的负外边距（靠相邻选择器不可靠，
  // 场景节点可能被插到两者之间，这里用类名保证一定生效）
  el.closest('.page')?.classList.add('page--alert');
  el.innerHTML = `
    <span class="alert-bar__icon">${svgIcon('alertCircle').outerHTML}</span>
    <span class="alert-bar__body">
      <span class="alert-bar__text" title="${esc(top.text)}">${esc(top.text)}</span>
      ${detail ? `<span class="alert-bar__detail" hidden title="${esc(detail)}">${esc(detail)}</span>` : ''}
    </span>
    ${detail ? '<svg class="alert-bar__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>' : ''}
    ${detail ? `<button type="button" class="alert-bar__copy" hidden>${t('warning.copy')}</button>` : ''}
  `;
  el.hidden = false;
  el.setAttribute('aria-expanded', 'false');
  el.removeAttribute('title');
  if (detail) {
    el.setAttribute('title', t('warning.hint'));
    el.tabIndex = 0;
  } else {
    el.removeAttribute('tabindex');
  }
}

// 提醒条的展开/收起只绑定一次：#alert-bar 是稳定元素，避免每次渲染重复挂载
function bindAlertBar() {
  const el = elements.alertBar;
  if (!el || el.dataset.bound === '1') return;
  el.dataset.bound = '1';
  el.setAttribute('role', 'button');
  el.setAttribute('aria-live', 'polite');

  const toggle = () => {
    const detail = el.querySelector('.alert-bar__detail');
    if (!detail) return;
    alertExpanded = !alertExpanded;
    detail.hidden = !alertExpanded;
    const copy = el.querySelector('.alert-bar__copy');
    if (copy) copy.hidden = !alertExpanded;
    el.classList.toggle('alert-bar--expanded', alertExpanded);
    el.setAttribute('aria-expanded', alertExpanded ? 'true' : 'false');
    // 展开同时把下方预警详情卡滚入视野（存在时）
    if (alertExpanded) {
      const card = elements.warningSection;
      if (card && !card.hidden && card.childElementCount > 0) {
        card.scrollIntoView({
          behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    }
  };

  // 复制预警全文：展开后才有意义，所以按钮默认隐藏，随详情一起出现
  el.addEventListener('click', async (e) => {
    const copy = e.target.closest('.alert-bar__copy');
    if (!copy) return;
    e.stopPropagation();
    const detail = el.querySelector('.alert-bar__detail');
    const title = el.querySelector('.alert-bar__text');
    const text = [title?.textContent, detail?.textContent].filter(Boolean).join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('warning.copied'));
      if (navigator.vibrate) navigator.vibrate(6);
    } catch (_) {
      showToast(t('warning.copyFailed'));
    }
  });

  el.addEventListener('click', toggle);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
}

/* ---- 功能4：天气对比 · 本地历史快照（今日 vs 昨日 / 本周 vs 上周） ---- */
const HISTORY_KEY = 'apexon_daily_history';
const HISTORY_MAX = 60;

function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function snapshotFrom(data) {
  const d0 = data?.daily?.[0] || {};
  const rt = data?.realtime || {};
  const tMax = parseFloat(d0.tempMax);
  const tMin = parseFloat(d0.tempMin);
  const avg = Number.isFinite(tMax) && Number.isFinite(tMin) ? (tMax + tMin) / 2 : null;
  const aqi = parseFloat(data?.airQuality?.aqi);
  const hum = parseFloat(rt.humidity);
  const wind = parseFloat(rt.windSpeed);
  return {
    d: dayKey(),
    avg,
    aqi: Number.isFinite(aqi) ? aqi : null,
    hum: Number.isFinite(hum) ? hum : null,
    wind: Number.isFinite(wind) ? wind : null,
  };
}

function readHistory() {
  const list = storage.get(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

function recordHistorySnapshot(data) {
  if (!data?.realtime) return;
  const snap = snapshotFrom(data);
  const list = readHistory().filter((e) => e?.d !== snap.d);
  list.push(snap);
  list.sort((a, b) => (a.d < b.d ? -1 : 1));
  storage.set(HISTORY_KEY, list.slice(-HISTORY_MAX));
}

/* ---- 城市快照：给「双城通勤对照」提供无需额外请求的数据 ---- */
const CITY_SNAPSHOT_KEY = 'apexon_city_snapshots';

function recordCitySnapshot(city, data) {
  if (!city?.id || !data?.realtime) return;
  const temp = parseFloat(data.realtime.temp);
  if (!Number.isFinite(temp)) return;

  const list = storage.get(CITY_SNAPSHOT_KEY, []);
  const arr = Array.isArray(list)
    ? list.filter((e) => String(e?.id) !== String(city.id)) : [];
  arr.push({
    id: city.id,
    name: city.name || data.location?.name || '',
    temp,
    text: data.realtime.text || '',
    icon: data.realtime.icon || '',
    at: Date.now(),
  });
  storage.set(CITY_SNAPSHOT_KEY, arr.slice(-12));
}

function readCitySnapshots() {
  const list = storage.get(CITY_SNAPSHOT_KEY, []);
  return Array.isArray(list) ? list : [];
}

function averageOf(list, key) {
  const vals = list.map((e) => e?.[key]).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/* ---- 今天最佳出门时段 ---- */
/* 逐小时打分：温度舒适区 + 降水概率 + 风速 + 湿度，四项都是"出门会不会难受"的直接因素。
   纯本地四则运算，不额外请求接口，也不是任何形式的文案生成。 */
function outingScore(item) {
  const temp = parseFloat(item.temp);
  const pop = parseInt(item.pop, 10) || 0;
  const wind = parseFloat(item.windSpeed) || 0;
  const humidity = parseFloat(item.humidity) || 55;

  let score = 100;
  if (Number.isFinite(temp)) score -= Math.abs(temp - 22) * 2.4;
  score -= pop * 0.7;
  score -= Math.max(0, wind - 12) * 1.1;
  score -= Math.max(0, humidity - 75) * 0.5;
  score -= Math.max(0, 40 - humidity) * 0.3;
  return score;
}

function renderOuting(hourly) {
  const el = elements.outingBody;
  if (!el) return;

  const hours = (hourly || []).slice(0, 12);
  if (hours.length < 3) {
    el.innerHTML = `<p class="outing__hint">${t('outing.none')}</p>`;
    return;
  }

  const scores = hours.map(outingScore);
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < hours.length - 1; i += 1) {
    const avg = (scores[i] + scores[i + 1]) / 2;
    if (avg > bestScore) {
      bestScore = avg;
      bestIndex = i;
    }
  }

  const start = hours[bestIndex];
  const end = hours[Math.min(bestIndex + 1, hours.length - 1)];
  // 结束时间取后一格的「起点 + 1 小时」，这样展示的是真正的两小时区间
  const endAt = new Date(end.fxTime);
  if (!Number.isNaN(endAt.getTime())) endAt.setHours(endAt.getHours() + 1);

  const startPop = parseInt(start.pop, 10) || 0;
  const endPop = parseInt(end.pop, 10) || 0;
  const avgPop = Math.round((startPop + endPop) / 2);
  const avgWind = Math.round((parseFloat(start.windSpeed) || 0));
  const verdict = bestScore >= 80 ? t('outing.great') : bestScore >= 60 ? t('outing.ok') : t('outing.poor');
  const tone = bestScore >= 80 ? 'great' : bestScore >= 60 ? 'ok' : 'poor';

  el.innerHTML = `
    <div class="outing__window">
      <span class="outing__time">${formatHour(start.fxTime)} – ${formatHour(endAt)}</span>
      <span class="outing__verdict outing__verdict--${tone}">${verdict}</span>
    </div>
    <div class="outing__chips">
      <span class="outing__chip">${displayTemp(start.temp)}</span>
      <span class="outing__chip">${t('outing.rainChip', avgPop)}</span>
      <span class="outing__chip">${t('outing.windChip', avgWind)}</span>
    </div>
    <p class="outing__note">${t('outing.note')}</p>
  `;
}

/* ---- 天气日记 ---- */
const DIARY_KEY = 'apexon_diary_v1';
const DIARY_LIMIT = 400;

function readDiary() {
  const raw = storage.get(DIARY_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/** 每次拿到新数据后落一条当天记录；同一天同一城市只保留最后一次，避免反复刷新刷出重复条目。 */
function saveDiaryEntry(data) {
  const { location, daily, airQuality } = data || {};
  const today = daily?.[0];
  if (!location || !today?.fxDate) return;

  const entries = readDiary();
  const key = `${today.fxDate}|${location.id || location.name || ''}`;
  const aqiNumber = Number(airQuality?.aqi);
  entries[key] = {
    date: today.fxDate,
    city: location.name || '',
    hi: parseFloat(today.tempMax),
    lo: parseFloat(today.tempMin),
    text: today.textDay || '',
    icon: today.iconDay || '',
    aqi: Number.isFinite(aqiNumber) ? aqiNumber : null,
    savedAt: Date.now(),
  };

  // 只留最近 400 条：一年多的量足够回顾，也不会把 localStorage 撑爆
  const keys = Object.keys(entries).sort().slice(-DIARY_LIMIT);
  const trimmed = {};
  keys.forEach((k) => { trimmed[k] = entries[k]; });
  storage.set(DIARY_KEY, trimmed);
}

function diaryMonthStats(entries) {
  const days = entries.filter((e) => Number.isFinite(e.hi) && Number.isFinite(e.lo));
  if (!days.length) return null;
  const avg = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const rainy = entries.filter((e) => /雨|雪|雷/.test(e.text) || /^3|^4/.test(String(e.icon))).length;
  const warmest = entries.reduce((a, b) => (b.hi > a.hi ? b : a), entries[0]);
  const coldest = entries.reduce((a, b) => (b.lo < a.lo ? b : a), entries[0]);
  return {
    count: entries.length,
    avgHi: avg(days.map((e) => e.hi)),
    avgLo: avg(days.map((e) => e.lo)),
    rainy,
    warmest,
    coldest,
  };
}

function renderDiaryTool() {
  const body = elements.toolBody;
  if (!body) return;

  const entries = Object.values(readDiary())
    .filter((e) => e && e.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  if (!entries.length) {
    body.innerHTML = stateArtHTML(t('diary.empty'), t('diary.emptyDesc'), 'diary');
    return;
  }

  const month = new Date().toISOString().slice(0, 7);
  const monthEntries = entries.filter((e) => String(e.date).startsWith(month));
  const stats = diaryMonthStats(monthEntries);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const statsHTML = stats ? `
    <div class="diary__stats">
      <div class="diary__stat"><span>${t('diary.days')}</span><strong>${stats.count}</strong></div>
      <div class="diary__stat"><span>${t('diary.avgHigh')}</span><strong>${displayTemp(stats.avgHi)}</strong></div>
      <div class="diary__stat"><span>${t('diary.avgLow')}</span><strong>${displayTemp(stats.avgLo)}</strong></div>
      <div class="diary__stat"><span>${t('diary.rainy')}</span><strong>${stats.rainy}</strong></div>
    </div>
    <div class="diary__polar">
      <span>${t('diary.warmest')} ${esc(stats.warmest.date)} · ${displayTemp(stats.warmest.hi)}</span>
      <span>${t('diary.coldest')} ${esc(stats.coldest.date)} · ${displayTemp(stats.coldest.lo)}</span>
    </div>
  ` : `<p class="diary__hint">${t('diary.emptyMonth')}</p>`;

  const rows = entries.slice(0, 30).map((e) => `
    <div class="diary__row">
      <span class="diary__date">${esc(String(e.date).slice(5))}</span>
      <i class="diary__icon qi-${esc(e.icon || '100')}" aria-hidden="true"></i>
      <span class="diary__city">${esc(e.city)}</span>
      <span class="diary__text">${esc(e.text)}</span>
      <span class="diary__temp">${displayTemp(e.hi)} / ${displayTemp(e.lo)}</span>
    </div>
  `).join('');

  body.innerHTML = `
    <section class="tool__section">
      <h2 class="tool__h2">${t('diary.monthTitle')}</h2>
      ${statsHTML}
    </section>
    <section class="tool__section">
      <h2 class="tool__h2">${t('diary.recent')}</h2>
      <div class="diary__list">${rows}</div>
    </section>
    <p class="tool__hint">${t('diary.localNote')}</p>
  `;
}

/* ---- 城市对比 ---- */
async function renderCityCompareTool() {
  const reqId = toolRequestId;
  const body = elements.toolBody;
  if (!body) return;

  const cities = cityStore.getAll().slice(0, 2);
  if (cities.length < 2) {
    body.innerHTML = stateArtHTML(t('citycompare.empty'), t('citycompare.emptyDesc'), 'citycompare');
    return;
  }

  const load = (city) => {
    // 当前城市直接复用首屏已经取到的整包数据，少打一整轮接口
    if (state.weather && state.currentCity && String(state.currentCity.id) === String(city.id)) {
      return Promise.resolve(state.weather);
    }
    return fetchWeatherBundle(city).catch(() => null);
  };

  const [a, b] = await Promise.all(cities.map(load));
  if (reqId !== toolRequestId) return;
  if (!a || !b) {
    body.innerHTML = stateArtHTML(t('common.noData'), t('citycompare.failed'), 'citycompare');
    return;
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const column = (w) => {
    const real = w.realtime || {};
    const today = w.daily?.[0] || {};
    const aqi = w.airQuality?.aqi;
    const category = w.airQuality?.category || '';
    const days = (w.daily || []).slice(1, 4).map((d) => `
      <div class="cmp__day">
        <span class="cmp__day-label">${formatDate(d.fxDate, { weekday: 'short', day: false })}</span>
        <i class="cmp__day-icon qi-${esc(d.iconDay || '100')}" aria-hidden="true"></i>
        <span class="cmp__day-temp">${displayTemp(d.tempMax)} / ${displayTemp(d.tempMin)}</span>
      </div>`).join('');
    return `
      <div class="cmp__col">
        <div class="cmp__city">${esc(w.location?.name || '')}</div>
        <div class="cmp__temp">${displayTemp(real.temp)}</div>
        <div class="cmp__text">${esc(real.text || '')}</div>
        <div class="cmp__range">↑ ${displayTemp(today.tempMax)} · ↓ ${displayTemp(today.tempMin)}</div>
        <div class="cmp__aqi">
          <span class="cmp__aqi-label">AQI</span>
          <strong class="cmp__aqi-value">${aqi === undefined || aqi === null ? '--' : esc(aqi)}</strong>
          <span class="cmp__aqi-cat">${esc(category)}</span>
        </div>
        <div class="cmp__days">${days}</div>
      </div>`;
  };

  const diff = (parseFloat(a.realtime?.temp) || 0) - (parseFloat(b.realtime?.temp) || 0);
  const note = Math.abs(diff) < 0.5
    ? t('cities.compareSame')
    : diff > 0
      ? t('cities.compareWarmer', a.location?.name || '', b.location?.name || '', Math.round(Math.abs(diff)))
      : t('cities.compareColder', a.location?.name || '', b.location?.name || '', Math.round(Math.abs(diff)));

  body.innerHTML = `
    <div class="cmp">
      ${column(a)}
      <div class="cmp__split" aria-hidden="true">Δ ${Math.round(Math.abs(diff))}°</div>
      ${column(b)}
    </div>
    <p class="cmp__note">${esc(note)}</p>
    <p class="tool__hint">${t('citycompare.hint')}</p>
  `;
}

/* ---- 发现页入口 ---- */
function setupDiscover() {
  // 发现页的卡片全部由 blueprint.js 在运行时生成（分区布局），
  // 因此这里必须用事件委托，否则新卡片永远拿不到点击。
  const page = $('#page-discover');
  page?.addEventListener('click', (e) => {
    const card = e.target.closest('.disc-card[data-tool], .disc-hero__card[data-tool]');
    if (!card) return;
    const id = card.dataset.tool;
    // 天空窗口不是工具子页，交给 blueprint 的委托处理
    if (id === 'sky') return;
    if (navigator.vibrate) navigator.vibrate(8);
    openTool(id);
  });

  elements.toolBack?.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(8);
    navigateTo('discover');
  });
}

function openTool(id) {
  if (!id) return;
  state.currentTool = id;
  toolRequestId += 1; // 作废上一个工具的异步结果
  if (elements.toolTitle) {
    elements.toolTitle.textContent = t(`discover.${id}`);
    elements.toolTitle.title = t(`discover.${id}`);
  }
  if (elements.toolBody) elements.toolBody.innerHTML = toolSkeletonHTML();
  navigateTo('tool');
}

function renderToolPage() {
  const id = state.currentTool || 'calendar';
  if (elements.toolTitle) {
    elements.toolTitle.textContent = t(`discover.${id}`);
    elements.toolTitle.title = t(`discover.${id}`);
  }
  if (!elements.toolBody) return;

  // 蓝图新增的工具（牵挂 / 牵手 / 写给未来 / 色卡 / 约定 / 气候小结）
  if (renderBlueprintTool(id)) return;

  switch (id) {
    case 'sunmoon': renderSunmoonTool(); break;
    case 'compare': renderCompareTool(); break;
    case 'life': renderLifeTool(); break;
    case 'widget': renderWidgetTool(); break;
    case 'sharecard': renderShareCardTool(); break;
    case 'aqimap': renderAqimapTool(); break;
    case 'citycompare': renderCityCompareTool(); break;
    case 'diary': renderDiaryTool(); break;
    default: renderCalendarTool();
  }
}

/* ---- 工具①：30 天天气日历（功能1） ---- */
async function ensureDaily30() {
  const city = state.currentCity;
  if (!city?.id) return null;
  if (state.daily30 && String(state.daily30.cityId) === String(city.id)) {
    return state.daily30.days;
  }
  const days = await getDailyForecast(city.id, 30);
  state.daily30 = { cityId: city.id, days };
  return days;
}

async function renderCalendarTool() {
  const reqId = toolRequestId;
  const body = elements.toolBody;
  if (!body) return;

  if (!state.currentCity) {
    body.innerHTML = stateArtHTML(t('common.noData'), t('empty.gettingLocation'), 'calendar');
    return;
  }

  let days;
  try {
    days = await ensureDaily30();
  } catch (err) {
    if (reqId !== toolRequestId) return;
    console.warn('[APEXON] 30 天预报获取失败:', err);
    body.innerHTML = stateArtHTML(t('error.title'), t('error.network'), 'offline');
    return;
  }
  if (reqId !== toolRequestId) return;
  if (!Array.isArray(days) || days.length === 0) {
    body.innerHTML = stateArtHTML(t('common.noData'), '', 'calendar');
    return;
  }

  // 周标题：用一个已知周日为锚点，按当前语言取短周名
  const weekdays = ['2024-01-07', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13']
    .map((d) => formatDate(d, { weekday: 'short', day: false }));

  const today = new Date();
  const offset = today.getDay(); // 周日为一周起点，与周标题一致
  const cells = Array.from({ length: offset }, () => '<div class="cal__cell cal__cell--empty"></div>');

  let prevMonth = today.getMonth();
  const dayCells = days.map((item, index) => {
    const date = new Date(String(item.fxDate).replace(/-/g, '/'));
    const month = date.getMonth();
    const isMonthStart = month !== prevMonth;
    prevMonth = month;
    const dayLabel = isMonthStart ? `${month + 1}/${date.getDate()}` : `${date.getDate()}`;
    const icon = reconcileIcon(item.iconDay, item.textDay, true);
    return `
      <button type="button" class="cal__cell ${index === 0 ? 'cal__cell--today' : ''}" data-index="${index}" aria-label="${item.fxDate || ''}">
        <span class="cal__day">${dayLabel}</span>
        <span class="cal__icon qi-${icon}"></span>
        <span class="cal__temps">
          <span class="cal__tmax">${displayTemp(item.tempMax)}</span>
          <span class="cal__tmin">${displayTemp(item.tempMin)}</span>
        </span>
      </button>
    `;
  });

  body.innerHTML = `
    <div class="card cal">
      <div class="cal__weekdays">${weekdays.map((w) => `<span class="cal__weekday">${w}</span>`).join('')}</div>
      <div class="cal__grid">${cells.join('')}${dayCells.join('')}</div>
      <div class="cal__hint">${t('calendar.hint')}</div>
    </div>
  `;

  $$('.cal__cell[data-index]', body).forEach((cell) => {
    cell.addEventListener('click', () => {
      const day = days[Number(cell.dataset.index)];
      if (day) openDailyDetail(day);
    });
  });
}

/* ---- 工具②：日月轨迹（功能2） ---- */
function hmToMin(hm) {
  if (typeof hm !== 'string') return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function minToHm(min) {
  if (!Number.isFinite(min)) return '--';
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** 月相遮盖比例：0 = 满月（无阴影），1 = 新月（全暗）。纯日期推算，语言无关 */
function moonShadowRatio(date = new Date()) {
  const synodic = 29.530588853;
  const knownNew = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - knownNew) / 86400000;
  const frac = (((days / synodic) % 1) + 1) % 1; // 0 新月 → 0.5 满月
  return clamp((1 + Math.cos(2 * Math.PI * frac)) / 2, 0, 1);
}

function renderSunmoonTool() {
  const body = elements.toolBody;
  if (!body) return;

  const a = state.weather?.astronomy;
  const sr = hmToMin(a?.sunrise);
  const ss = hmToMin(a?.sunset);
  if (!Number.isFinite(sr) || !Number.isFinite(ss)) {
    body.innerHTML = stateArtHTML(t('common.noData'), t('sunmoon.title'), 'cloud');
    return;
  }

  const dayLength = Math.max(0, ss - sr);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const progress = clamp((nowMin - sr) / Math.max(ss - sr, 1), 0, 1);

  // 二次贝塞尔弧线（x:12→188, y:74→74，控制点 y=-18）
  const bez = (p0, p1, p2, tt) => (1 - tt) ** 2 * p0 + 2 * (1 - tt) * tt * p1 + tt ** 2 * p2;
  const sunX = bez(12, 100, 188, progress);
  const sunY = bez(74, -18, 74, progress);

  const phaseText = Array.isArray(a.moonPhase) ? a.moonPhase[0] : (a.moonPhase || '');
  const shadow = moonShadowRatio(now);

  const metrics = [
    { label: t('sunmoon.dayLength'), value: `${Math.floor(dayLength / 60)}h ${String(dayLength % 60).padStart(2, '0')}m` },
    { label: t('sunmoon.moonPhase'), value: phaseText || '--' },
    { label: t('sunmoon.moonrise'), value: a.moonrise || '--' },
    { label: t('sunmoon.moonset'), value: a.moonset || '--' },
  ];

  body.innerHTML = `
    <div class="card sunmoon__hero">
      <svg class="sunmoon__arc" viewBox="0 0 200 84" aria-hidden="true">
        <path d="M 12 74 Q 100 -18 188 74" fill="none" stroke="var(--hairline)" stroke-width="2"></path>
        <path d="M 12 74 Q 100 -18 188 74" fill="none" stroke="var(--scene-accent)" stroke-width="2"
              stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - progress).toFixed(3)}"></path>
        <circle cx="12" cy="74" r="3" fill="var(--text-tertiary)"></circle>
        <circle cx="188" cy="74" r="3" fill="var(--text-tertiary)"></circle>
        <circle cx="${sunX.toFixed(2)}" cy="${sunY.toFixed(2)}" r="6" fill="var(--scene-accent)"></circle>
      </svg>
      <div class="sunmoon__moon">
        <div class="sunmoon__moon-disc" style="--shift:${shadow.toFixed(3)}"></div>
      </div>
      <div class="sunmoon__phase-name">${a.sunrise} → ${a.sunset}</div>
    </div>
    <div class="sunmoon__metrics">
      ${metrics.map((m) => `
        <div class="sunmoon__metric">
          <span class="sunmoon__metric-label">${m.label}</span>
          <span class="sunmoon__metric-value">${m.value}</span>
        </div>
      `).join('')}
      <div class="sunmoon__metric" style="grid-column:1 / -1">
        <span class="sunmoon__metric-label">${t('sunmoon.goldenHour')}</span>
        <span class="sunmoon__metric-value">${minToHm(sr)}–${minToHm(sr + 60)} · ${minToHm(ss - 60)}–${minToHm(ss)}</span>
      </div>
    </div>
  `;
}

/* ---- 工具③：空气质量榜（功能3） ---- */
async function renderAqimapTool() {
  const reqId = toolRequestId;
  const body = elements.toolBody;
  if (!body) return;

  const cities = cityStore.getAll();
  if (cities.length === 0) {
    body.innerHTML = stateArtHTML(t('aqimap.empty'), '', 'map');
    return;
  }

  body.innerHTML = toolSkeletonHTML(4);

  const list = cities.slice(0, 12);
  const results = await Promise.all(list.map(async (city) => {
    try {
      // 新版空气质量接口按「经纬度路径」取数，不再接受城市 ID，必须传整个城市对象
      const aqi = await getAirQuality(city);
      return { city, value: parseFloat(aqi?.aqi) };
    } catch {
      return { city, value: NaN };
    }
  }));
  if (reqId !== toolRequestId) return;

  const valid = results.filter((r) => Number.isFinite(r.value)).sort((a, b) => b.value - a.value);
  if (valid.length === 0) {
    body.innerHTML = stateArtHTML(t('common.noData'), '', 'map');
    return;
  }

  const levelLabel = (v) => t(`aqi.level.${aqiLevelIndex(v)}`);
  const max = valid[0];
  const min = valid[valid.length - 1];

  body.innerHTML = `
    <div class="aqirank">
      ${valid.map((r) => {
        const lvl = aqiLevelIndex(r.value);
        const isWorst = r === max && valid.length > 1;
        const isBest = r === min && valid.length > 1;
        const width = clamp((r.value / 300) * 100, 6, 100);
        return `
          <div class="aqirank__item ${isWorst ? 'aqirank__item--worst' : ''}">
            <div>
              <div class="aqirank__name">
                ${r.city.name}
                ${isWorst ? `<span class="aqirank__tag">${t('aqimap.worst')}</span>` : ''}
                ${isBest ? `<span class="aqirank__tag">${t('aqimap.best')}</span>` : ''}
              </div>
              <div class="aqirank__desc">${levelLabel(r.value)}</div>
              <div class="aqirank__bar">
                <div class="aqirank__bar-fill" style="width:${width.toFixed(1)}%;background:var(--aqi-${lvl})"></div>
              </div>
            </div>
            <div class="aqirank__value" style="color:var(--aqi-${lvl})">${Math.round(r.value)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/* ---- 工具④：天气对比（功能4） ---- */
function compareDeltaHTML(a, b, dec = 0) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return `<span class="compare__delta compare__delta--flat">${t('compare.flat')}</span>`;
  }
  const d = a - b;
  if (Math.abs(d) < 0.05) {
    return `<span class="compare__delta compare__delta--flat">${t('compare.flat')}</span>`;
  }
  const cls = d > 0 ? 'up' : 'down';
  return `<span class="compare__delta compare__delta--${cls}">${d > 0 ? '↑' : '↓'}${Math.abs(d).toFixed(dec)}</span>`;
}

function compareGroupHTML(title, a, b) {
  const rows = [
    { label: t('compare.temp'), av: a?.avg, bv: b?.avg, unit: '°', dec: 1 },
    { label: t('compare.aqi'), av: a?.aqi, bv: b?.aqi, unit: '', dec: 0 },
    { label: t('compare.humidity'), av: a?.hum, bv: b?.hum, unit: '%', dec: 0 },
    { label: t('compare.wind'), av: a?.wind, bv: b?.wind, unit: ' km/h', dec: 1 },
  ];

  const hasData = rows.some((r) => Number.isFinite(r.av) || Number.isFinite(r.bv));
  if (!hasData) {
    return `
      <div class="card compare__group">
        <div class="compare__group-title">${title}</div>
        <div class="cal__hint">${t('compare.noHistory')}</div>
      </div>
    `;
  }

  return `
    <div class="card compare__group">
      <div class="compare__group-title">${title}</div>
      ${rows.map((r) => `
        <div class="compare__row">
          <span class="compare__label">${r.label}</span>
          <div class="compare__cols">
            <div class="compare__col">
              <span class="compare__col-label">${a?.label || ''}</span>
              <span class="compare__col-value">${Number.isFinite(r.av) ? `${r.av.toFixed(r.dec)}${r.unit}` : '--'}</span>
            </div>
            <div class="compare__col">
              <span class="compare__col-label">${b?.label || ''}</span>
              <span class="compare__col-value">${Number.isFinite(r.bv) ? `${r.bv.toFixed(r.dec)}${r.unit}` : '--'}</span>
            </div>
          </div>
          ${compareDeltaHTML(r.av, r.bv, r.dec)}
        </div>
      `).join('')}
    </div>
  `;
}

function renderCompareTool() {
  const body = elements.toolBody;
  if (!body) return;

  const today = snapshotFrom(state.weather || {});
  const hist = readHistory();
  const yKey = dayKey(new Date(Date.now() - 86400000));
  const yesterday = hist.find((e) => e?.d === yKey) || null;

  const recent = hist.slice(-7);
  const prevWeek = hist.slice(-14, -7);
  const thisWeek = recent.length >= 3
    ? { label: t('compare.thisWeek'), avg: averageOf(recent, 'avg'), aqi: averageOf(recent, 'aqi'), hum: averageOf(recent, 'hum'), wind: averageOf(recent, 'wind') }
    : null;
  const lastWeek = prevWeek.length >= 3
    ? { label: t('compare.lastWeek'), avg: averageOf(prevWeek, 'avg'), aqi: averageOf(prevWeek, 'aqi'), hum: averageOf(prevWeek, 'hum'), wind: averageOf(prevWeek, 'wind') }
    : null;

  body.innerHTML = `
    ${compareGroupHTML(
      t('compare.todayVsYesterday'),
      { label: t('compare.today'), ...today },
      yesterday ? { label: t('compare.yesterday'), ...yesterday } : null,
    )}
    ${compareGroupHTML(t('compare.weekVsLastWeek'), thisWeek, lastWeek)}
  `;
}

/* ---- 工具⑤：生活建议（功能5，纯本地推导，零额外请求） ---- */
function renderLifeTool() {
  const body = elements.toolBody;
  const w = state.weather;
  if (!body) return;
  if (!w?.realtime) {
    body.innerHTML = stateArtHTML(t('common.noData'), '', 'cloud');
    return;
  }

  const rt = w.realtime;
  const d0 = w.daily?.[0] || {};
  const hourly = (w.hourly || []).slice(0, 12);
  const temp = parseFloat(rt.temp);
  const hum = parseFloat(rt.humidity);
  const windScale = parseFloat(rt.windScale) || 0;
  const uv = parseFloat(d0.uvIndex);
  const precip = parseFloat(d0.precip) || 0;
  const maxPop = Math.max(0, ...hourly.map((h) => parseFloat(h.pop) || 0));
  const aqi = parseFloat(w.airQuality?.aqi);
  const isDay = isDaytime(w.astronomy);

  const willRain = maxPop >= 45 || precip >= 0.5;
  const windCalm = windScale < 6;
  const airOk = !Number.isFinite(aqi) || aqi <= 150;

  // 穿衣
  let dressKey = 'life.dress.mild';
  if (Number.isFinite(temp)) {
    if (temp >= 32) dressKey = 'life.dress.veryHot';
    else if (temp >= 28) dressKey = 'life.dress.hot';
    else if (temp >= 18) dressKey = 'life.dress.mild';
    else if (temp >= 10) dressKey = 'life.dress.cool';
    else if (temp >= 0) dressKey = 'life.dress.cold';
    else dressKey = 'life.dress.veryCold';
  }

  // 防晒
  let uvKey = 'life.uv.weak';
  if (Number.isFinite(uv)) uvKey = uv >= 8 ? 'life.uv.strong' : uv >= 5 ? 'life.uv.mild' : 'life.uv.weak';
  else if (isDay && !willRain) uvKey = 'life.uv.mild';

  const items = [
    { icon: '👕', label: t('life.clothing'), advice: t(dressKey) },
    { icon: '☂️', label: t('life.umbrella'), advice: t(willRain ? 'life.umbrella.yes' : 'life.umbrella.no') },
    { icon: '☀️', label: t('life.sunscreen'), advice: t(uvKey) },
    { icon: '🚗', label: t('life.carWash'), advice: t(willRain || windScale >= 6 ? 'life.wash.no' : 'life.wash.yes') },
    { icon: '🏃', label: t('life.sport'), advice: t(!willRain && windCalm && airOk && (!Number.isFinite(temp) || (temp >= 5 && temp <= 32)) ? 'life.sport.yes' : 'life.sport.no') },
    { icon: '🧺', label: t('life.drying'), advice: t(!willRain && Number.isFinite(hum) && hum < 75 ? 'life.dry.yes' : willRain || !Number.isFinite(hum) || hum >= 75 ? 'life.dry.no' : 'life.dry.yes') },
  ];

  body.innerHTML = `
    <div class="life">
      ${items.map((it) => `
        <div class="life__item">
          <span class="life__icon">${it.icon}</span>
          <div class="life__body">
            <div class="life__label">${it.label}</div>
            <div class="life__advice">${it.advice}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/* ---- 工具⑥：桌面小组件预览（功能6，纯展示引导） ---- */
/** 与原生 WidgetProvider.bgResFor 一一对应的场景映射，保证预览与真机同色 */
function widgetBgClass(icon, isDay) {
  const code = Number(icon) || 0;
  if (code === 100 || code === 900) return 'clear-day';
  if (code === 150 || (code >= 151 && code <= 153)) return 'clear-night';
  if (code === 104 || (code >= 101 && code <= 103)) return 'cloud';
  if (code >= 302 && code <= 304) return 'thunder';
  if (code >= 300 && code <= 399) return 'rain';
  if ([404, 405, 406, 456, 457].includes(code)) return 'sleet';
  if (code >= 400 && code <= 499) return 'snow';
  if (code >= 500 && code <= 515) return 'fog';
  if (code === 901) return 'snow';
  return isDay ? 'clear-day' : 'clear-night';
}

function renderWidgetTool() {
  const body = elements.toolBody;
  const w = state.weather;
  if (!body) return;
  if (!w?.realtime) {
    body.innerHTML = stateArtHTML(t('common.noData'), '', 'cloud');
    return;
  }

  const rt = w.realtime;
  const d0 = w.daily?.[0] || {};
  const cityName = w.location?.name || state.currentCity?.name || '';
  const range = `${displayTemp(d0.tempMin)} / ${displayTemp(d0.tempMax)}`;
  const iconClass = rt.icon ? `qi-${rt.icon}` : '';

  // 预览严格对齐原生 RemoteViews 的实际版式：
  // 原生小组件已改用 vector drawable 图标 + 按天气切换的渐变背景，
  // 这里用同一套气象图标字形与同色系渐变，保证"预览即真机"。
  // 三种形态：2×2 方形、4×2 紧凑、4×4 带三日预报。
  const days = (w.daily || []).slice(1, 4).map((d) => (
    `<span>${formatDate(d.fxDate, { weekday: 'short', day: false })}`
    + `<i class="wg__day-icon ${d.iconDay ? `qi-${d.iconDay}` : ''}" aria-hidden="true"></i>`
    + `${displayTemp(d.tempMax)} / ${displayTemp(d.tempMin)}</span>`
  ));
  const addSteps = t('widget.addSteps');
  const widgetBg = widgetBgClass(rt.icon, isDaytime(w.astronomy));

  body.innerHTML = `
    <div class="widget-preview">
      <div class="widget-preview__desc">${t('widget.desc')}</div>
      <div class="widget-preview__stage">
        <div class="widget-preview__item">
          <div class="wg wg--small wg--bg-${widgetBg}">
            <div class="wg__top"><span>${cityName}</span><span class="wg__refresh" aria-hidden="true">⟳</span></div>
            <div class="wg__icon ${iconClass}" aria-hidden="true"></div>
            <div class="wg__temp">${displayTemp(rt.temp)}</div>
            <div class="wg__desc">${rt.text || ''}</div>
          </div>
          <div class="widget-preview__caption">${t('widget.small')}</div>
        </div>
        <div class="widget-preview__item">
          <div class="wg wg--compact wg--bg-${widgetBg}">
            <div class="wg__compact-main">
              <div class="wg__top"><span>${cityName}</span><span class="wg__refresh" aria-hidden="true">⟳</span></div>
              <div class="wg__row">
                <div class="wg__icon ${iconClass}" aria-hidden="true"></div>
                <div>
                  <div class="wg__temp">${displayTemp(rt.temp)}</div>
                  <div class="wg__desc">${rt.text || ''}</div>
                </div>
              </div>
            </div>
            <div class="wg__compact-side">
              <span class="wg__range">↑ ${displayTemp(d0.tempMax)}</span>
              <span class="wg__range">↓ ${displayTemp(d0.tempMin)}</span>
            </div>
          </div>
          <div class="widget-preview__caption">${t('widget.compact')}</div>
        </div>
        <div class="widget-preview__item">
          <div class="wg wg--medium wg--bg-${widgetBg}">
            <div class="wg__row">
              <div class="wg__icon ${iconClass}" aria-hidden="true"></div>
              <div>
                <div class="wg__temp">${displayTemp(rt.temp)}</div>
                <div class="wg__desc">${rt.text || ''}</div>
              </div>
              <div class="wg__side">
                <span>${cityName}</span>
                <span class="wg__range">↑ ${range.split(' / ')[1] || ''} ↓ ${range.split(' / ')[0] || ''}</span>
              </div>
            </div>
            <div class="wg__days">
              ${days.join('')}
            </div>
          </div>
          <div class="widget-preview__caption">${t('widget.medium')}</div>
        </div>
      </div>
      <p class="widget-preview__note">${t('widget.bg')}</p>
      <div class="widget-preview__brands">
        <div class="widget-preview__desc">${t('widget.addTitle')}</div>
        <ul class="widget-preview__list">
          ${(Array.isArray(addSteps) ? addSteps : []).map((s) => `<li>${s}</li>`).join('')}
        </ul>
      </div>
      <div class="widget-preview__auto">
        <div class="widget-preview__auto-title">⟳ ${t('widget.autoRefresh')}</div>
        <p class="widget-preview__auto-desc">${t('widget.autoRefreshDesc')}</p>
        <span class="widget-preview__auto-tap">${t('widget.tapRefresh')}</span>
      </div>
      <div class="widget-preview__hint">${svgIcon('alertCircle').outerHTML}<span>${t('widget.hint')}</span></div>
    </div>
  `;
}

/* ---- 工具⑦：天气分享图（Canvas 生成 1080×1350，可直接分享或保存） ---- */
// 分享图模板：「深空」深色海报 / 「晨光」浅色杂志，二者共用同一份天气数据
let shareTemplate = 'midnight';

function renderShareCardTool() {
  const body = elements.toolBody;
  const w = state.weather;
  if (!body) return;
  if (!w?.realtime) {
    body.innerHTML = stateArtHTML(t('common.noData'), '', 'cloud');
    return;
  }

  body.innerHTML = `
    <div class="sharecard">
      <p class="sharecard__desc">${t('sharecard.desc')}</p>
      <div class="segmented sharecard__tabs" id="sharecard-template" role="radiogroup" aria-label="${escAttr(t('sharecard.templateLabel'))}" data-value="${shareTemplate}">
        <span class="segmented__thumb" aria-hidden="true"></span>
        <button type="button" class="segmented__opt" role="radio" aria-checked="false" data-value="midnight">${t('sharecard.tplMidnight')}</button>
        <button type="button" class="segmented__opt" role="radio" aria-checked="false" data-value="daylight">${t('sharecard.tplDaylight')}</button>
      </div>
      <div class="sharecard__stage">
        <canvas id="share-canvas" class="sharecard__canvas" width="1080" height="1350" role="img" aria-label="${escAttr(t('sharecard.title'))}"></canvas>
      </div>
      <div class="sharecard__actions">
        <button type="button" id="sharecard-share" class="btn btn--primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
          <span>${t('sharecard.share')}</span>
        </button>
        <button type="button" id="sharecard-save" class="btn btn--ghost">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>${t('sharecard.save')}</span>
        </button>
      </div>
    </div>
  `;

  // 模板切换：两套视觉，共用同一份天气数据与同一块 canvas
  setupSegmented('sharecard-template', shareTemplate, (value) => {
    shareTemplate = value;
    drawShareCard();
  });

  // 等一帧再画：canvas 刚插入 DOM 时可能还没有布局尺寸
  requestAnimationFrame(() => drawShareCard());

  $('#sharecard-share')?.addEventListener('click', async () => {
    const file = await shareCardFile();
    if (!file) return;
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: t('sharecard.title') });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    downloadShareCard();
  });

  $('#sharecard-save')?.addEventListener('click', () => downloadShareCard());
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function drawShareCard() {
  if (shareTemplate === 'daylight') return drawShareCardDaylight();
  const canvas = $('#share-canvas');
  const w = state.weather;
  if (!canvas || !w?.realtime) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const W = canvas.width;
  const H = canvas.height;
  const pad = 88;
  const rt = w.realtime;
  const d0 = w.daily?.[0] || {};
  const days = (w.daily || []).slice(1, 4);
  const cityName = w.location?.name || state.currentCity?.name || '';
  const emoji = weatherEmoji(rt.icon, rt.text, isDaytime(w.astronomy));

  ctx.clearRect(0, 0, W, H);

  // 深色底 + 极细描边：和 App 深色主题同一语汇，避免做成廉价渐变海报
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0a0d16');
  bg.addColorStop(0.55, '#10142a');
  bg.addColorStop(1, '#1a1236');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.78, H * 0.16, 0, W * 0.78, H * 0.16, W * 0.7);
  glow.addColorStop(0, 'rgba(124, 108, 230, 0.22)');
  glow.addColorStop(1, 'rgba(124, 108, 230, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 3;
  roundRect(ctx, 24, 24, W - 48, H - 48, 44);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';

  // 品牌行
  ctx.fillStyle = 'rgba(196, 203, 225, 0.85)';
  ctx.font = '600 34px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(CONFIG.brand, pad, pad + 30);

  const dateText = formatDate(new Date().toISOString().slice(0, 10), { weekday: 'long', day: true }) || '';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(160, 168, 192, 0.85)';
  ctx.font = '400 30px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(dateText, W - pad, pad + 30);
  ctx.textAlign = 'left';

  // 城市
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 76px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(cityName, pad, pad + 168);

  ctx.fillStyle = 'rgba(148, 158, 186, 0.9)';
  ctx.font = '400 34px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(t('sharecard.subtitle'), pad, pad + 222);

  // 天气图标 + 温度
  ctx.font = '200px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillText(emoji, pad - 6, pad + 470);

  ctx.fillStyle = '#ffffff';
  ctx.font = '200 230px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(displayTemp(rt.temp), W - pad, pad + 452);
  ctx.textAlign = 'left';

  ctx.fillStyle = 'rgba(226, 232, 245, 0.95)';
  ctx.font = '500 46px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(rt.text || '', pad, pad + 560);

  const range = `${t('share.high')} ${displayTemp(d0.tempMax)}  ${t('share.low')} ${displayTemp(d0.tempMin)}`;
  ctx.fillStyle = 'rgba(150, 160, 188, 0.95)';
  ctx.font = '400 34px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(range, pad, pad + 624);

  // 分隔线
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, pad + 692);
  ctx.lineTo(W - pad, pad + 692);
  ctx.stroke();

  // 三日预报：三列等宽，避免依赖 flex
  const colW = (W - pad * 2) / 3;
  days.forEach((d, i) => {
    const x = pad + colW * i + colW / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(158, 168, 194, 0.95)';
    ctx.font = '500 32px "Inter", -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(formatDate(d.fxDate, { weekday: 'short', day: false }) || '', x, pad + 772);

    ctx.font = '86px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(weatherEmoji(d.iconDay, d.textDay, true), x, pad + 880);

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 36px "Inter", -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(`${displayTemp(d.tempMax)} / ${displayTemp(d.tempMin)}`, x, pad + 940);
  });
  ctx.textAlign = 'left';

  // 页脚水印
  ctx.fillStyle = 'rgba(126, 136, 164, 0.75)';
  ctx.font = '400 28px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(t('sharecard.footer'), pad, H - pad);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(126, 136, 164, 0.75)';
  ctx.fillText(t('sharecard.updated', rt.obsTime ? rt.obsTime.slice(11, 16) : '--:--'), W - pad, H - pad);
  ctx.textAlign = 'left';

  drawPostmark(ctx, { W, pad, rt, cityName, dark: true });

  return canvas;
}

/**
 * F3 明信片邮戳：-8° 双环 + 日期/城市/天气三段。
 * 只画少量圆弧与文字，不引入图片，生成耗时可以忽略。
 */
function drawPostmark(ctx, { W, pad, rt, cityName, dark }) {
  const r = 76;
  const cx = W - pad - r - 8;
  const cy = pad + 236;
  const ink = dark ? 'rgba(226, 232, 245, 0.66)' : 'rgba(18, 21, 31, 0.48)';
  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-8 * Math.PI) / 180);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r - 10, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.stroke();
  // 波状取消线：只画三段短弧，避免像廉价水印
  ctx.lineWidth = 1.5;
  [-0.34, 0, 0.34].forEach((off) => {
    ctx.beginPath();
    ctx.arc(0, 0, r - 26 + off * 26, Math.PI * 0.72, Math.PI * 1.28);
    ctx.stroke();
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = ink;
  ctx.font = '600 26px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(mmdd, 0, -4);
  ctx.font = '400 20px "Inter", -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(String(cityName || '').slice(0, 6), 0, 24);
  ctx.fillText(`${rt?.text || ''}`.slice(0, 5), 0, 48);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 「晨光」模板：浅色纸感底 + 大留白 + 单条彩色晕染。
 * 与「深空」共用同一块 canvas 与同一份数据，仅视觉语言不同：
 * 深色适合朋友圈大图，浅色在缩略图里更清晰、也更像杂志插页。
 */
function drawShareCardDaylight() {
  const canvas = $('#share-canvas');
  const w = state.weather;
  if (!canvas || !w?.realtime) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const W = canvas.width;
  const H = canvas.height;
  const pad = 88;
  const rt = w.realtime;
  const d0 = w.daily?.[0] || {};
  const days = (w.daily || []).slice(1, 4);
  const cityName = w.location?.name || state.currentCity?.name || '';
  const emoji = weatherEmoji(rt.icon, rt.text, isDaytime(w.astronomy));
  const dateText = formatDate(new Date().toISOString().slice(0, 10), { weekday: 'long', day: true }) || '';
  const ink = '#12151f';
  const inkSoft = 'rgba(18, 21, 31, 0.56)';
  const inkFaint = 'rgba(18, 21, 31, 0.42)';
  const sans = '"Inter", -apple-system, "PingFang SC", sans-serif';
  const emojiFont = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 纸感底：#f7f5f0 而不是纯白 —— 纯白在聊天软件里压缩后容易发灰、边缘发脏
  ctx.fillStyle = '#f7f5f0';
  ctx.fillRect(0, 0, W, H);

  // 左上留白处一抹品牌色晕染，避免整张图过于素净
  const tint = ctx.createRadialGradient(W * 0.16, H * 0.08, 0, W * 0.16, H * 0.08, W * 0.9);
  tint.addColorStop(0, 'rgba(90, 85, 224, 0.16)');
  tint.addColorStop(0.55, 'rgba(90, 85, 224, 0.05)');
  tint.addColorStop(1, 'rgba(90, 85, 224, 0)');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, W, H);

  // 顶部：品牌 + 日期
  ctx.fillStyle = inkSoft;
  ctx.font = `600 32px ${sans}`;
  ctx.fillText(CONFIG.brand, pad, pad + 18);
  ctx.textAlign = 'right';
  ctx.font = `400 30px ${sans}`;
  ctx.fillText(dateText, W - pad, pad + 18);
  ctx.textAlign = 'left';

  // 城市与天气描述
  ctx.fillStyle = ink;
  ctx.font = `700 74px ${sans}`;
  ctx.fillText(cityName, pad, pad + 152);
  ctx.fillStyle = inkSoft;
  ctx.font = `400 34px ${sans}`;
  ctx.fillText(rt.text || '', pad, pad + 208);

  // 超大温度 + 右侧天气图形
  ctx.fillStyle = ink;
  ctx.font = `200 300px ${sans}`;
  ctx.fillText(displayTemp(rt.temp), pad - 8, pad + 520);
  ctx.textAlign = 'right';
  ctx.font = `180px ${emojiFont}`;
  ctx.fillText(emoji, W - pad, pad + 498);
  ctx.textAlign = 'left';

  ctx.fillStyle = inkSoft;
  ctx.font = `500 40px ${sans}`;
  ctx.fillText(
    `${t('share.high')} ${displayTemp(d0.tempMax)}  ${t('share.low')} ${displayTemp(d0.tempMin)}`,
    pad,
    pad + 592
  );

  // 细分隔线
  ctx.strokeStyle = 'rgba(18, 21, 31, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, pad + 668);
  ctx.lineTo(W - pad, pad + 668);
  ctx.stroke();

  // 三日预报：行式排布（比深色模板的三列更省高度，留白更多）
  days.forEach((d, i) => {
    const y = pad + 760 + i * 112;
    ctx.textAlign = 'left';
    ctx.fillStyle = inkSoft;
    ctx.font = `500 32px ${sans}`;
    ctx.fillText(formatDate(d.fxDate, { weekday: 'short', day: false }) || '', pad, y);
    ctx.font = `62px ${emojiFont}`;
    ctx.fillText(weatherEmoji(d.iconDay, d.textDay, true), pad + 190, y - 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = ink;
    ctx.font = `600 38px ${sans}`;
    ctx.fillText(`${displayTemp(d.tempMax)} / ${displayTemp(d.tempMin)}`, W - pad, y);
  });

  // 页脚
  ctx.textAlign = 'left';
  ctx.fillStyle = inkFaint;
  ctx.font = `400 28px ${sans}`;
  ctx.fillText(t('sharecard.footer'), pad, H - pad);
  ctx.textAlign = 'right';
  ctx.fillText(t('sharecard.updated', rt.obsTime ? rt.obsTime.slice(11, 16) : '--:--'), W - pad, H - pad);
  ctx.textAlign = 'left';

  drawPostmark(ctx, { W, pad, rt, cityName, dark: false });

  return canvas;
}

function shareCardFile() {
  return new Promise((resolve) => {
    const canvas = drawShareCard();
    if (!canvas) {
      showToast(t('sharecard.failed'));
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast(t('sharecard.failed'));
        resolve(null);
        return;
      }
      const name = `apexon-weather-${new Date().toISOString().slice(0, 10)}.png`;
      resolve(new File([blob], name, { type: 'image/png' }));
    }, 'image/png');
  });
}

async function downloadShareCard() {
  const file = await shareCardFile();
  if (!file) return;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast(t('sharecard.downloaded'));
}

/* ---- 功能12：手势快捷（左右滑切换城市 / 双击顶栏回到顶部） ---- */
function setupGestures() {
  const main = $('.main');
  if (main) {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let axis = null;

    main.addEventListener('touchstart', (e) => {
      if (state.currentPage !== 'home' || e.touches.length !== 1) return;
      // 横向可滚动区域与弹层内部不参与切城市手势
      if (e.target.closest('.hourly__scroll, .hourly__chart, .aqi, [data-no-swipe]')) return;
      if (elements.settingsSheet && !elements.settingsSheet.hidden) return;
      const target = e.touches[0];
      startX = target.clientX;
      startY = target.clientY;
      tracking = true;
      axis = null;
    }, { passive: true });

    main.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (axis === null && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) {
        axis = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'x' : 'y';
      }
    }, { passive: true });

    main.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      if (axis !== 'x') return;
      const changed = e.changedTouches?.[0];
      if (!changed) return;
      const dx = changed.clientX - startX;
      if (Math.abs(dx) < 64) return;

      const cities = cityStore.getAll();
      if (cities.length < 2) return;
      const index = cities.findIndex((c) => String(c.id) === String(state.currentCity?.id));
      if (index < 0) return;
      const next = dx < 0 ? index + 1 : index - 1;
      if (next < 0 || next >= cities.length) return;

      if (navigator.vibrate) navigator.vibrate(10);
      const city = cities[next];
      state.currentCity = city;
      loadWeather(city);
    }, { passive: true });
  }

  // 双击顶栏回到顶部
  const header = $('.header');
  if (header) {
    let lastTap = 0;
    header.addEventListener('touchend', () => {
      const now = Date.now();
      if (now - lastTap < 300) {
        lastTap = 0;
        main?.scrollTo({ top: 0, behavior: 'smooth' });
        if (navigator.vibrate) navigator.vibrate(6);
      } else {
        lastTap = now;
      }
    }, { passive: true });
  }
}

/* ---- 功能10：首启引导（3 步：语言 / 单位 / 定位） ---- */
let onboardResolve = null;

function setupOnboarding() {
  const root = elements.onboard;
  if (!root) return;

  const langsEl = $('#onboard-langs');
  const unitEl = $('#onboard-unit');
  const skipBtn = $('#onboard-skip');
  const nextBtn = $('#onboard-next');
  const steps = $$('.onboard__step', root);
  const dots = $$('.onboard__dot', root);

  if (langsEl && !langsEl.childElementCount) {
    langsEl.innerHTML = getLanguages().map((l) => `
      <button type="button" class="onboard__lang" role="radio" aria-checked="false" data-value="${l.code}">${l.native}</button>
    `).join('');
  }

  let step = 0;
  let unit = settingsStore.get().unit || 'c';

  const syncLangs = () => {
    const current = getLanguage();
    $$('.onboard__lang', langsEl || root).forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.value === current ? 'true' : 'false');
    });
  };

  const syncUnit = () => {
    if (!unitEl) return;
    unitEl.dataset.value = unit;
    $$('.segmented__opt', unitEl).forEach((opt) => {
      const on = opt.dataset.value === unit;
      opt.classList.toggle('is-active', on);
      opt.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const thumb = unitEl.querySelector('.segmented__thumb');
    const active = unitEl.querySelector('.segmented__opt.is-active');
    if (thumb && active) {
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.transform = `translateX(${active.offsetLeft}px)`;
    }
  };

  const render = () => {
    steps.forEach((el, i) => { el.hidden = i !== step; });
    dots.forEach((el, i) => el.classList.toggle('onboard__dot--active', i === step));
    if (nextBtn) nextBtn.textContent = step === 2 ? t('onboard.allow') : t('onboard.next');
    if (skipBtn) skipBtn.textContent = step === 2 ? t('onboard.later') : t('onboard.skip');
    syncLangs();
    syncUnit();
  };

  $$('.onboard__lang', langsEl || root).forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.value;
      if (setLanguage(value)) {
        settingsStore.set({ language: value });
      }
    });
  });

  unitEl?.querySelectorAll('.segmented__opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      unit = opt.dataset.value;
      settingsStore.set({ unit });
      syncUnit();
    });
  });

  const finish = (allowLocation) => {
    settingsStore.set({ onboarded: true });
    root.hidden = true;
    if (onboardResolve) {
      onboardResolve(allowLocation);
      onboardResolve = null;
    }
  };

  nextBtn?.addEventListener('click', () => {
    if (step < 2) {
      step += 1;
      render();
      return;
    }
    finish(true);
  });

  skipBtn?.addEventListener('click', () => {
    if (step < 2) {
      finish(false);
      return;
    }
    finish(false);
  });

  window.addEventListener('resize', syncUnit);
}

function showOnboarding() {
  const root = elements.onboard;
  if (!root) return Promise.resolve(false);
  // 入页语言跟随系统/已有设置
  root.hidden = false;
  const steps = $$('.onboard__step', root);
  steps.forEach((el, i) => { el.hidden = i !== 0; });
  $$('.onboard__dot', root).forEach((el, i) => el.classList.toggle('onboard__dot--active', i === 0));
  const nextBtn = $('#onboard-next');
  if (nextBtn) nextBtn.textContent = t('onboard.next');
  const skipBtn = $('#onboard-skip');
  if (skipBtn) skipBtn.textContent = t('onboard.skip');
  $$('#onboard-langs .onboard__lang').forEach((btn) => {
    btn.setAttribute('aria-checked', btn.dataset.value === getLanguage() ? 'true' : 'false');
  });

  return new Promise((resolve) => {
    onboardResolve = resolve;
  });
}

/* ---- 安卓物理返回键：双击返回才退出 ---- */
let exitArmTimer = null;

function showExitOverlay() {
  const el = elements.exitOverlay;
  if (!el) return;
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
}

function hideExitOverlay() {
  const el = elements.exitOverlay;
  if (el && !el.hidden) {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
  }
}

/** 返回键优先关闭已打开的弹层；返回 true 表示这次返回已被弹层消费。 */
function closeTopOverlayForBack() {
  if (elements.updateDialog && !elements.updateDialog.hidden) {
    closeNativeUpdateDialog();
    return true;
  }
  if (elements.settingsSheet && !elements.settingsSheet.hidden) {
    closeSettingsSheet();
    return true;
  }
  const detail = $('#daily-detail');
  if (detail && !detail.hidden) {
    closeDailyDetail();
    return true;
  }
  const shortcut = $('#shortcut-help');
  if (shortcut && !shortcut.hidden) {
    closeShortcutHelp();
    return true;
  }
  return false;
}

/**
 * 返回键统一裁决入口。原生壳（MainActivity.onBackPressed）会同步调用它并据此决定是否 finish()。
 * 之所以把决策搬到前端：之前靠 history 哨兵 + popstate 实现双击退出，
 * 但 Capacitor 壳没有装 @capacitor/app 插件，硬件返回键会直接 finish() 掉 Activity，
 * popstate 根本没机会跑，于是「误触一下返回就退出应用」。
 * 现在返回键一律先问前端，前端说 exit 才退。
 * @returns {'exit'|'nav'|'dismiss'|'arm'}
 */
function apexonHandleBack() {
  if (closeTopOverlayForBack()) return 'dismiss';

  const el = elements.exitOverlay;
  if (el && !el.hidden) {
    // 第二次返回：收起提示，允许真正退出
    hideExitOverlay();
    clearTimeout(exitArmTimer);
    return 'exit';
  }

  const route = location.hash.replace('#', '') || 'home';
  if (route !== 'home') {
    // 子页 → 首页：借 history.back() 触发 setupRouter 的 popstate 完成切页，保持历史同步
    history.back();
    return 'nav';
  }

  // 首页第一次返回：只提示，不退出
  showExitOverlay();
  clearTimeout(exitArmTimer);
  exitArmTimer = setTimeout(hideExitOverlay, 2000);
  return 'arm';
}
// 暴露给原生壳，供 MainActivity.onBackPressed 同步读取
window.__apexonHandleBack = apexonHandleBack;

function setupExitBackButton() {
  const el = elements.exitOverlay;
  if (!el) return;

  const isNative = !!(window.Capacitor && (typeof window.Capacitor.isNativePlatform === 'function'
    ? window.Capacitor.isNativePlatform()
    : window.Capacitor));
  // 原生壳：返回键由 MainActivity 转交 __apexonHandleBack，这里不再挂 popstate，
  // 否则同一次返回会被处理两次。
  if (isNative) return;

  // 网页版（浏览器 / PWA）：没有硬件返回键，用 history 哨兵吞掉第一次返回，
  // 让用户看到「再按一次」提示，而不是直接离开站点。
  history.pushState({ apexonGuard: true }, '');
  window.addEventListener('popstate', () => {
    if (closeTopOverlayForBack()) {
      history.pushState({ apexonGuard: true }, '');
      return;
    }
    const overlay = elements.exitOverlay;
    if (overlay && !overlay.hidden) {
      // 已提示过：放行，交给浏览器真正后退/离开
      hideExitOverlay();
      return;
    }
    const route = location.hash.replace('#', '') || 'home';
    if (route === 'home') {
      showExitOverlay();
      clearTimeout(exitArmTimer);
      exitArmTimer = setTimeout(hideExitOverlay, 2000);
      history.pushState({ apexonGuard: true }, '');
    }
  });
}

/* ============================
   支持 APEXON · 自愿打赏（v2.3.0）
   ============================ */

/**
 * 打赏档位。
 * 金额刻意压低（全部远低于 100 美元），只为覆盖服务器与接口成本，
 * 不设置任何"解锁内容"，避免形成变相付费墙。
 *
 * checkoutUrl 留空时，页面只展示档位并提示"通道尚未开通"，
 * 不会把用户带到无效链接——这是刻意的：宁可少一个入口，也不给假入口。
 * 在 Lemon Squeezy 后台建好产品后，把结账链接填进 CONFIG.donateCheckoutUrl
 * （或各档位自己的 checkoutUrl）即可自动生效。
 */
const DONATE_TIERS = [
  { id: 'tier1', amount: 1.99, featured: false },
  { id: 'tier2', amount: 4.99, featured: false },
  { id: 'tier3', amount: 9.99, featured: true },
  { id: 'tier4', amount: 19.99, featured: false },
];

/** 美元 → 人民币的粗略换算，仅用于展示参考价，不参与结算 */
const USD_TO_CNY = 7.2;

/** 打赏页来源页：从首页还是发现页进来，返回时原路返回 */
let donateOrigin = 'discover';

/** 打开 Lemon Squeezy 结账弹层；脚本未加载时回退到新标签页 */
function openLemonCheckout(url) {
  if (!/^https:\/{2}/i.test(url)) return;
  const overlay = window.LemonSqueezy && window.LemonSqueezy.Url;
  if (overlay && typeof overlay.Open === 'function') {
    overlay.Open(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function renderDonatePage() {
  if (!elements.donateTiers) return;

  const shared = (CONFIG.donateCheckoutUrl || '').trim();
  const available = Boolean(shared) || DONATE_TIERS.some((tier) => (tier.checkoutUrl || '').trim());
  if (elements.donateUnavailable) elements.donateUnavailable.hidden = available;

  elements.donateTiers.replaceChildren(
    ...DONATE_TIERS.map((tier) => {
      const url = (tier.checkoutUrl || shared || '').trim();

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `donate__tier${tier.featured ? ' donate__tier--featured' : ''}`;
      btn.disabled = !url;

      const amount = document.createElement('span');
      amount.className = 'donate__tier-amount';
      amount.textContent = `US$${tier.amount.toFixed(2)}`;

      const cny = document.createElement('span');
      cny.className = 'donate__tier-cny';
      cny.textContent = `≈ ¥${Math.round(tier.amount * USD_TO_CNY)}`;

      const name = document.createElement('span');
      name.className = 'donate__tier-name';
      name.textContent = t(`donate.${tier.id}`);

      const note = document.createElement('span');
      note.className = 'donate__tier-note';
      note.textContent = t(`donate.${tier.id}Note`);

      btn.append(amount, cny, name, note);
      if (url) {
        btn.addEventListener('click', () => {
          if (navigator.vibrate) navigator.vibrate(8);
          openLemonCheckout(url);
        });
      }
      return btn;
    })
  );
}

function setupDonate() {
  // 入口是「底部小字 + 发现页卡片 + 设置页」，统一用事件委托，
  // 避免每处入口都单独绑一次事件。
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-donate]');
    if (!trigger) return;
    event.preventDefault();
    if (navigator.vibrate) navigator.vibrate(8);
    if (state.currentPage !== 'donate') donateOrigin = state.currentPage;
    navigateTo('donate');
  });

  elements.donateBack?.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(8);
    navigateTo(donateOrigin || 'discover');
  });
}

/* ============================
   账号与用量（Supabase 会话；登录入口已移除）
   ============================ */

/**
 * 刷新设置页「账号与用量」区块。
 * 不强制登录：未登录也能正常看天气。
 * 每日额度已大幅放宽（见 CONFIG.guestDailyLimit / userDailyLimit），
 * 这里只做透明展示，不再做「额度快用完了」的催促。
 */
async function refreshAccountUI() {
  if (!elements.accountStatus) return;

  const user = isSupabaseConfigured() ? await getUser() : null;
  const meta = user?.user_metadata || {};
  const displayName = meta.user_name || meta.name || meta.preferred_username || '';

  elements.accountStatus.textContent = user
    ? (displayName || t('account.signedIn'))
    : t('account.guest');
  if (elements.accountLogout) elements.accountLogout.hidden = !user;

  const usage = await fetchUsage();
  if (elements.accountUsage) {
    elements.accountUsage.textContent = usage ? `${usage.used} / ${usage.limit}` : '—';
  }
}

/**
 * 「退出应用」：原生壳（MainActivity 注入的 ApexonShell）调用 finish() 真正退出；
 * 网页版没有关闭标签页的权限，退化为提示。
 */
function requestAppExit() {
  if (window.ApexonShell && typeof window.ApexonShell.exitApp === 'function') {
    window.ApexonShell.exitApp();
    return;
  }
  window.close();
  showToast(t('settings.exitApp'));
}

function setupAccount() {
  // 未配置 Supabase 时 initSupabase / onAuthStateChange 内部已做降级，
  // 这里不需要额外的 if 分支，回调会以 null 调用一次。
  initSupabase();

  onAuthStateChange(async (session) => {
    // API 请求走云端代理时，JWT 就是身份凭证。退出登录后立即清空，
    // 请求自动回落为匿名代理——包内不再保存任何和风密钥。
    setProxyAccessToken(session?.access_token || null);
    await refreshAccountUI();
  });

  // GitHub 登录入口已按需求移除（登录只影响额度，而额度已放开），
  // 但已登录用户仍需要能退出，故保留「退出登录」按钮。
  elements.accountLogout?.addEventListener('click', async () => {
    if (navigator.vibrate) navigator.vibrate(8);
    await signOut();
    setProxyAccessToken(null);
    await refreshAccountUI();
  });

  elements.appExit?.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(8);
    requestAppExit();
  });

  refreshAccountUI();
}

initApp().catch((error) => {
  console.error('APEXON Weather init failed:', error);
});
