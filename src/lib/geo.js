/**
 * Геометрия, расстояния, геокодинг.
 *
 * Точки из курьерско-партнёрского API уже приходят с latitude/longitude,
 * поэтому геокодинг по умолчанию выключен и нужен только как страховка
 * для источников без координат.
 */

import fs from 'node:fs';
import path from 'node:path';

const R_EARTH_KM = 6371.0088;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Расстояние по прямой (формула гаверсинуса), км. */
export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Коэффициент удлинения: дороги длиннее прямой примерно на 25–35 % в городе. */
export const ROAD_FACTOR = 1.3;

export function roadKm(a, b) {
  const d = haversineKm(a, b);
  return Number.isFinite(d) ? d * ROAD_FACTOR : d;
}

/** Длина ломаной по списку точек, км. */
export function pathLengthKm(points, distanceFn = roadKm) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = distanceFn(points[i - 1], points[i]);
    if (Number.isFinite(d)) total += d;
  }
  return total;
}

export function formatKm(km) {
  if (km == null || !Number.isFinite(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1)} км`;
}

/** Оценка времени: путь / средняя скорость + обслуживание на точке. */
export function estimateMinutes(km, stopCount, { averageSpeedKmh = 18, serviceMinutesPerStop = 7 } = {}) {
  const travel = (km / Math.max(1, averageSpeedKmh)) * 60;
  return Math.round(travel + stopCount * serviceMinutesPerStop);
}

export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

/**
 * Матрица дорожных расстояний через публичный OSRM (table service).
 * При любой ошибке возвращает null — вызывающий код откатывается на haversine.
 */
export async function osrmMatrix(points, { baseUrl = 'https://router.project-osrm.org', timeoutMs = 8000 } = {}) {
  if (points.length < 2 || points.length > 100) return null;
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `${baseUrl.replace(/\/+$/, '')}/table/v1/driving/${coords}?annotations=distance`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 'Ok' || !json.distances) return null;
    // метры → км
    return json.distances.map((row) => row.map((v) => (v == null ? Infinity : v / 1000)));
  } catch {
    return null;
  }
}

/** Геокодер с файловым кэшем. По умолчанию выключен. */
export class Geocoder {
  constructor({ enabled = false, nominatimUrl, userAgent, cacheDir = '.cache' } = {}) {
    this.enabled = enabled;
    this.nominatimUrl = nominatimUrl || 'https://nominatim.openstreetmap.org/search';
    this.userAgent = userAgent || 'dostavista-dostavello/0.1';
    this.cacheFile = path.join(cacheDir, 'geocode.json');
    this.cache = this.#load();
    this.lastRequestAt = 0;
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch {
      return {};
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch {
      /* кэш — не критично */
    }
  }

  async geocode(address) {
    if (!this.enabled || !address) return null;
    if (this.cache[address]) return this.cache[address];

    // Nominatim: не чаще 1 запроса в секунду.
    const wait = 1100 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();

    const url = `${this.nominatimUrl}?q=${encodeURIComponent(address)}&format=json&limit=1`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
      if (!res.ok) return null;
      const json = await res.json();
      if (!Array.isArray(json) || !json.length) return null;
      const hit = { lat: Number(json[0].lat), lon: Number(json[0].lon) };
      this.cache[address] = hit;
      this.#save();
      return hit;
    } catch {
      return null;
    }
  }

  /** Дозаполнить координаты у точек, у которых их нет. */
  async enrich(orders) {
    if (!this.enabled) return orders;
    for (const o of orders) {
      for (const p of o.points) {
        if (p.hasCoordinates || !p.address) continue;
        const hit = await this.geocode(p.address);
        if (hit) {
          p.lat = hit.lat;
          p.lon = hit.lon;
          p.hasCoordinates = true;
          p.geocoded = true;
        }
      }
    }
    return orders;
  }
}

/** GPX для навигаторов и OsmAnd/ Organic Maps. */
export function toGpx(stops, { name = 'Маршрут курьера' } = {}) {
  const pts = stops
    .filter((s) => s.lat != null)
    .map(
      (s, i) =>
        `  <wpt lat="${s.lat}" lon="${s.lon}"><name>${i + 1}. ${esc(s.address || s.orderId)}</name>` +
        `<desc>Заказ ${esc(s.orderId)} · ${esc(s.role === 'pickup' ? 'забор' : 'доставка')}</desc></wpt>`
    )
    .join('\n');
  const trk = stops
    .filter((s) => s.lat != null)
    .map((s) => `      <trkpt lat="${s.lat}" lon="${s.lon}"></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="dostavista-dostavello" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
${pts}
  <trk><name>${esc(name)}</name><trkseg>
${trk}
  </trkseg></trk>
</gpx>
`;
}

function esc(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
