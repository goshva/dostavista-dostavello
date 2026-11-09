/**
 * HAR-инструмент: разбор захваченного трафика и авто-обнаружение API.
 *
 * Зачем: курьерская сторона Достависты (мобильное приложение) недокументирована.
 * Универсальный путь — один раз записать трафик и получить карту эндпоинтов,
 * не привязываясь к APK.
 *
 * Как записать HAR:
 *   A. Браузер (Chrome/Edge): DevTools → Network → «Сохранить всё как HAR».
 *      Работает, если пользуетесь веб-кабинетом.
 *   B. Мобильное приложение: mitmproxy в режиме прокси на телефоне
 *        mitmproxy --save-stream-file flow.mitm
 *      затем: mitmdump -nr flow.mitm --set hardump=out.har
 *      (сертификат mitmproxy нужно установить на телефон).
 *   C. Android + Frida — если приложение пинует сертификаты.
 *
 * Затем:  node src/cli.js discover --har captures/flow.har
 */

import fs from 'node:fs';

/** Прочитать HAR-файл (или поток mitmproxy, экспортированный в HAR). */
export function parseHar(input) {
  const raw = typeof input === 'string' && fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : input;
  const json = JSON.parse(raw);
  if (!json?.log?.entries) throw new Error('Это не похоже на HAR: нет log.entries');
  return json.log.entries;
}

/** Заголовки запроса в удобный вид. */
function headersToObject(headers = []) {
  const out = {};
  for (const h of headers) out[String(h.name).toLowerCase()] = h.value;
  return out;
}

/** Тело ответа, если это JSON. */
function responseJson(entry) {
  const text = entry?.response?.content?.text;
  if (!text) return null;
  const mime = entry.response.content.mimeType || '';
  if (!/json/i.test(mime)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Схема JSON: пути ключей до глубины depth. */
export function shapeOf(value, depth = 3, prefix = '') {
  const out = [];
  if (depth < 0) return out;
  if (Array.isArray(value)) {
    if (value.length) out.push(...shapeOf(value[0], depth - 1, `${prefix}[]`));
    else out.push(`${prefix}[]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') out.push(...shapeOf(v, depth - 1, p));
      else out.push(`${p}: ${v === null ? 'null' : typeof v}`);
    }
  }
  return out;
}

const AUTH_HEADER_RE = /^(authorization|x-.*-token|x-.*-auth|x-api-key|cookie|x-csrf-token|x-session)/i;
const INTERESTING_RE = /order|task|shift|courier|route|point|deliver|assign|my|profile|user|login|auth|token/i;

/**
 * Разобрать HAR и построить карту API.
 *
 * @returns {{
 *   hosts: string[], endpoints: Array<object>, authHeaders: object,
 *   orderCandidates: Array<object>, notes: string[]
 * }}
 */
export function discoverFromHar(entries) {
  const endpoints = [];
  const authHeaders = {};
  const hosts = new Set();
  const byKey = new Map();

  for (const e of entries) {
    const req = e?.request;
    if (!req?.url) continue;
    let url;
    try {
      url = new URL(req.url);
    } catch {
      continue;
    }
    // Отсекаем статику и аналитику.
    if (/\.(js|css|png|jpg|jpeg|svg|woff2?|ico|gif|webp)(\?|$)/i.test(url.pathname)) continue;
    if (/google|yandex|mindbox|adjust|facebook|vk\.com|mail\.ru|sentry|analytics|gtm|doubleclick/i.test(url.hostname)) continue;

    hosts.add(url.hostname);
    const headers = headersToObject(req.headers);
    for (const [k, v] of Object.entries(headers)) {
      if (AUTH_HEADER_RE.test(k)) {
        authHeaders[k] = authHeaders[k] || maskSecret(v);
      }
    }

    const key = `${req.method} ${url.hostname}${url.pathname}`;
    const json = responseJson(e);
    const rec = {
      method: req.method,
      host: url.hostname,
      path: url.pathname,
      query: url.search || '',
      status: e?.response?.status ?? null,
      hasRequestBody: Boolean(req.postData?.text),
      requestKeys: req.postData?.text ? safeKeys(req.postData.text) : [],
      responseShape: json ? shapeOf(json, 2) : [],
      contentType: e?.response?.content?.mimeType || '',
    };
    if (!byKey.has(key)) {
      byKey.set(key, { ...rec, hits: 1 });
      endpoints.push(byKey.get(key));
    } else {
      byKey.get(key).hits++;
    }
  }

  const notes = [];
  const orderCandidates = endpoints.filter(
    (x) => INTERESTING_RE.test(x.path) && (x.responseShape.length || x.hasRequestBody)
  );
  if (!endpoints.length) notes.push('В HAR не найдено ни одного API-запроса — проверьте, что захват шёл с нужного приложения.');
  if (!orderCandidates.length) notes.push('Не найдено явных «заказных» эндпоинтов: возможно, список заказов приходит одним общим запросом.');
  const cookieAuth = Object.keys(authHeaders).some((k) => k === 'cookie');
  if (cookieAuth) notes.push('Авторизация cookie-based: перенесите значение cookie сессии в config.local.json → partnerCabinet.session.');

  return {
    hosts: [...hosts],
    endpoints: endpoints.sort((a, b) => b.hits - a.hits),
    authHeaders,
    orderCandidates,
    notes,
  };
}

function safeKeys(text) {
  try {
    return shapeOf(JSON.parse(text), 1);
  } catch {
    return [];
  }
}

function maskSecret(v) {
  const s = String(v);
  if (s.length <= 12) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} симв.)`;
}

/**
 * Провайдер-реплей: отдаёт данные из сохранённого HAR офлайн.
 * Полезен, чтобы обкатать интерфейс и маршрут на реальных (своих) данных.
 */
export class HarReplayProvider {
  static id = 'har';
  static title = 'Реплей захваченного трафика (HAR)';

  constructor(cfg = {}) {
    this.harPath = cfg.harPath || cfg.path;
    this.match = cfg.match || '/partner/courier-info';
    this.entries = this.harPath ? parseHar(this.harPath) : [];
    this.selfCourierId = cfg.courierId ?? null;
  }

  get id() {
    return HarReplayProvider.id;
  }

  async login() {
    return { replay: true };
  }

  async ensureAuth() {
    return this;
  }

  async whoami() {
    return { partner: { fullName: 'Из HAR' }, courierId: this.selfCourierId, replay: true };
  }

  async listCouriers() {
    return { list: [], count: 0 };
  }

  #findResponse(pathFragment) {
    for (const e of this.entries) {
      const url = e?.request?.url || '';
      if (!url.includes(pathFragment)) continue;
      const json = responseJson(e);
      if (json) return json;
    }
    return null;
  }

  async getOrders() {
    const { normalizeOrder } = await import('../lib/model.js');
    const json = this.#findResponse(this.match);
    if (!json) throw new Error(`В HAR нет ответа для «${this.match}». Укажите --match <фрагмент пути>.`);
    const wrap = (arr) => (arr || []).map((o) => normalizeOrder(o, { source: this.id }));
    return {
      courierId: json.courier?.courier_id ?? null,
      courier: json.courier || null,
      orders: wrap(json.orders),
      abandoned: wrap(json.abandoned_orders),
      cancelled: wrap(json.cancelled_orders),
      locations: json.locations || [],
      raw: json,
    };
  }

  async getOrderLocations() {
    return [];
  }

  async getProblems() {
    return { courier: null, problems: [], count: 0 };
  }

  async probe() {
    const d = discoverFromHar(this.entries);
    return d.endpoints.map((e) => ({ name: `${e.method} ${e.path}`, path: e.path, method: e.method, ok: true, keys: e.responseShape.slice(0, 8) }));
  }
}
