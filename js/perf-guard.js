/**
 * APEXON Weather - 帧率守卫（自适应画质）
 *
 * 线上反馈：120Hz 屏幕上动画「连 30 帧都不到」。
 * 根因不是动画本身写错了，而是首屏同时叠了太多合成器负担：
 * 全屏视频解码 + 几十处 backdrop-filter（每处都要重新采样背景）+ 无限循环动效。
 * 中低端机或系统调度保守时，合成线程直接掉到 20 多帧。
 *
 * 这里不去猜机型，而是实测：加载完成后静默采样 rAF 帧间隔，
 * 再结合「滚动时」的帧率做一次判定，结果写到 <html data-perf>：
 *   high —— 保持全部效果（视频、毛玻璃、粒子）
 *   mid  —— 关掉视频与大面积毛玻璃，保留淡入淡出
 *   low  —— 只留静态背景与最基础的过渡，滚动优先
 * 判定结果缓存 7 天，避免每次冷启动都降级；用户手动切换动效时立即重测。
 */

const PERF_KEY = 'apexon_perf_tier_v2';
const SAMPLE_MS = 900;
const MID_FRAME_MS = 22;   // < 45fps  → mid
const LOW_FRAME_MS = 33;   // < 30fps  → low
const TTL_MS = 7 * 24 * 3600 * 1000;

function applyTier(tier) {
  const root = document.documentElement;
  if (root.dataset.perf !== tier) {
    root.dataset.perf = tier;
  }
}

function readCached() {
  try {
    const raw = localStorage.getItem(PERF_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.tier || !saved.at) return null;
    if (Date.now() - saved.at > TTL_MS) return null;
    return saved.tier;
  } catch (e) {
    return null;
  }
}

function saveTier(tier) {
  try {
    localStorage.setItem(PERF_KEY, JSON.stringify({ tier, at: Date.now() }));
  } catch (e) {
    // 隐私模式：只影响下次冷启动的初值
  }
}

/** 采样一段时间内的 rAF 帧间隔，返回平均帧时长（ms） */
function sampleFrameTime(duration = SAMPLE_MS) {
  return new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    const start = last;
    function tick(now) {
      frames.push(now - last);
      last = now;
      if (now - start < duration) {
        requestAnimationFrame(tick);
      } else {
        // 丢掉前 3 帧：通常是首帧抖动或样式重算，不代表稳定帧率
        const usable = frames.slice(3).filter((n) => n > 0 && n < 200);
        if (usable.length < 10) {
          resolve(0); // 样本太少，判定为「测不到」，不做降级
          return;
        }
        const sum = usable.reduce((a, b) => a + b, 0);
        resolve(sum / usable.length);
      }
    }
    requestAnimationFrame(tick);
  });
}

function tierFor(frameMs) {
  if (!frameMs) return null;
  if (frameMs >= LOW_FRAME_MS) return 'low';
  if (frameMs >= MID_FRAME_MS) return 'mid';
  return 'high';
}

/**
 * 跑一次判定。传 force=true 时忽略缓存（用户改动了动效设置后调用）。
 */
export async function runPerfProbe(force = false) {
  if (!force) {
    const cached = readCached();
    if (cached) {
      applyTier(cached);
      // 缓存只用来避免「每次冷启动都重新降级」，但允许实测更好时升回去：
      // 低档位会关掉全部装饰动画，一旦设备被上一版的掉帧误判过一次，
      // 用户就会连续 7 天看到「没有动画」的界面，必须能自愈。
      if (cached === 'high') return cached;
    }
  }
  // 页面在后台时不采样：后台标签页 rAF 会被节流，结论完全失真
  if (document.hidden) return null;

  const idle = await sampleFrameTime();
  const measured = tierFor(idle);
  const current = document.documentElement.dataset.perf || 'high';
  // 只升不降：降档交给滚动实测，静置采样更适合「恢复」误判
  const tier = measured && ORDER[measured] > ORDER[current] ? measured : current;
  applyTier(tier || 'high');
  if (tier) saveTier(tier);
  return tier;
}

/**
 * 滚动实测。
 *
 * 静置采样测的是「不动的时候有多顺」：120Hz 屏静置几乎永远满帧，
 * 判定就会一直是 high，真正滚动时的掉帧反倒没被计入，
 * 于是出现「检测说是高画质，用起来却连 60 帧都不到」。
 * 这里在真实滚动时采样 1.2 秒，掉到 45fps 以下当场降档。
 * 只降不升：滚动体感比静置更接近用户感受，也避免来回切换。
 *
 * 采样 3 次而不是 1 次：首屏顶部内容少，往往能跑到满帧；
 * 真正的问题在列表尾部（卡片最多、场景层还在合成）。
 * 只测第一次滚动会得出「这机器很行」的错误结论，然后一直挂着最高画质，
 * 用户滑到底部就掉到 20 多帧。多次采样取最差的一次，才能覆盖整页。
 */
const SCROLL_SAMPLE_MS = 1200;
const MAX_SESSIONS = 3;
const ORDER = { low: 0, mid: 1, high: 2 };

function initScrollProbe() {
  let sessions = 0;
  let sampling = false;
  const frames = [];

  const finish = () => {
    sampling = false;
    sessions += 1;
    const usable = frames.slice(4).filter((n) => n > 0 && n < 200);
    if (usable.length < 15) return;
    const avg = usable.reduce((a, b) => a + b, 0) / usable.length;
    const tier = tierFor(avg);
    if (!tier) return;
    const current = document.documentElement.dataset.perf || 'high';
    if (ORDER[tier] < ORDER[current]) {
      applyTier(tier);
      saveTier(tier);
    }
  };

  let last = 0;
  const tick = (now) => {
    if (!sampling) return;
    if (last) frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };

  document.addEventListener('scroll', () => {
    if (sessions >= MAX_SESSIONS || sampling) return;
    sampling = true;
    last = 0;
    frames.length = 0;
    requestAnimationFrame(tick);
    setTimeout(finish, SCROLL_SAMPLE_MS);
  }, { passive: true, capture: true });
}

/** 启动：首屏稳定后采样一次；用户切回前台且尚未测过时补测 */
export function initPerfGuard() {
  const cached = readCached();
  if (cached) {
    applyTier(cached);
  }
  initScrollProbe();
  const start = () => {
    // 等首屏布局、视频解码、接口回填都落定后再测，避免把「启动阶段的忙」当成设备弱
    setTimeout(() => { runPerfProbe(false); }, 2200);
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

initPerfGuard();
