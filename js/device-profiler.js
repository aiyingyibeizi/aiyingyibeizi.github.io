/**
 * APEXON Weather - Device Profiler（机型识别与适配）
 *
 * 纯前端"识别"。必须说清楚边界：
 *   - iOS Safari / WKWebView 从 UA 中隐去了具体机型，只能靠屏幕尺寸 + 安全区推断；
 *   - Android WebView 的 UA 里通常带厂商代号（如 SM-G991B / Pixel 7 / M2101K9C），
 *     但厂商可自行改写，因此只做"族"级别识别，不承诺精确型号；
 *   - 要拿到 100% 精确型号需要 Capacitor 原生插件（@capacitor/device），
 *     本工程没有 Node 构建环境，无法新增插件。
 *
 * 因此本模块的策略是：能从 UA 拿到的就拿（Android 型号），
 * 拿不到的就用"屏幕特征 + 安全区实测"推断族（iOS 全系），
 * 最终给 <html> 打一组 data-* 标记，并把实测安全区写进 --sa-* 变量，
 * 让 CSS 能针对不同族做间距、顶栏、hero 的精准微调。
 */

const ANDROID_FAMILY_RULES = [
  { family: 'samsung', re: /SM-[A-Z0-9]+|GT-[A-Z0-9]+|SCH-[A-Z0-9]+|SGH-[A-Z0-9]+|Galaxy/i },
  { family: 'pixel', re: /\bPixel\b/i },
  { family: 'oneplus', re: /\bONEPLUS\b|\bOnePlus\b|\bIN2[0-9]{3}\b|\bLE2[0-9]{3}\b|\bNE2[0-9]{3}\b/i },
  { family: 'xiaomi', re: /\bM[0-9]{4}[A-Z0-9]{2,}\b|\bRedmi\b|\bPOCO\b|\bMIX\b|\bMi[ _]?[0-9]/i },
  { family: 'huawei', re: /\bHUAWEI\b|\bHONOR\b|\b(ELE|VOG|ANE|LYA|CLT|MAR|NOH|JSN|ELS|ANA|JNY|SEA)-[A-Z0-9]+/i },
  { family: 'oppo', re: /\bOPPO\b|\bCPH[0-9]{4}\b|\bP[A-Z]{2}[MT][0-9]{2}\b|\bPBFM[0-9]+\b/i },
  { family: 'vivo', re: /\bvivo\b|\bV[0-9]{4}[A-Z]?\b|\bI[0-9]{4}\b/i },
  { family: 'realme', re: /\brealme\b|\bRMX[0-9]{4}\b/i },
];

/** iOS 屏幕特征 → 机型族（宽×高 + dpr，取逻辑分辨率） */
const IPHONE_SCREEN_MAP = [
  { w: 393, h: 852, cutout: 'island', model: 'iPhone 14/15/16' },
  { w: 402, h: 874, cutout: 'island', model: 'iPhone 16 Pro' },
  { w: 440, h: 956, cutout: 'island', model: 'iPhone 16 Pro Max' },
  { w: 430, h: 932, cutout: 'island', model: 'iPhone 14/15 Plus · Pro Max' },
  { w: 390, h: 844, cutout: 'notch', model: 'iPhone 12/13/14' },
  { w: 428, h: 926, cutout: 'notch', model: 'iPhone 12/13/14 Pro Max' },
  { w: 375, h: 812, cutout: 'notch', model: 'iPhone X/XS/11 Pro · 12/13 mini' },
  { w: 414, h: 896, cutout: 'notch', model: 'iPhone XR/XS Max/11' },
  { w: 375, h: 667, cutout: 'none', model: 'iPhone SE 2/3 · 8' },
  { w: 320, h: 568, cutout: 'none', model: 'iPhone SE 1 · 5s' },
];

/**
 * 上一次已知的合法安全区（持久化）。
 * 缓存命中时页面在首帧就完成初始化，WebView 还没来得及把 safe-area-inset 传给渲染树，
 * env() 会读到 0 —— 这正是「首次进入正常、有缓存后适配值全变 0」的根因。
 * 把非 0 结果存下来，下次冷启动先用它兜底，之后再按实测值校准。
 */
const SAFE_STORAGE_KEY = 'apexon_safe_areas_v1';

/**
 * 单边取值：只接受 > 0 的数字，其余一律视为「本次没测到」。
 * 注意必须用 parseFloat：getComputedStyle 返回的是带单位的字符串（如 "34px"），
 * 用 Number("34px") 会得到 NaN，导致实测值永远被当成 0 ——
 * 这正是「检测一次后导航栏 px 永久归零」的根因。
 */
function edge(value) {
  const n = Math.round(parseFloat(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeSafe(raw) {
  return {
    top: edge(raw && raw.top),
    bottom: edge(raw && raw.bottom),
    left: edge(raw && raw.left),
    right: edge(raw && raw.right),
  };
}

function readStoredSafe() {
  try {
    const raw = localStorage.getItem(SAFE_STORAGE_KEY);
    return raw ? normalizeSafe(JSON.parse(raw)) : normalizeSafe(null);
  } catch (e) {
    return normalizeSafe(null);
  }
}

function storeSafe(safe) {
  try {
    localStorage.setItem(SAFE_STORAGE_KEY, JSON.stringify(safe));
  } catch (e) {
    // 隐私模式 / 存储被禁用：只影响下次冷启动兜底，不影响本次实测
  }
}

let lastGoodSafe = readStoredSafe();
/** 上一次实测时的屏幕方向，用于判断本轮读数变化是「切换方向」还是「同向抖动」 */
let lastOrientation = '';

/** 读取 env(safe-area-inset-*)，部分 WebView 需实际布局后才返回非 0 */
function measureSafeAreas() {
  const host = document.body || document.documentElement;
  if (!host) return normalizeSafe(null);
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);' +
    'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);';
  host.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = normalizeSafe({
    top: cs.getPropertyValue('padding-top'),
    bottom: cs.getPropertyValue('padding-bottom'),
    left: cs.getPropertyValue('padding-left'),
    right: cs.getPropertyValue('padding-right'),
  });
  host.removeChild(probe);
  return out;
}

/** 当前屏幕方向：用于区分「横竖屏切换导致的整体变化」与「同一方向下的单边抖动」 */
function currentOrientation() {
  return window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape';
}

/**
 * 合并「本次实测」与「上次已知值」：
 *   - 四边全 0 → 系统还没上报安全区（缓存命中首帧最常见），沿用上次非 0 值，
 *     绝不把已经算好的适配值覆盖成 0；
 *   - 同一方向下部分边读到 0 → 只更新读到非 0 的边，其余边保留上次已知值。
 *     键盘弹出、沉浸式状态、ROM 延迟上报都会让某一瞬间只读到部分边，
 *     若整组覆盖，底部导航就会永久掉回屏幕最底边；
 *   - 横竖屏切换 → 四条边本来就会整体变化，整组采信本次结果，
 *     避免竖屏的顶部/底部留白被带到横屏。
 */
function resolveSafeAreas() {
  const fresh = measureSafeAreas();
  const any = fresh.top || fresh.bottom || fresh.left || fresh.right;
  if (!any) return { ...lastGoodSafe };

  const orientation = currentOrientation();
  if (orientation === lastOrientation) {
    lastGoodSafe = {
      top: fresh.top || lastGoodSafe.top,
      bottom: fresh.bottom || lastGoodSafe.bottom,
      left: fresh.left || lastGoodSafe.left,
      right: fresh.right || lastGoodSafe.right,
    };
  } else {
    lastGoodSafe = { ...fresh };
    lastOrientation = orientation;
  }
  storeSafe(lastGoodSafe);
  return { ...lastGoodSafe };
}

function classifyCutout(safeTop, os) {
  if (safeTop >= 51) return 'island';
  if (safeTop >= 30) return 'notch';
  if (safeTop >= 16) return 'status';
  // iOS 兜底：实测为 0 时按屏幕尺寸推断（老机型 / 首次布局）
  if (os === 'ios') {
    const d = IPHONE_SCREEN_MAP.find(
      (m) => Math.abs(m.w - window.screen.width) <= 2 && Math.abs(m.h - window.screen.height) <= 2
    );
    if (d) return d.cutout;
  }
  return 'none';
}

function classifyNav(safeBottom) {
  if (safeBottom >= 20) return 'gesture';
  if (safeBottom > 0) return 'buttons';
  return 'none';
}

/** 解析 Android UA 中的机型代号：`Android 13; SM-G991B Build/...` */
function androidModel(ua) {
  const m = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build[/)]|\s*\))/i);
  if (!m) return '';
  return m[1].trim().replace(/\s+Build$/i, '');
}

function androidFamily(model, ua) {
  const src = `${model} ${ua}`;
  const hit = ANDROID_FAMILY_RULES.find((r) => r.re.test(src));
  return hit ? hit.family : 'android';
}

/**
 * 采集设备画像。返回对象同时挂到全局 DEVICE_PROFILE 便于调试。
 */
export function detectDeviceProfile() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isCapacitor = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    ? window.Capacitor.isNativePlatform()
    : window.Capacitor);

  const safe = resolveSafeAreas();

  let os = 'desktop';
  let family = 'desktop';
  let model = '';

  if (isIOS) {
    os = 'ios';
    const screenHit = IPHONE_SCREEN_MAP.find(
      (m) => Math.abs(m.w - window.screen.width) <= 2 && Math.abs(m.h - window.screen.height) <= 2
    );
    if (screenHit) model = screenHit.model;
    if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !model)) {
      family = 'ipad';
      model = model || 'iPad';
    } else {
      family = 'iphone';
      model = model || 'iPhone';
    }
  } else if (isAndroid) {
    os = 'android';
    model = androidModel(ua);
    family = androidFamily(model, ua);
  }

  const cutout = classifyCutout(safe.top, os);
  const nav = classifyNav(safe.bottom);

  const profile = {
    os,
    family,
    model: model || (os === 'desktop' ? 'Desktop' : 'Unknown'),
    cutout,
    nav,
    safe,
    isCapacitor,
    isStandalone: window.matchMedia?.('(display-mode: standalone)').matches || false,
    dpr: window.devicePixelRatio || 1,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };

  window.DEVICE_PROFILE = profile;
  return profile;
}

/**
 * 应用画像：写 data-* 标记 + 实测安全区变量（CSS 用 max() 与 env() 取较大值，不会互相覆盖）。
 */
let appliedSignature = '';

export function applyDeviceProfile() {
  const profile = detectDeviceProfile();
  const root = document.documentElement;
  const { top, bottom, left, right } = profile.safe;

  // 校准会连续调用多次（首帧 / load / 字体就绪 / 视口变化），
  // 结果没变就不再写 DOM，避免每次都触发全树样式重算。
  const signature = [
    profile.os, profile.family, profile.cutout, profile.nav, profile.model,
    profile.isCapacitor, profile.isStandalone, top, bottom, left, right,
  ].join('|');
  if (signature === appliedSignature) return profile;
  appliedSignature = signature;

  const set = (attr, val) => root.setAttribute(attr, val);
  set('data-device-os', profile.os);
  set('data-device-family', profile.family);
  set('data-cutout', profile.cutout);
  // 注意属性名：不能叫 data-nav —— 底部导航按钮也用 data-nav 标识目标页面，
  // 全局选择器 [data-nav] 会把 <html> 一起选中，导致任意点击都冒泡触发页面跳转。
  set('data-device-nav', profile.nav);
  set('data-device-model', profile.model);
  root.classList.toggle('is-native', profile.isCapacitor);
  root.classList.toggle('is-standalone', profile.isStandalone);

  const rs = root.style;
  rs.setProperty('--sa-top', `${top}px`);
  rs.setProperty('--sa-bottom', `${bottom}px`);
  rs.setProperty('--sa-left', `${left}px`);
  rs.setProperty('--sa-right', `${right}px`);

  return profile;
}

export default { detectDeviceProfile, applyDeviceProfile };