/**
 * Аудит карты эндпоинтов против ЖИВОГО сервера.
 *
 * Зачем. Пути и имена параметров восстановлены из бандла кабинета — это
 * реконструкция, а не документация. Аудит проверяет её фактами: каждому
 * эндпоинту отправляется РЕАЛЬНОЕ тело запроса, которое использует коннектор,
 * и ответ сервера классифицируется.
 *
 * Ключевая идея: сервер валидирует параметры ДО проверки авторизации.
 * Поэтому без всякой сессии видно:
 *   - `not_logged_in`      → путь и метод верны (барьер только вход);
 *   - `invalid_parameters` → маршрут есть, но имена/значения параметров неверны,
 *                            и сервер прямо говорит, какие именно;
 *   - `unknown_method`/404 → путь неверен;
 *   - `is_successful`      → метод отдал данные без входа (о таком надо знать).
 *
 * Безопасность. Аудитор трогает ТОЛЬКО эндпоинты из белого списка ниже —
 * заведомо читающие. Всё остальное (создание и правка курьеров, смена партнёра,
 * выход, восстановление пароля, формирование файлов) пропускается: отправлять
 * на боевой сервер изменяющие запросы инструмент не должен.
 * Неизвестные эндпоинты по умолчанию тоже пропускаются — отказ безопасен.
 */

import { ApiError, HttpError } from './http.js';

/**
 * Белый список: имена эндпоинтов из ENDPOINTS, которые только читают данные.
 * Ничего, что меняет состояние на сервере, здесь быть не должно.
 */
export const READ_ONLY_ENDPOINTS = new Set([
  'myProfile',
  'partnersAllowedToSwitch',
  'adminPartners',
  'couriers',
  'courierBindings',
  'courierCountries',
  'getCourierProfile',
  'couriersOnMap',
  'courierInfo',
  'orderLocations',
  'courierProblems',
  'commissionHistory',
  'reports',
  'availableReports',
  'getInstructionUrl',
]);

/**
 * Представительные тела запросов — ровно в том виде, в каком их отправляет
 * коннектор. Значения выдуманные, но синтаксически корректные.
 */
export function sampleBody(name, { courierId = 1, date = new Date() } = {}) {
  const ymd = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const from = new Date(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(date);
  to.setHours(23, 59, 59, 0);
  const iso = (x) => {
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    const off = -x.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return (
      `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}` +
      `T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}` +
      `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
    );
  };

  switch (name) {
    case 'couriers':
      return {
        work_started_date_from: ymd(new Date(Date.now() - 30 * 86400000)),
        work_started_date_till: ymd(new Date()),
        status: null,
        search_text: null,
        offset: 0,
        limit: 1,
      };
    case 'courierBindings':
      return { status: null, phone: null, offset: 0, limit: 1 };
    case 'getCourierProfile':
    case 'courierProblems':
      return name === 'courierProblems'
        ? { courier_id: courierId, limit: 1, offset: 0 }
        : { courier_id: courierId };
    case 'couriersOnMap':
      return {
        is_active: true,
        has_order: false,
        east_south_latitude: 55.5,
        east_south_longitude: 37.3,
        north_west_latitude: 55.9,
        north_west_longitude: 37.9,
      };
    case 'courierInfo':
      return { courier_id: courierId, from_datetime: iso(from), to_datetime: iso(to) };
    case 'orderLocations':
      return { order_id: 1 };
    case 'reports':
      return {
        from_date: ymd(new Date(Date.now() - 30 * 86400000)),
        till_date: ymd(new Date()),
      };
    default:
      return {};
  }
}

/** Вердикты аудита. */
export const VERDICTS = {
  ROUTE_OK: 'route-ok',
  PARAMS_WRONG: 'params-wrong',
  PATH_WRONG: 'path-wrong',
  METHOD_WRONG: 'method-wrong',
  OPEN: 'no-auth-needed',
  UNKNOWN_RESPONSE: 'unknown-response',
  NETWORK_ERROR: 'network-error',
};

/**
 * Классифицировать результат одного запроса.
 * @param {object} p
 * @param {object|null} [p.apiError]   поймана ли ApiError и с какими кодами
 * @param {object|null} [p.httpError]  поймана ли HttpError (HTTP-статус)
 * @param {object} [p.data]            успешный ответ, если он был
 */
export function classify({ apiError, httpError, data } = {}) {
  if (httpError) {
    if (httpError.status === 404) return { verdict: VERDICTS.PATH_WRONG, detail: 'HTTP 404' };
    if (httpError.status === 405) return { verdict: VERDICTS.METHOD_WRONG, detail: 'HTTP 405' };
    if (httpError.status === 403) return { verdict: VERDICTS.ROUTE_OK, detail: 'HTTP 403 (нужна авторизация)' };
    if (httpError.status === 401) return { verdict: VERDICTS.ROUTE_OK, detail: 'HTTP 401' };
    return { verdict: VERDICTS.NETWORK_ERROR, detail: httpError.message };
  }
  if (apiError) {
    const codes = apiError.errors || [];
    if (codes.includes('not_logged_in') || codes.includes('access_denied')) {
      return { verdict: VERDICTS.ROUTE_OK, detail: codes.join(',') };
    }
    if (codes.includes('invalid_parameters')) {
      return {
        verdict: VERDICTS.PARAMS_WRONG,
        detail: JSON.stringify(apiError.parameterErrors ?? {}),
      };
    }
    if (codes.includes('unknown_method') || codes.includes('method_not_found')) {
      return { verdict: VERDICTS.PATH_WRONG, detail: codes.join(',') };
    }
    return { verdict: VERDICTS.UNKNOWN_RESPONSE, detail: codes.join(',') || 'нет кодов' };
  }
  if (data) {
    return { verdict: VERDICTS.OPEN, detail: `ключи: ${Object.keys(data).slice(0, 6).join(', ')}` };
  }
  return { verdict: VERDICTS.UNKNOWN_RESPONSE, detail: 'пустой результат' };
}

/** Пути-пустышки для отрицательного контроля. Их заведомо не существует. */
export const CONTROL_PATHS = [
  ['GET', '/partner/definitely-not-a-method'],
  ['POST', '/partner/courier-info-typo'],
];

/**
 * Отрицательный контроль: убедиться, что несуществующие пути сервер отвергает
 * иначе, чем настоящие. Без этого `not_logged_in` ничего не доказывает — вдруг
 * сервер отвечает так на всё подряд.
 *
 * На живом сервере (проверено) пустышки дают HTTP 404, а реальные эндпоинты —
 * HTTP 200 с `not_logged_in`. Значит признак содержателен.
 */
export async function runControl(client, { delayMs = 400 } = {}) {
  const results = [];
  for (const [method, path] of CONTROL_PATHS) {
    let verdict;
    try {
      const data = await client.query(path, {}, method);
      verdict = classify({ data }).verdict;
    } catch (e) {
      if (e instanceof ApiError) verdict = classify({ apiError: e }).verdict;
      else if (e instanceof HttpError) verdict = classify({ httpError: e }).verdict;
      else verdict = VERDICTS.NETWORK_ERROR;
    }
    results.push({ method, path, verdict });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  // Контроль пройден, если ни один выдуманный путь не выглядит как настоящий.
  const valid = results.every((r) => r.verdict !== VERDICTS.ROUTE_OK && r.verdict !== VERDICTS.OPEN);
  return { valid, results };
}

/**
 * Прогнать аудит.
 *
 * @param {import('./http.js').ApiClient} client
 * @param {Record<string, {method:string,path:string,note?:string}>} endpoints
 * @param {object} [opts]
 * @param {number} [opts.delayMs] пауза между запросами, чтобы не частить
 * @param {(row:object)=>void} [opts.onResult] вызывается по мере готовности
 */
export async function auditEndpoints(client, endpoints, { delayMs = 400, onResult, courierId = 1 } = {}) {
  const rows = [];
  const names = Object.keys(endpoints).filter((n) => READ_ONLY_ENDPOINTS.has(n));

  for (const name of names) {
    const ep = endpoints[name];
    const body = ep.method === 'GET' ? {} : sampleBody(name, { courierId });
    const started = Date.now();
    let row;
    try {
      const data = await client.query(ep.path, body, ep.method);
      row = { name, ...ep, ms: Date.now() - started, ...classify({ data }), ok: true };
    } catch (e) {
      if (e instanceof ApiError) {
        row = { name, ...ep, ms: Date.now() - started, ...classify({ apiError: e }), params: e.parameterErrors || null };
      } else if (e instanceof HttpError) {
        row = { name, ...ep, ms: Date.now() - started, ...classify({ httpError: e }) };
      } else {
        row = { name, ...ep, ms: Date.now() - started, verdict: VERDICTS.NETWORK_ERROR, detail: e?.message || String(e) };
      }
    }
    row.ok = row.verdict === VERDICTS.ROUTE_OK || row.verdict === VERDICTS.OPEN;
    rows.push(row);
    if (onResult) onResult(row);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  const summary = {
    total: rows.length,
    routeOk: rows.filter((r) => r.verdict === VERDICTS.ROUTE_OK).length,
    open: rows.filter((r) => r.verdict === VERDICTS.OPEN).length,
    paramsWrong: rows.filter((r) => r.verdict === VERDICTS.PARAMS_WRONG).length,
    pathWrong: rows.filter((r) => r.verdict === VERDICTS.PATH_WRONG).length,
    methodWrong: rows.filter((r) => r.verdict === VERDICTS.METHOD_WRONG).length,
    other: rows.filter((r) => !['route-ok', 'no-auth-needed', 'params-wrong', 'path-wrong', 'method-wrong'].includes(r.verdict)).length,
  };
  return { rows, summary, skipped: Object.keys(endpoints).filter((n) => !READ_ONLY_ENDPOINTS.has(n)) };
}
