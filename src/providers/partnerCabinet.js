/**
 * Провайдер «курьерско-партнёрский кабинет» — основной рабочий коннектор.
 *
 * Кабинет: https://partner.dostavista.ru  (SPA courier-partner-cabinet).
 * API недокументирован; эндпоинты и схемы восстановлены из бандла
 * /js/courier-partner-cabinet.*.js и проверены живыми запросами.
 * Подробности и примеры ответов — в docs/API-COURIER-PARTNER.md.
 *
 * Транспорт: POST/GET + JSON, заголовок X-CSRF-Token, cookie p_session.
 * Конверт ответа: { is_successful, errors, parameter_errors, session, server_datetime }.
 */

import { ApiClient, ApiError } from '../lib/http.js';
import { normalizeOrder, statusName } from '../lib/model.js';

/** Карта эндпоинтов: имя → метод, путь, назначение. */
export const ENDPOINTS = {
  login: { method: 'POST', path: '/partner/login', note: 'Вход: {email, password}' },
  logout: { method: 'POST', path: '/partner/logout', note: 'Выход' },
  sendRecoveryEmail: { method: 'POST', path: '/partner/send-recovery-email', note: 'Восстановление пароля: {email}' },

  myProfile: { method: 'GET', path: '/partner/courier-partner-profile', note: 'Профиль партнёра + тариф комиссии' },
  editMyProfile: { method: 'POST', path: '/partner/edit-courier-partner-profile', note: '{courier_partner_tariff:{commission_percent}}' },
  switchPartner: { method: 'POST', path: '/partner/courier-switch', note: '{courier_id} → session' },
  partnersAllowedToSwitch: { method: 'GET', path: '/partner/courier-partners-allowed-to-switch', note: 'Доступные партнёры' },
  adminPartners: { method: 'GET', path: '/partner/admin-courier-partners', note: 'Все партнёры (админ)' },

  couriers: {
    method: 'POST',
    path: '/partner/couriers',
    note: 'Список курьеров: {work_started_date_from, work_started_date_till, status, search_text, offset, limit}',
  },
  couriersExport: { method: 'POST', path: '/partner/couriers-export', note: 'Экспорт курьеров (файл)' },
  courierBindings: { method: 'POST', path: '/partner/courier-bindings', note: '{status, phone, offset, limit}' },
  courierCountries: { method: 'GET', path: '/partner/courier-countries', note: 'Страны' },
  createCourier: { method: 'POST', path: '/partner/create-courier', note: 'Создать курьера' },
  editCourierProfile: { method: 'POST', path: '/partner/edit-courier-profile', note: 'Изменить профиль курьера' },
  getCourierProfile: { method: 'POST', path: '/partner/get-courier-profile', note: '{courier_id}' },
  sendSelfEmployedRequest: { method: 'POST', path: '/partner/send-self-employed-request', note: '{courier_id}' },

  couriersOnMap: {
    method: 'POST',
    path: '/partner/couriers-on-map',
    note: 'Курьеры на карте: {is_active, has_order, east_south_latitude, east_south_longitude, north_west_latitude, north_west_longitude, phone?}',
  },
  /** КЛЮЧЕВОЙ эндпоинт: заказы конкретного курьера за период. */
  courierInfo: {
    method: 'POST',
    path: '/partner/courier-info',
    note: 'Заказы курьера: {courier_id, from_datetime, to_datetime} → {courier, orders[], abandoned_orders[], cancelled_orders[], locations[]}',
  },
  orderLocations: { method: 'POST', path: '/partner/courier-on-map-order-locations', note: '{order_id} → {locations[]}' },
  courierProblems: { method: 'POST', path: '/partner/courier-problems-report', note: '{courier_id, limit, offset}' },

  commissionHistory: { method: 'GET', path: '/partner/commission-history', note: 'История комиссии' },
  reports: { method: 'POST', path: '/partner/report', note: '{from_date, till_date}' },
  availableReports: { method: 'GET', path: '/partner/available-financial-reports', note: 'Доступные отчёты' },
  generateReport: { method: 'POST', path: '/partner/generate-financial-report', note: '{report_id}' },

  getInstructionUrl: { method: 'GET', path: '/partner/get-instruction-url', note: 'Ссылка на инструкцию' },
  setInstructionUrl: { method: 'POST', path: '/partner/set-instruction-url', note: '{instruction_url}' },
};

export class PartnerCabinetProvider {
  static id = 'partner-cabinet';
  static title = 'Курьерско-партнёрский кабинет partner.dostavista.ru';

  /**
   * @param {object} cfg
   * @param {string} cfg.baseUrl
   * @param {string} [cfg.email]
   * @param {string} [cfg.password]
   * @param {string} [cfg.session]  готовый p_session
   * @param {object} [opts] { debug, cookies }
   */
  constructor(cfg = {}, opts = {}) {
    this.baseUrl = (cfg.baseUrl || 'https://partner.dostavista.ru').replace(/\/+$/, '');
    this.email = cfg.email || '';
    this.password = cfg.password || '';
    this.client = new ApiClient({
      baseUrl: this.baseUrl,
      sessionToken: cfg.session || undefined,
      cookies: opts.cookies || {},
      debug: Boolean(opts.debug),
    });
    this.profile = null;
    this.selfCourierId = null;
    /** Явно переданная готовая сессия (если настраивались по cookie, а не по паролю). */
    this.sessionToken = cfg.session || null;
    /**
     * Подтверждён ли вход.
     * ВАЖНО: сервер выдаёт АНОНИМНУЮ cookie p_session ещё до входа (на GET /),
     * поэтому наличие cookie само по себе ничего не доказывает — нужен признак,
     * выставленный после успешного ответа API.
     */
    this.authenticated = false;
  }

  get id() {
    return PartnerCabinetProvider.id;
  }

  /** Есть ли чем авторизоваться. */
  get canAuthenticate() {
    return Boolean(
      this.email && this.password
    );
  }

  /**
   * Войти по логину/паролю.
   *
   * Анонимная cookie p_session, выданная на GET /, входом НЕ считается: если
   * пароля нет, переданная сессия сначала проверяется реальным запросом.
   */
  async login({ force = false } = {}) {
    if (this.authenticated && !force) return { reusedSession: true };

    if (!this.email || !this.password) {
      // Пароля нет — возможно, передана готовая сессия. Проверяем её делом.
      if (this.client.jar.get('p_session')) {
        try {
          await this.#verify();
          return { reusedSession: true };
        } catch (e) {
          if (e instanceof ApiError && (e.notLoggedIn || e.errors.includes('invalid_session'))) {
            // Различаем два случая: явно переданная сессия не подошла —
            // так и скажем; либо cookie вообще анонимная — значит вход не настроен.
            throw new ApiError([this.sessionToken ? 'invalid_session' : 'missing_credentials'], {
              query: 'login',
            });
          }
          throw e;
        }
      }
      throw new ApiError(['missing_credentials'], { query: 'login' });
    }

    await this.client.ensureCsrf();
    const res = await this.client.query(ENDPOINTS.login.path, {
      email: this.email,
      password: this.password,
    });
    this.authenticated = true;
    // Смена аккаунта не должна оставлять данные прежнего.
    this.profile = null;
    this.selfCourierId = null;
    return { session: res.session || this.client.jar.get('p_session') };
  }

  /**
   * Проверить, что текущей сессии достаточно: запрос к профилю.
   * Бросает ApiError('not_logged_in'), если сессия анонимная или протухла.
   */
  async #verify() {
    const profile = await this.#call('myProfile');
    this.profile = profile;
    this.authenticated = true;
    return profile;
  }

  /**
   * Гарантировать рабочую сессию.
   *
   * Порядок: уже подтверждены → проверить текущую сессию → при отказе войти
   * по логину/паролю → проверить снова. Именно так обрабатывается случай
   * «анонимная cookie уже есть, но вход не выполнялся».
   */
  async ensureAuth() {
    if (this.authenticated) return this;

    try {
      await this.#verify();
      return this;
    } catch (e) {
      const recoverable =
        e instanceof ApiError &&
        (e.notLoggedIn || e.errors.includes('missing_credentials') || e.errors.includes('invalid_session'));
      if (!recoverable) throw e;
    }

    // Сессия не подошла — логинимся заново.
    this.authenticated = false;
    await this.login({ force: true });
    return this;
  }

  async #call(name, body = {}, method) {
    const ep = ENDPOINTS[name];
    if (!ep) throw new Error(`Неизвестный эндпоинт: ${name}`);
    return this.client.query(ep.path, body, method || ep.method);
  }

  /** Профиль владельца кабинета (партнёра). Кэшируется. */
  async getProfile({ refresh = false } = {}) {
    await this.ensureAuth();
    if (this.profile && !refresh) return this.profile;
    const res = await this.#call('myProfile');
    this.profile = res;
    return res;
  }

  /** Кто мы: профиль + (если получится) свой courier_id. */
  async whoami() {
    const profile = await this.getProfile();
    const partner = profile.courierPartner || null;
    let courierId = null;
    try {
      courierId = await this.resolveSelfCourierId(profile);
    } catch {
      /* не критично */
    }
    return {
      partner,
      courierId,
      commissionPercent: profile.courier_partner_tariff?.commission_percent ?? null,
      raw: profile,
    };
  }

  /**
   * Найти собственный courier_id.
   * Логика: прямое поле профиля → совпадение по телефону → единственный курьер.
   */
  async resolveSelfCourierId(profile = null) {
    if (this.selfCourierId) return this.selfCourierId;
    const p = profile || this.profile || (await this.getProfile());
    const partner = p.courierPartner || p.courier_partner || {};

    const direct =
      partner.courierId ?? partner.courier_id ?? p.courierId ?? p.courier_id ?? null;
    if (direct) {
      this.selfCourierId = Number(direct);
      return this.selfCourierId;
    }

    const phone = partner.phone || partner.courierPhone || null;
    const list = await this.listCouriers({ limit: 200 });
    if (phone) {
      const norm = String(phone).replace(/\D/g, '').slice(-10);
      const hit = list.list.find((c) => String(c.phone || '').replace(/\D/g, '').endsWith(norm));
      if (hit) {
        this.selfCourierId = hit.courierId;
        return this.selfCourierId;
      }
    }
    if (list.list.length === 1) {
      this.selfCourierId = list.list[0].courierId;
      return this.selfCourierId;
    }
    return null;
  }

  /**
   * Список курьеров партнёра.
   * @returns {{list:Array<object>, count:number}}
   */
  async listCouriers({ workStartedFrom, workStartedTill, status, searchText, offset, limit } = {}) {
    await this.ensureAuth();
    const res = await this.#call('couriers', {
      work_started_date_from: workStartedFrom ? yyyymmdd(workStartedFrom) : null,
      work_started_date_till: workStartedTill ? yyyymmdd(workStartedTill) : null,
      status: status ?? null,
      search_text: searchText ?? null,
      offset: offset ?? null,
      limit: limit ?? null,
    });
    return {
      list: (res.couriers || []).map((c) => ({
        courierId: c.courier_id,
        status: c.status,
        statusName: statusName(c.status),
        phone: c.phone,
        fullName: c.full_name,
        workStartedAt: c.work_started_datetime,
        banReason: c.ban_reason,
        raw: c,
      })),
      count: res.couriers_count ?? (res.couriers || []).length,
    };
  }

  /** Курьеры на карте (кто работает, у кого есть заказ). */
  async couriersOnMap({ isActive, hasOrder, bounds, phone } = {}) {
    await this.ensureAuth();
    const b = bounds || {};
    const res = await this.#call('couriersOnMap', {
      is_active: isActive ?? null,
      has_order: hasOrder ?? null,
      east_south_latitude: b.eastSouthLatitude ?? null,
      east_south_longitude: b.eastSouthLongitude ?? null,
      north_west_latitude: b.northWestLatitude ?? null,
      north_west_longitude: b.northWestLongitude ?? null,
      ...(phone ? { phone } : {}),
    });
    return {
      list: (res.couriers || []).map((c) => ({
        courierId: c.courier_id,
        phone: c.phone,
        fullName: c.full_name,
        lat: c.latitude,
        lon: c.longitude,
        hasCoordinates: c.has_coordinates,
        hasOrder: c.has_order,
        isWorking: c.is_working,
        raw: c,
      })),
      statistics: res.courier_statistics || null,
    };
  }

  /**
   * СЫРОЙ ответ по заказам курьера за период — база для всего остального.
   * @param {object} p
   * @param {number} p.courierId
   * @param {string|Date} p.from
   * @param {string|Date} p.to
   */
  async getCourierInfoRaw({ courierId, from, to }) {
    return this.#call('courierInfo', {
      courier_id: courierId,
      from_datetime: isoWithTz(from),
      to_datetime: isoWithTz(to),
    });
  }

  /**
   * Заказы курьера, приведённые к канонической модели.
   *
   * Возвращает и активные `orders`, и `abandoned`/`cancelled` — они нужны,
   * чтобы понимать, что выпало из дня.
   */
  async getOrders({ courierId, date = new Date(), from, to } = {}) {
    await this.ensureAuth();
    const period = from && to ? { from, to } : dayRange(date);
    const id = courierId ?? (await this.resolveSelfCourierId());
    if (!id) {
      throw new Error(
        'Не удалось определить courier_id. Укажите его явно: --courier <id> ' +
          'или посмотрите список командой `couriers`.'
      );
    }
    const res = await this.getCourierInfoRaw({ courierId: id, from: period.from, to: period.to });

    const wrap = (arr) => (arr || []).map((o) => normalizeOrder(o, { source: this.id }));
    return {
      courierId: id,
      period: { from: period.from.toISOString?.() ?? String(period.from), to: period.to.toISOString?.() ?? String(period.to) },
      courier: res.courier || null,
      orders: wrap(res.orders),
      abandoned: wrap(res.abandoned_orders),
      cancelled: wrap(res.cancelled_orders),
      locations: res.locations || [],
      raw: res,
    };
  }

  /** Точки конкретного заказа (трек) — для отрисовки на карте. */
  async getOrderLocations(orderId) {
    await this.ensureAuth();
    const res = await this.#call('orderLocations', { order_id: orderId });
    return res.locations || [];
  }

  /** Проблемные заказы курьера. */
  async getProblems({ courierId, limit = 20, offset = 0 }) {
    await this.ensureAuth();
    const res = await this.#call('courierProblems', {
      courier_id: courierId,
      limit,
      offset,
    });
    return {
      courier: res.courier || null,
      problems: res.problems || [],
      count: res.problems_count ?? (res.problems || []).length,
    };
  }

  async getCommissionHistory() {
    await this.ensureAuth();
    const res = await this.#call('commissionHistory');
    return res.courier_partner_commission_history || [];
  }

  async getAvailableReports() {
    await this.ensureAuth();
    const res = await this.#call('availableReports');
    return res.reports || [];
  }

  async getReport({ from, to }) {
    await this.ensureAuth();
    return this.#call('reports', { from_date: yyyymmdd(from), till_date: yyyymmdd(to) });
  }

  /** Диагностика: какие эндпоинты отвечают и что возвращают. */
  async probe() {
    await this.ensureAuth();
    const results = [];
    for (const [name, ep] of Object.entries(ENDPOINTS)) {
      if (['login', 'logout', 'sendRecoveryEmail', 'switchPartner'].includes(name)) continue;
      const started = Date.now();
      try {
        const data = await this.client.query(ep.path, ep.method === 'GET' ? {} : {}, ep.method);
        results.push({ name, path: ep.path, method: ep.method, ok: true, ms: Date.now() - started, keys: Object.keys(data) });
      } catch (e) {
        results.push({
          name,
          path: ep.path,
          method: ep.method,
          ok: false,
          ms: Date.now() - started,
          error: e instanceof ApiError ? e.errors.join(',') : String(e.message || e),
        });
      }
    }
    return results;
  }
}

/* ─────────────────────────── вспомогательное ─────────────────────────── */

/** YYYY-MM-DD (для *_date_* параметров кабинета). */
export function yyyymmdd(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Локальное время с смещением: 2026-11-09T00:00:00+03:00 */
export function isoWithTz(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  const pad = (n, l = 2) => String(Math.abs(n)).padStart(l, '0');
  const off = -x.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}` +
    `T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** Начало и конец суток по локальному времени. */
export function dayRange(date = new Date()) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  const from = new Date(d);
  from.setHours(0, 0, 0, 0);
  const to = new Date(d);
  to.setHours(23, 59, 59, 0);
  return { from, to };
}
