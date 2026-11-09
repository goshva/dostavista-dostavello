/**
 * HTTP-клиент для API Достависта.
 *
 * Особенности, выясненные реверсом курьерско-партнёрского кабинета
 * (см. docs/API-COURIER-PARTNER.md):
 *
 *   - Все ответы — JSON в конверте
 *       { is_successful, errors, parameter_errors, session, server_datetime }
 *   - POST-запросы требуют заголовок  X-CSRF-Token, значение которого лежит
 *     в  <meta name="csrf-token" content="...">  на https://partner.dostavista.ru/
 *   - Авторизация — сессия (Flask-подобный подписанный токен). Токен приходит
 *     в поле `session` ответа и должен носиться в cookie `p_session`.
 *   - Тело запроса — JSON, кроме GET.
 *   - Возможен ответ `required_captcha` — тогда нужен ручной вход в браузере.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Простой cookie-jar: хранит пары имя→значение на один хост. */
export class CookieJar {
  constructor(initial = {}) {
    this.cookies = new Map(Object.entries(initial));
  }

  /** Забрать Set-Cookie из ответа fetch. */
  absorb(headers) {
    // В Node у Headers есть getSetCookie(); в остальных случаях парсим вручную.
    const raw =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : splitCombinedSetCookie(headers.get('set-cookie'));
    for (const line of raw) {
      if (!line) continue;
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  set(name, value) {
    if (value == null || value === '') this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  get(name) {
    return this.cookies.get(name);
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  toJSON() {
    return Object.fromEntries(this.cookies);
  }
}

function splitCombinedSetCookie(value) {
  if (!value) return [];
  // Запятые внутри Expires не должны разрывать строку.
  return value.split(/,(?=\s*[^;=]+=)/g);
}

/** Ошибка уровня протокола (HTTP/сеть). */
export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Ошибка уровня приложения: ответ пришёл, но is_successful === false. */
export class ApiError extends Error {
  constructor(errors, { query, parameterErrors, raw } = {}) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(`API ${query || ''} вернул ошибку: ${list.join(', ')}`);
    this.name = 'ApiError';
    this.errors = list;
    this.parameterErrors = parameterErrors || null;
    this.raw = raw;
  }

  get needsCaptcha() {
    return this.errors.includes('required_captcha');
  }

  get notLoggedIn() {
    return this.errors.includes('not_logged_in');
  }

  /** Расшифровка частых кодов. */
  get humanMessage() {
    const map = {
      invalid_credentials: 'Неверный логин или пароль.',
      missing_credentials:
        'Не заданы учётные данные: впишите email/password или cookie сессии (partnerCabinet.session) в config.local.json.',
      not_logged_in: 'Сессия истекла — нужно войти заново.',
      invalid_session: 'Сессия недействительна — нужно войти заново.',
      required_captcha: 'Сервер требует капчу: войдите один раз в браузере и перенесите cookie p_session.',
      invalid_csrf: 'Сервер отклонил CSRF-токен — повторите вход.',
      invalid_parameters: 'Сервер отклонил параметры запроса.',
      access_denied: 'Нет доступа к этому объекту для текущего аккаунта.',
      unknown_method: 'Сервер не знает такого метода — возможно, API изменился (см. docs/API-COURIER-PARTNER.md).',
    };
    const known = this.errors.map((e) => map[e]).filter(Boolean);
    return known.length ? known.join(' ') : this.message;
  }
}

export class ApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl            например https://partner.dostavista.ru
   * @param {object} [opts.cookies]          начальные cookie
   * @param {string} [opts.sessionToken]     готовый p_session
   * @param {boolean} [opts.debug]           печатать запросы
   * @param {number} [opts.retries]
   */
  constructor({ baseUrl, cookies = {}, sessionToken, debug = false, retries = 2, timeoutMs = 30000 } = {}) {
    if (!baseUrl) throw new Error('ApiClient: baseUrl обязателен');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.jar = new CookieJar(cookies);
    if (sessionToken) this.jar.set('p_session', sessionToken);
    this.csrfToken = null;
    this.debug = debug;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.lastServerDatetime = null;
  }

  /** GET / и вытащить csrf-token + cookie сессии. */
  async bootstrap() {
    const res = await this.fetchRaw('/', { method: 'GET', expectJson: false });
    const html = await res.text();
    const m = html.match(/name="csrf-token"\s+content="([^"]+)"/);
    if (!m) {
      throw new HttpError('Не удалось найти csrf-token на странице входа', {
        status: res.status,
        url: `${this.baseUrl}/`,
      });
    }
    this.csrfToken = m[1];
    return this.csrfToken;
  }

  async ensureCsrf() {
    if (!this.csrfToken) await this.bootstrap();
    return this.csrfToken;
  }

  /** Низкоуровневый запрос с cookie и CSRF. */
  async fetchRaw(path, { method = 'GET', body, headers = {}, expectJson = true, csrf = method !== 'GET' } = {}) {
    const url = path.startsWith('http') ? path : this.baseUrl + path;
    const h = { 'User-Agent': DEFAULT_UA, Accept: 'application/json, text/html;q=0.9', ...headers };

    if (body !== undefined) h['Content-Type'] = 'application/json';
    const cookie = this.jar.header();
    if (cookie) h.Cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = await this.ensureCsrf();

    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        const res = await fetch(url, {
          method,
          headers: h,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'follow',
          signal: ctl.signal,
        });
        clearTimeout(timer);
        this.jar.absorb(res.headers);

        if (this.debug) {
          console.error(`→ ${method} ${url} → ${res.status}`);
        }

        if (res.status >= 500 && attempt < this.retries) {
          lastErr = new HttpError(`HTTP ${res.status}`, { status: res.status, url });
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (res.status === 404) {
          throw new HttpError(`HTTP 404: ${url}`, { status: 404, url });
        }
        if (expectJson) {
          const text = await res.text();
          try {
            return { json: JSON.parse(text), status: res.status, url, text };
          } catch {
            throw new HttpError(`Ответ не JSON (HTTP ${res.status})`, { status: res.status, url, body: text.slice(0, 400) });
          }
        }
        return res;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) throw e;
        lastErr = e;
        if (attempt < this.retries) await sleep(400 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /**
   * Вызов API-метода с разбором конверта.
   * @returns данные ответа (весь объект), если is_successful
   */
  async query(path, body = {}, method = 'POST') {
    const opts = { method };
    if (method !== 'GET') opts.body = body;
    const { json, status } = await this.fetchRaw(path, opts);
    this.lastServerDatetime = json.server_datetime || this.lastServerDatetime;

    // Сервер отдаёт свежий session — держим cookie в актуальном состоянии.
    if (json.session && json.is_successful) this.jar.set('p_session', json.session);

    if (!json.is_successful) {
      throw new ApiError(json.errors || ['unknown_error'], {
        query: `${method} ${path}`,
        parameterErrors: json.parameter_errors,
        raw: { status, json },
      });
    }
    return json;
  }
}
