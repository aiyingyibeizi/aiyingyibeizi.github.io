/**
 * APEXON Weather - API Layer
 *
 * Wraps QWeather API with caching, proxy support and fallback handling.
 */

import { CONFIG, buildUrl, buildV1Url } from './config.js';
import { fetchWithCache } from './cache.js';
import { getLanguage } from './i18n.js';

/**
 * 把应用内语言代码映射为和风天气 API 的 lang 参数。
 * 和风支持的取值：zh / zh-hant / en / ja / ko / fr / de / es / pt / ru 等。
 * 未映射的语言回退到 en，避免 API 返回中文。
 */
const QWEATHER_LANG_MAP = {
  'zh-CN': 'zh',
  'zh-TW': 'zh-hant',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  pt: 'pt',
  ru: 'ru',
};

/** 当前请求应使用的和风 lang 值 */
function apiLang() {
  const lang = getLanguage();
  return QWEATHER_LANG_MAP[lang] || 'en';
}

/** 在参数对象中注入 lang，使 API 返回的文案跟随应用语言 */
function withLang(params = {}) {
  return { ...params, lang: apiLang() };
}

/**
 * 新版接口的坐标路径段：{latitude}/{longitude}（注意纬度在前）。
 *
 * 和风 2026 起把空气质量与灾害预警改为路径传坐标，不再接受 location=城市ID。
 * 这里兼容两种入参：GeoAPI 返回的城市对象（含 lon/lat），以及 {longitude, latitude}。
 * 小数位统一裁到 2 位 —— 和风对超长精度会直接判参数非法。
 * 拿不到有效坐标时返回空串，调用方据此跳过请求（避免发一次注定 400 的请求白耗每日额度）。
 */
function coordPath(location) {
  const src = location && typeof location === 'object' ? location : {};
  const lon = src.lon ?? src.longitude;
  const lat = src.lat ?? src.latitude;
  if (lon == null || lat == null || lon === '' || lat === '') return '';
  const n = Number(lon);
  const m = Number(lat);
  if (!Number.isFinite(n) || !Number.isFinite(m)) return '';
  return `${m.toFixed(2)}/${n.toFixed(2)}`;
}

/** 把 ISO 时间串转成本地日期 YYYY-MM-DD（趋势面板按「天」展示） */
function localDateOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 预警时间格式化到「MM-DD HH:MM」，与旧接口 pubTime 的展示粒度一致 */
function formatAlertTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const parsers = {
  geoSearch(data) {
    if (data.code !== '200') throw new Error(data.message || 'Geo search failed');
    return data.location || [];
  },
  realtime(data) {
    if (data.code !== '200') throw new Error(data.message || 'Realtime weather failed');
    return data.now;
  },
  hourly(data) {
    if (data.code !== '200') throw new Error(data.message || 'Hourly forecast failed');
    return data.hourly || [];
  },
  daily(data) {
    if (data.code !== '200') throw new Error(data.message || 'Daily forecast failed');
    return data.daily || [];
  },
  airQuality(data) {
    // 新版 /airquality/v1/current 返回 indexes[]（同时含多套标准）+ pollutants[]，
    // 与旧接口的 now 结构完全不同，这里统一映射回旧字段名，UI 层无需改动。
    const indexes = Array.isArray(data?.indexes) ? data.indexes : [];
    // cn-mee = 中国 AQI 标准，与旧接口的 aqi 口径一致；缺失时退回第一项
    const cn = indexes.find((i) => i && i.code === 'cn-mee') || indexes[0];
    if (!cn) return null;

    // 污染物浓度在 pollutants[] 里各自带单位，按 code 建表后取值
    const conc = {};
    (Array.isArray(data.pollutants) ? data.pollutants : []).forEach((p) => {
      const v = p?.concentration?.value;
      if (p?.code && v != null) conc[p.code] = v;
    });

    return {
      aqi: cn.aqiDisplay ?? cn.aqi,
      level: cn.level || '',
      category: cn.category || '',
      primary: cn.primaryPollutant?.name || cn.primaryPollutant?.fullName || '',
      pm2p5: conc.pm2p5 ?? null,
      pm10: conc.pm10 ?? null,
      o3: conc.o3 ?? null,
      so2: conc.so2 ?? null,
      no2: conc.no2 ?? null,
      co: conc.co ?? null,
    };
  },
  airForecast(data) {
    // 新版 /airquality/v1/daily 返回 days[]，输出结构与旧接口对齐
    // （fxDate/aqi/primaryPollutant），趋势面板无需改动。
    // 注意能力缩水：免费套餐只给 3 天，旧接口是 5 天，面板本身已兼容少于此数。
    const days = Array.isArray(data?.days) ? data.days : [];
    return days
      .map((d) => {
        const list = Array.isArray(d?.indexes) ? d.indexes : [];
        const cn = list.find((i) => i && i.code === 'cn-mee') || list[0];
        return {
          // forecastStartTime 是 UTC（如 2026-10-15T16:00Z），
          // 换算成本地日期才是用户眼中的「今天」
          fxDate: localDateOf(d?.forecastStartTime),
          aqi: cn?.aqiDisplay ?? cn?.aqi ?? null,
          primaryPollutant: cn?.primaryPollutant?.name || cn?.primaryPollutant?.fullName || '',
        };
      })
      .filter((d) => d.fxDate);
  },
  minutely(data) {
    if (data.code !== '200') return null;
    return data.minutely || [];
  },
  indices(data) {
    if (data.code !== '200') {
      console.warn('[APEXON API] 生活指数请求失败，响应码:', data.code, data.msg || '');
      return [];
    }
    console.log('[APEXON API] 生活指数返回:', data.daily?.length || 0, '条');
    return data.daily || [];
  },
  warning(data) {
    // 新版 /weatheralert/v1/current 返回 alerts[]，同样映射回旧字段名
    // （title/pubTime/text/severityColor），预警卡片无需改动。
    const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
    return alerts
      .filter((a) => (a?.messageType?.code || 'alert') !== 'cancel')
      .map((a) => ({
        id: a.id || '',
        title: a.headline || a.eventType?.name || '',
        // 优先用发布时间；个别预警没有 issuedTime 时退回生效时间
        pubTime: formatAlertTime(a.issuedTime || a.effectiveTime || a.onsetTime),
        text: a.instruction || a.description || a.criteria || '',
        // color.code 就是 blue/yellow/orange/red，直接对接预警等级配色
        severityColor: a.color?.code || '',
      }));
  },
  astronomy(data) {
    if (data.code !== '200') return null;
    // 和风返回 "2026-09-27T06:06+08:00"，统一归一化为 "HH:MM"
    const toHm = (v) => {
      if (!v || typeof v !== 'string') return null;
      const m = v.match(/T(\d{2}):(\d{2})/);
      return m ? `${m[1]}:${m[2]}` : null;
    };
    const sunrise = toHm(data.sunrise);
    const sunset = toHm(data.sunset);
    if (!sunrise || !sunset) return null;
    return {
      sunrise,
      sunset,
      moonrise: toHm(data.moonrise),
      moonset: toHm(data.moonset),
      moonPhase: data.moonPhase || [],
    };
  },
};

/** 本地日期 YYYYMMDD（和风 astronomy 接口要求） */
function todayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * Search cities by keyword.
 */
export async function searchCities(keyword, options = {}) {
  const { number = CONFIG.maxSearchResults } = options;
  const url = buildUrl('/city/lookup', withLang({ location: keyword, number }));
  return fetchWithCache(url, { type: 'geo', keyword, number }, {
    ttlMs: CONFIG.cacheTtl.geoSearch,
    parser: parsers.geoSearch,
  });
}

/**
 * Search city by coordinates (reverse geocoding).
 */
export async function searchCityByCoords(longitude, latitude) {
  const url = buildUrl('/city/lookup', withLang({ location: `${longitude},${latitude}` }));
  const results = await fetchWithCache(url, { type: 'geo', loc: `${longitude},${latitude}` }, {
    ttlMs: CONFIG.cacheTtl.geoSearch,
    parser: parsers.geoSearch,
  });
  return results[0] || null;
}

/**
 * Get top cities (hot cities).
 */
export async function getTopCities(number = CONFIG.defaultCityCount) {
  const url = buildUrl('/city/top', withLang({ number, range: 'cn' }));
  return fetchWithCache(url, { type: 'geo', top: number }, {
    ttlMs: CONFIG.cacheTtl.geoSearch,
    parser: parsers.geoSearch,
  });
}

/**
 * Get realtime weather.
 */
export async function getRealtimeWeather(locationId) {
  const url = buildUrl('/weather/now', withLang({ location: locationId }));
  return fetchWithCache(url, { type: 'realtime', location: locationId }, {
    ttlMs: CONFIG.cacheTtl.realtime,
    parser: parsers.realtime,
  });
}

/**
 * Get 24-hour forecast.
 */
export async function getHourlyForecast(locationId, hours = 24) {
  const endpoint = hours <= 24 ? '/weather/24h' : '/weather/168h';
  const url = buildUrl(endpoint, withLang({ location: locationId }));
  return fetchWithCache(url, { type: 'hourly', hours, location: locationId }, {
    ttlMs: CONFIG.cacheTtl.hourly,
    parser: parsers.hourly,
  });
}

/**
 * Get 7-day forecast.
 */
export async function getDailyForecast(locationId, days = 7) {
  const url = buildUrl(`/weather/${days}d`, withLang({ location: locationId }));
  return fetchWithCache(url, { type: 'daily', days, location: locationId }, {
    ttlMs: CONFIG.cacheTtl.daily,
    parser: parsers.daily,
  });
}

/**
 * Get air quality.
 *
 * 入参是城市对象（含 lon/lat）或 {longitude, latitude} —— 新版接口只认路径坐标。
 * 旧接口 /v7/air/now 已下线（403 Deprecated），这里换成 /airquality/v1/current。
 */
export async function getAirQuality(location) {
  const path = coordPath(location);
  if (!path) return null;
  const url = buildV1Url(`/airquality/v1/current/${path}`, withLang());
  return fetchWithCache(url, { type: 'aqi', loc: path }, {
    ttlMs: CONFIG.cacheTtl.airQuality,
    parser: parsers.airQuality,
  });
}

/**
 * Get air quality daily forecast (趋势对比用).
 *
 * 旧接口 /v7/air/5d 已下线；新版免费套餐只提供 3 天，days 仅用于缓存 key。
 */
export async function getAirQualityForecast(location, days = 3) {
  const path = coordPath(location);
  if (!path) return [];
  const url = buildV1Url(`/airquality/v1/daily/${path}`, withLang());
  return fetchWithCache(url, { type: 'aqiDaily', days, loc: path }, {
    ttlMs: CONFIG.cacheTtl.airQuality,
    parser: parsers.airForecast,
  });
}

/**
 * Get minutely precipitation.
 */
export async function getMinutelyPrecip(longitude, latitude) {
  const url = buildUrl('/minutely/5m', withLang({ location: `${longitude},${latitude}` }));
  return fetchWithCache(url, { type: 'minutely', loc: `${longitude},${latitude}` }, {
    ttlMs: CONFIG.cacheTtl.minutely,
    parser: parsers.minutely,
  });
}

/**
 * Get weather indices / lifestyle.
 */
export async function getIndices(locationId, type = '0') {
  const url = buildUrl('/indices/1d', withLang({ location: locationId, type }));
  return fetchWithCache(url, { type: 'indices', location: locationId }, {
    ttlMs: CONFIG.cacheTtl.indices,
    parser: parsers.indices,
  });
}

/**
 * Get weather warnings.
 *
 * 入参是城市对象（含 lon/lat）。旧接口 /v7/warning/now 已下线，
 * 换成 /weatheralert/v1/current，并让上游直接返回当地时间（localTime=true），
 * 省掉一层时区换算。
 */
export async function getWarnings(location) {
  const path = coordPath(location);
  if (!path) return [];
  const url = buildV1Url(`/weatheralert/v1/current/${path}`, withLang({ localTime: 'true' }));
  return fetchWithCache(url, { type: 'warning', loc: path }, {
    ttlMs: CONFIG.cacheTtl.realtime,
    parser: parsers.warning,
  });
}

/**
 * Get astronomy (sunrise/sunset/moon).
 */
export async function getAstronomy(locationId, date) {
  const url = buildUrl('/astronomy/sunmoon', withLang({ location: locationId, date }));
  return fetchWithCache(url, { type: 'astronomy', location: locationId, date }, {
    ttlMs: CONFIG.cacheTtl.daily,
    parser: parsers.astronomy,
  });
}

/**
 * Get current user geolocation with timeout and caching.
 */
export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        longitude: position.coords.longitude,
        latitude: position.coords.latitude,
        accuracy: position.coords.accuracy,
      }),
      (error) => reject(error),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000, ...options }
    );
  });
}

/**
 * Fetch all weather data for a location in parallel.
 */
export async function fetchWeatherBundle(location) {
  const { id, lon, lat, longitude, latitude } = location;
  const lng = lon ?? longitude;
  const lat2 = lat ?? latitude;
  // 分钟级降水必须和其他请求同批并发：串行 await 会让首屏多等一个 RTT，
  // 而它只是首屏降水条的数据来源，晚到完全不该拖慢主流程。
  const [realtime, hourly, daily, airQuality, warnings, astronomy, minutely] = await Promise.all([
    getRealtimeWeather(id),
    getHourlyForecast(id, 24),
    getDailyForecast(id, 7),
    // 空气质量与预警改走新版接口，需要坐标而不是城市 ID
    getAirQuality(location).catch(() => null),
    getWarnings(location).catch(() => []),
    // 7天预报接口不含日出日落，必须单独取 astronomy
    getAstronomy(id, todayStamp()).catch(() => null),
    // 分钟降水需要经纬度，缺坐标时直接给 null，由前端回退到逐小时数据
    (lng && lat2) ? getMinutelyPrecip(lng, lat2).catch(() => null) : Promise.resolve(null),
  ]);

  // 空气质量趋势与主流程并行，失败只影响趋势面板
  const airForecast = await getAirQualityForecast(location).catch(() => []);

  return {
    location,
    realtime,
    hourly,
    daily,
    airQuality,
    airForecast,
    warnings,
    astronomy,
    minutely,
    fetchedAt: Date.now(),
  };
}
