/**
 * Провайдер «официальный BAPI Достависты» — сторона заказчика (интернет-магазина).
 *
 * ⚠️ ВАЖНО ПО АКТУАЛИЗАЦИИ (проверено живыми запросами 2026-11-09):
 *   Документация (Google Doc «API Dostavista для интернет-магазинов» и PHP-клиент
 *   kstkn/dostavista) указывает боевые адреса
 *       https://dostavista.ru/bapi/...
 *       https://robotapi.dostavista.ru/bapi     (тест)
 *   Сейчас:
 *       robotapi.dostavista.ru  — DNS-записи нет вовсе;
 *       /bapi/* на dostavista.ru, robot.dostavista.ru, robotapitest.dostavista.ru,
 *       partner.dostavista.ru — отвечает 404 ({"error":"Not found"} либо HTML-заглушка
 *       SPA). Ни /api, ни /openapi.json, ни /swagger.json не отдают JSON.
 *   Вывод: публичный BAPI в описанном виде закрыт. Код ниже оставлен как
 *   совместимая реализация задокументированного контракта: если вы получили
 *   токен и рабочий адрес от поддержки — укажите их в config.local.json, и всё
 *   заработает. Для получения СВОИХ заказов как курьера используйте провайдера
 *   partner-cabinet: BAPI отдаёт только заказы, созданные вашим магазином.
 *
 * Проверка живости в любой момент:  node src/cli.js bapi-diagnose
 */

import { ApiError, HttpError } from '../lib/http.js';
import { normalizeOrder, BAPI_STATUS_NAMES } from '../lib/model.js';

/** Задокументированные методы BAPI. */
export const BAPI_METHODS = {
  calculate: { method: 'POST', path: '/bapi/calculate', note: 'Расчёт стоимости заказа' },
  createOrder: { method: 'POST', path: '/bapi/order', note: 'Создание заказа' },
  listOrders: { method: 'GET', path: '/bapi/order', note: 'Список заказов (order_id[] — опционально)' },
  orderInfo: { method: 'GET', path: '/bapi/order/{order_id}', note: 'Информация о заказе (show-points=1)' },
  cancelOrder: { method: 'POST', path: '/bapi/cancel-order', note: 'Отмена заказа' },
  getSettings: { method: 'GET', path: '/bapi/client-settings', note: 'Настройки клиента' },
  setSettings: { method: 'POST', path: '/bapi/client-settings', note: 'Изменение настроек' },
};

/** Статусы и причины отмены — из документации. */
export const CANCEL_SUBSTATUS = {
  NO_COURIER: 1,
  NOT_NEEDED: 3,
  MOVED_TO_ANOTHER_ORDER: 4,
};

export class BapiProvider {
  static id = 'bapi';
  static title = 'Официальный BAPI (сторона заказчика) — по документации сейчас недоступен';

  constructor(cfg = {}, opts = {}) {
    this.baseUrl = (cfg.baseUrl || 'https://robot.dostavista.ru').replace(/\/+$/, '');
    this.clientId = cfg.clientId || '';
    this.token = cfg.token || '';
    this.debug = Boolean(opts.debug);
  }

  get id() {
    return BapiProvider.id;
  }

  get configured() {
    return Boolean(this.clientId && this.token);
  }

  async login() {
    if (!this.configured) throw new ApiError(['missing_credentials'], { query: 'bapi' });
    return { token: true };
  }

  async ensureAuth() {
    return this;
  }

  async #request(method, path, params = {}) {
    const auth = { client_id: this.clientId, token: this.token };
    let url = this.baseUrl + path;
    const init = { method, headers: { Accept: 'application/json', 'User-Agent': 'dostavista-dostavello/0.1' } };

    if (method === 'GET') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...auth, ...params })) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((item) => qs.append(`${k}[]`, item));
        else qs.append(k, v);
      }
      url += `?${qs.toString()}`;
    } else {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...auth, ...params })) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'object') form.append(k, JSON.stringify(v));
        else form.append(k, v);
      }
      init.body = form;
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await fetch(url, init);
    const text = await res.text();
    if (res.status === 404) {
      throw new HttpError(
        'BAPI отвечает 404: публичный метод больше не опубликован по этому адресу. ' +
          'См. шапку src/providers/bapi.js и docs/API-DOSTAVISTA-BAPI.md.',
        { status: 404, url, body: text.slice(0, 300) }
      );
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(`BAPI вернул не JSON (HTTP ${res.status})`, { status: res.status, url, body: text.slice(0, 300) });
    }
    if (String(json.result) !== '1') {
      throw new ApiError(json.error_message || [`result=${json.result}`], {
        query: `${method} ${path}`,
        parameterErrors: json.error_code || null,
        raw: json,
      });
    }
    return json;
  }

  calculateOrder(order) {
    return this.#request('POST', BAPI_METHODS.calculate.path, order);
  }

  createOrder(order) {
    return this.#request('POST', BAPI_METHODS.createOrder.path, order);
  }

  async listOrders({ orderIds = [] } = {}) {
    const json = await this.#request('GET', BAPI_METHODS.listOrders.path, orderIds.length ? { order_id: orderIds } : {});
    return (json.orders || []).map((o) => ({
      ...o,
      statusName: BAPI_STATUS_NAMES[o.status] || String(o.status),
    }));
  }

  async getOrderInfo(orderId, { showPoints = true } = {}) {
    const json = await this.#request('GET', `/bapi/order/${orderId}`, showPoints ? { 'show-points': 1 } : {});
    return json.order;
  }

  cancelOrder(orderId, substatusId) {
    return this.#request('POST', BAPI_METHODS.cancelOrder.path, {
      order_id: orderId,
      ...(substatusId ? { substatus_id: substatusId } : {}),
    });
  }

  getSettings() {
    return this.#request('GET', BAPI_METHODS.getSettings.path);
  }

  setSettings({ callbackUrl, pointsTimeOptional }) {
    return this.#request('POST', BAPI_METHODS.setSettings.path, {
      bapi_callback_url: callbackUrl,
      points_time_optional: pointsTimeOptional ? 1 : 0,
    });
  }

  /** BAPI не отдаёт «мои заказы как курьера» — только заказы магазина. */
  async getOrders() {
    const list = await this.listOrders();
    const orders = [];
    for (const o of list) {
      try {
        const info = await this.getOrderInfo(o.order_id);
        orders.push(
          normalizeOrder(
            {
              order_id: info.order_id,
              status: info.status,
              status_name: info.status_name,
              created: info.created,
              cost: info.cost,
              points: info.points || [],
            },
            { source: this.id }
          )
        );
      } catch {
        orders.push(normalizeOrder({ ...o, points: [] }, { source: this.id }));
      }
    }
    return { courierId: null, orders, abandoned: [], cancelled: [], locations: [], raw: { list } };
  }

  async whoami() {
    const s = await this.getSettings();
    return { partner: null, courierId: null, settings: s.settings || null };
  }

  /** Живость задокументированных адресов — чтобы «актуализация» была проверяемой. */
  static async diagnose({ clientId = '1', token = 'diagnose', timeoutMs = 12000 } = {}) {
    const candidates = [
      ['https://dostavista.ru', '/bapi/order'],
      ['https://robot.dostavista.ru', '/bapi/order'],
      ['https://robotapitest.dostavista.ru', '/bapi/order'],
      ['https://partner.dostavista.ru', '/bapi/order'],
      ['https://robotapi.dostavista.ru', '/bapi/order'],
    ];
    const out = [];
    for (const [host, path] of candidates) {
      const url = `${host}${path}?client_id=${clientId}&token=${token}`;
      const started = Date.now();
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
        clearTimeout(t);
        const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
        out.push({ url, status: res.status, contentType: res.headers.get('content-type'), isJson: /json/i.test(res.headers.get('content-type') || ''), body, ms: Date.now() - started });
      } catch (e) {
        out.push({ url, status: null, error: String(e.cause?.code || e.message || e), ms: Date.now() - started });
      }
    }
    return out;
  }
}
