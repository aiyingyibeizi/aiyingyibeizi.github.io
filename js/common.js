/**
 * APEXON Weather - Common Utilities
 */

import { getLanguage, t } from './i18n.js';

/** Intl 使用的语言代码（与世界绝大多数 BCP-47 代码一致） */
function intlLocale() {
  return getLanguage();
}

/**
 * Throttle a function to run at most once per wait period.
 */
export function throttle(fn, wait = 16) {
  let last = 0;
  let timer = null;
  return function (...args) {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

/**
 * Debounce a function.
 */
export function debounce(fn, wait = 280) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Request a single animation frame, returns a promise.
 */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Run callback on next animation frame, batching DOM reads/writes.
 */
export function rafBatch(read, write) {
  requestAnimationFrame(() => {
    const values = read ? read() : undefined;
    requestAnimationFrame(() => {
      if (write) write(values);
    });
  });
}

/**
 * Format temperature with unit.
 */
export function formatTemp(value, unit = '°') {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  return `${Math.round(value)}${unit}`;
}

/**
 * Format a date string from API (yyyy-MM-dd or ISO).
 */
export function formatDate(dateInput, options = {}) {
  if (!dateInput) return '--';
  // ISO 带时间直接用 Date 解析；纯日期 'yyyy-MM-dd' 转本地日期避免时区偏移
  const date = new Date(dateInput.includes('T') ? dateInput : dateInput.replace(/-/g, '/'));
  if (Number.isNaN(date.getTime())) return '--';

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) return t('date.today');
  if (isTomorrow) return t('date.tomorrow');

  const { weekday = 'short', month = false, day = true } = options;
  const formatter = new Intl.DateTimeFormat(intlLocale(), {
    weekday,
    month: month ? 'short' : undefined,
    day: day ? 'numeric' : undefined,
  });
  return formatter.format(date);
}

/**
 * Format hour from API datetime.
 */
export function formatHour(dateInput) {
  if (!dateInput) return '--';
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Format update time.
 */
export function formatUpdateTime(dateInput) {
  if (!dateInput) return '';
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(intlLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * 相对时间："刚刚 / 3 分钟前 / 2 小时前 / 1 天前"。
 * 观测时间一般不会超过一天，仅在异常时回退到绝对时间。
 */
export function formatRelativeTime(dateInput) {
  if (!dateInput) return '';
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '';
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return t('time.justNow');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('time.minutesAgo', diffMin);
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('time.hoursAgo', diffHour);
  const diffDay = Math.floor(diffHour / 24);
  return t('time.daysAgo', diffDay);
}

/**
 * Get weekday label.
 */
export function getWeekday(dateInput) {
  if (!dateInput) return '--';
  const date = new Date(dateInput.includes('T') ? dateInput : dateInput.replace(/-/g, '/'));
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString(intlLocale(), { weekday: 'long' });
}

/**
 * Simple DOM selector helper.
 */
export function $(selector, context = document) {
  return context.querySelector(selector);
}

export function $$(selector, context = document) {
  return Array.from(context.querySelectorAll(selector));
}

/**
 * Create an element with attributes and children.
 */
export function createElement(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'className') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  });
  children.forEach((child) => {
    if (child == null) return;
    if (typeof child === 'string' || typeof child === 'number') el.appendChild(document.createTextNode(String(child)));
    else if (child instanceof Node) el.appendChild(child);
  });
  return el;
}

/**
 * SVG icon helper.
 */
export function svgIcon(name, attrs = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  Object.entries(attrs).forEach(([k, v]) => svg.setAttribute(k, v));

  const paths = {
    mapPin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    search: 'M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
    x: 'M18 6L6 18M6 6l12 12',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
    home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    sun: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    droplet: 'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z',
    wind: 'M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    gauge: 'M12 2v4M12 18a6 6 0 0 0 6-6c0-1-.5-2.7-1.5-3.5a1 1 0 0 0-1.3.1L12 12V6.5',
    cloudRain: 'M16 13v8M8 13v8M12 15v8M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25',
    cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
    thermometer: 'M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z',
    sunrise: 'M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4-4-4 4',
    sunset: 'M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 5l-4 4-4-4',
    arrowRight: 'M5 12h14M12 5l7 7-7 7',
    trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    menu: 'M3 12h18M3 6h18M3 18h18',
    navigation: 'M3 11l19-9-9 19-2-8-8-2z',
    alertCircle: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 8v4M12 16h.01',
    refreshCw: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  };

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths[name] || '');
  svg.appendChild(path);
  return svg;
}

/**
 * LocalStorage wrapper with JSON parsing.
 */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch { /* ignore */ }
  },
};

/**
 * Sleep helper.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clamp value.
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Detect touch device.
 */
export function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Detect reduced motion preference.
 */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * FPS monitor.
 */
export function createFpsMonitor(callback) {
  let frameCount = 0;
  let lastTime = performance.now();
  let rafId = null;

  function loop() {
    frameCount += 1;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const fps = Math.round((frameCount * 1000) / (now - lastTime));
      if (callback) callback(fps);
      frameCount = 0;
      lastTime = now;
    }
    rafId = requestAnimationFrame(loop);
  }

  rafId = requestAnimationFrame(loop);

  return {
    stop() {
      if (rafId) cancelAnimationFrame(rafId);
    },
  };
}
