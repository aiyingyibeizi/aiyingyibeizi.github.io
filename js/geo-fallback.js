/**
 * IP 兜底定位。
 *
 * 手机端有系统定位，网页端（尤其非 HTTPS 的本地预览）经常拿不到：
 * 浏览器要求安全上下文、用户可能拒绝授权、桌面机还可能根本没用过定位。
 * 这时退一步，用出口 IP 估一个城市级位置——精度只到城市，但足够显示天气。
 *
 * 走自建 Cloudflare Worker 的 /geo：
 *   优先用 request.cf（Cloudflare 自带的 IP 地理位置，快且不额外请求第三方），
 *   缺失时 Worker 内部再查 ipapi.co。前端只认一个地址，不直连第三方。
 */

import { CONFIG } from './config.js';

function base() {
  return String(CONFIG.bondApiBase || 'https://weather-api.apexon.qzz.io').replace(/\/+$/, '');
}

/**
 * @returns {Promise<{lat:number, lon:number, city:string, region:string, country:string, timezone:string}>}
 * @throws 拿不到坐标时抛错，由调用方决定是否提示用户
 */
export async function locateByIp(timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${base()}/geo`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`geo http ${res.status}`);
    const data = await res.json();
    const lat = Number(data?.lat);
    const lon = Number(data?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('geo empty');
    return {
      lat,
      lon,
      city: String(data?.city || ''),
      region: String(data?.region || ''),
      country: String(data?.country || ''),
      timezone: String(data?.timezone || ''),
    };
  } finally {
    clearTimeout(timer);
  }
}
