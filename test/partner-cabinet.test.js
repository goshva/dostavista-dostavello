/**
 * Интеграционные тесты коннектора курьерско-партнёрского кабинета.
 *
 * Поднимается локальный HTTP-сервер-двойник, который повторяет протокол
 * partner.dostavista.ru: meta csrf-token, анонимная cookie p_session,
 * конверт {is_successful, errors, parameter_errors, session, server_datetime},
 * ротация сессии и отказ not_logged_in.
 *
 * Это проверка ПОЛНОГО пути коннектора без реальных учётных данных:
 * bootstrap → CSRF → login → проверка сессии → заказы → маршрут.
 *
 * Сеть не требуется.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { PartnerCabinetProvider } from '../src/providers/partnerCabinet.js';
import { ApiError } from '../src/lib/http.js';
import { planDay } from '../src/lib/planner.js';
import { validPrecedence } from '../src/lib/route.js';

const GOOD_EMAIL = 'courier@example.test';
const GOOD_PASSWORD = 's3cret';
const COURIER_ID = 777;

/* ─────────────────────────── сервер-двойник ─────────────────────────── */

function startMockCabinet(options = {}) {
  const cfg = {
    profileCourierId: COURIER_ID,
    matchByPhoneOnly: false,
    loginRequiresCaptcha: false,
    rejectLoginWith: null,
    ...options,
  };

  const state = {
    csrf: 'csrf-token-value',
    anonymousCounter: 0,
    /** Отозванные (протухшие) сессии. */
    revokedSessions: new Set(),
    /** Все сессии, выданные успешным входом. */
    issuedSessions: [],
    requests: [],
    loginCalls: 0,
    sessionCounter: 0,
  };

  const nextSession = () => `sess-${++state.sessionCounter}`;

  const envelope = (extra = {}) => ({
    is_successful: true,
    errors: [],
    parameter_errors: null,
    session: extra.session ?? nextSession(),
    server_datetime: new Date().toISOString(),
    ...extra,
  });
  const fail = (errors, extra = {}) => ({
    is_successful: false,
    errors,
    parameter_errors: null,
    session: nextSession(),
    server_datetime: new Date().toISOString(),
    ...extra,
  });

  const parseCookie = (header = '') =>
    Object.fromEntries(
      header
        .split(';')
        .map((s) => s.trim().split('='))
        .filter((p) => p.length === 2)
    );

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { __raw: raw };
    }

    const cookies = parseCookie(req.headers.cookie || '');
    state.requests.push({
      method: req.method,
      path: req.url,
      csrf: req.headers['x-csrf-token'] || null,
      contentType: req.headers['content-type'] || null,
      cookies,
      body,
    });

    const json = (payload, setCookie) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (setCookie) headers['Set-Cookie'] = setCookie;
      res.writeHead(200, headers);
      res.end(JSON.stringify(payload));
    };

    // ── GET / : страница с csrf-токеном и АНОНИМНОЙ cookie p_session ──
    if (req.method === 'GET' && req.url === '/') {
      const anon = `anon-${++state.anonymousCounter}`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': [`p_session=${anon}; Path=/`, 'session=client-api-anon; Path=/'],
      });
      res.end(
        `<!DOCTYPE html><html><head><title>Личный кабинет партнера</title>` +
          `<meta name="csrf-token" content="${state.csrf}"></head><body></body></html>`
      );
      return;
    }

    const authed = () => {
      const s = cookies.p_session;
      // Настоящая сессия выдаётся только при успешном входе (префикс sess-),
      // анонимная (anon-) — нет. Отозванные считаются протухшими.
      return Boolean(s) && /^sess-/.test(s) && !state.revokedSessions.has(s);
    };

    // ── POST /partner/login ──
    if (req.method === 'POST' && req.url === '/partner/login') {
      state.loginCalls++;
      if (req.headers['x-csrf-token'] !== state.csrf) {
        return json(fail(['invalid_csrf']));
      }
      if (cfg.loginRequiresCaptcha) {
        return json(fail(['required_captcha']));
      }
      if (body?.email === GOOD_EMAIL && body?.password === GOOD_PASSWORD) {
        if (cfg.rejectLoginWith) return json(fail([cfg.rejectLoginWith]));
        const s = nextSession();
        state.issuedSessions.push(s);
        return json(
          envelope({
            session: s,
            courierPartner: {
              fullName: 'Иван Петров',
              phone: '9161234567',
              ...(cfg.profileCourierId ? { courier_id: cfg.profileCourierId } : {}),
            },
          }),
          `p_session=${s}; Path=/`
        );
      }
      return json(fail(['invalid_credentials']));
    }

    // ── Защищённые методы ──
    if (!authed()) return json(fail(['not_logged_in']));

    if (req.method === 'GET' && req.url === '/partner/courier-partner-profile') {
      return json(
        envelope({
          courierPartner: {
            fullName: 'Иван Петров',
            phone: '9161234567',
            ...(cfg.profileCourierId && !cfg.matchByPhoneOnly ? { courier_id: cfg.profileCourierId } : {}),
          },
          courier_partner_tariff: { commission_percent: 12 },
        })
      );
    }

    if (req.method === 'POST' && req.url === '/partner/couriers') {
      return json(
        envelope({
          couriers: [
            {
              courier_id: COURIER_ID,
              status: 'active',
              phone: '9161234567',
              full_name: 'Иван Петров',
              work_started_datetime: '2026-11-01T09:00:00+03:00',
              ban_reason: null,
            },
          ],
          couriers_count: 1,
        })
      );
    }

    if (req.method === 'POST' && req.url === '/partner/courier-info') {
      if (body?.courier_id !== COURIER_ID) return json(fail(['access_denied']));
      return json(
        envelope({
          courier: { courier_id: COURIER_ID, full_name: 'Иван Петров', is_working: true, has_order: true },
          orders: [
            {
              order_id: '9304',
              status: 'active',
              points: [
                { point_id: 'p1', order_id: '9304', latitude: 55.7558, longitude: 37.6173, address: 'Москва, Солянка, 13', phone: '9161112233', status: 'pending', visited_datetime: null },
                { point_id: 'p2', order_id: '9304', latitude: 55.7621, longitude: 37.6402, address: 'Москва, Покровка, 27', phone: '9161112244', status: 'pending', visited_datetime: null },
              ],
            },
            {
              order_id: '9305',
              status: 'active',
              points: [
                { point_id: 'p3', order_id: '9305', latitude: 55.7480, longitude: 37.6001, address: 'Москва, Арбат, 12', phone: '9161112255', status: 'visited', visited_datetime: '2026-11-09T09:10:00+03:00' },
                { point_id: 'p4', order_id: '9305', latitude: 55.7402, longitude: 37.6301, address: 'Москва, Пречистенка, 30', phone: '9161112266', status: 'pending', visited_datetime: null },
              ],
            },
          ],
          abandoned_orders: [],
          cancelled_orders: [
            { order_id: '9309', status: 'cancelled', points: [] },
          ],
          locations: [],
        })
      );
    }

    if (req.method === 'GET' && req.url === '/partner/commission-history') {
      return json(
        envelope({
          courier_partner_commission_history: [
            { partner_commission_percent: 12, courier_partner_id: 1, change_datetime: '2026-11-01T00:00:00+03:00', end_datetime: null },
          ],
        })
      );
    }

    return json(fail(['unknown_method']));
  });

  return {
    state,
    cfg,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    /** Протухла сессия — как это бывает на живом сервере. */
    invalidateSessions: () => {
      for (const s of state.issuedSessions) state.revokedSessions.add(s);
    },
    /** Последняя выданная сессия. */
    latestSession: () => state.issuedSessions[state.issuedSessions.length - 1] || null,
    requestsTo: (path) => state.requests.filter((r) => r.path === path),
  };
}

/** Хелпер: поднять двойник и вернуть провайдер, смотрящий на него. */
async function withCabinet(options, fn) {
  const mock = startMockCabinet(options);
  const baseUrl = await mock.listen();
  try {
    return await fn(mock, baseUrl);
  } finally {
    await mock.close();
  }
}

/* ─────────────────────────── тесты ─────────────────────────── */

test('login: неверный пароль → invalid_credentials с понятным текстом', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: 'wrong' });
    await assert.rejects(() => p.login(), (e) => {
      assert.ok(e instanceof ApiError);
      assert.deepEqual(e.errors, ['invalid_credentials']);
      assert.match(e.humanMessage, /логин или пароль/i);
      return true;
    });
    assert.equal(p.authenticated, false);
  });
});

test('login: CSRF-заголовок передаётся в POST', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await p.login();
    const loginReq = mock.requestsTo('/partner/login')[0];
    assert.equal(loginReq.csrf, 'csrf-token-value');
    assert.match(loginReq.contentType, /application\/json/);
    assert.deepEqual(loginReq.body, { email: GOOD_EMAIL, password: GOOD_PASSWORD });
  });
});

test('login: missing_credentials, если нечем авторизоваться', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: '', password: '' });
    await assert.rejects(() => p.login(), (e) => {
      assert.deepEqual(e.errors, ['missing_credentials']);
      return true;
    });
  });
});

test('РЕГРЕСС: анонимная cookie p_session не считается входом', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });

    // Сервер выдаёт анонимную cookie ещё до входа — как настоящий кабинет.
    await p.client.bootstrap();
    assert.ok(p.client.jar.get('p_session'), 'анонимная cookie должна была появиться');
    assert.match(p.client.jar.get('p_session'), /^anon-/);

    // Раньше именно из-за этого логин пропускался и всё падало с not_logged_in.
    await p.ensureAuth();
    assert.equal(p.authenticated, true, 'должен был произойти настоящий вход');
    assert.equal(mock.state.loginCalls, 1, 'ровно один запрос на вход');
    assert.match(p.client.jar.get('p_session'), /^sess-/, 'в cookie должна быть настоящая сессия, а не анонимная');
  });
});

test('whoami: профиль, courier_id и комиссия', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    const me = await p.whoami();
    assert.equal(me.courierId, COURIER_ID);
    assert.equal(me.partner.fullName, 'Иван Петров');
    assert.equal(me.commissionPercent, 12);
  });
});

test('courier_id определяется по телефону, если в профиле его нет', async () => {
  await withCabinet({ profileCourierId: null }, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    const me = await p.whoami();
    assert.equal(me.courierId, COURIER_ID, 'должен найтись по совпадению телефона');
    assert.equal(mock.requestsTo('/partner/couriers').length, 1);
  });
});

test('getOrders: заказы нормализуются, отменённые уходят в отдельный список', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    const data = await p.getOrders({ date: new Date('2026-11-09T12:00:00+03:00') });

    assert.equal(data.courierId, COURIER_ID);
    assert.equal(data.orders.length, 2);
    assert.equal(data.cancelled.length, 1);

    const first = data.orders[0];
    assert.equal(first.id, '9304');
    assert.equal(first.source, 'partner-cabinet');
    assert.equal(first.points[0].role, 'pickup');
    assert.equal(first.points[1].role, 'delivery');
    assert.equal(first.points[0].hasCoordinates, true);

    // Период передан в формате ISO со смещением.
    const infoReq = mock.requestsTo('/partner/courier-info')[0];
    assert.equal(infoReq.body.courier_id, COURIER_ID);
    assert.match(infoReq.body.from_datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.match(infoReq.body.to_datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});

test('сквозной путь: заказы из API → маршрут на день', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    const data = await p.getOrders({ date: new Date('2026-11-09T12:00:00+03:00') });

    const plan = await planDay({
      orders: data.orders,
      routing: { distanceMode: 'haversine', averageSpeedKmh: 18, serviceMinutesPerStop: 7 },
      start: { lat: 55.7558, lon: 37.6173, address: 'старт' },
    });

    // Заказ 9305 частично выполнен: его посещённый забор выпадает, доставка остаётся.
    assert.equal(plan.stops.length, 3, '2 точки заказа 9304 + доставка заказа 9305');
    assert.ok(validPrecedence(plan.ordered));
    assert.ok(plan.costKm > 0);
    assert.ok(plan.durationMin > 0);
    assert.equal(plan.exact, true, '3 точки — считается точный оптимум');
    assert.equal(plan.warnings.length, 0, 'выполненный забор не должен давать предупреждений');
  });
});

test('ротация сессии: новый session от сервера подхватывается', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await p.ensureAuth();
    const afterLogin = p.client.jar.get('p_session');

    await p.getOrders({ date: new Date('2026-11-09T12:00:00+03:00'), courierId: COURIER_ID });
    const afterCall = p.client.jar.get('p_session');

    assert.notEqual(afterCall, afterLogin, 'сервер выдал новый session — коннектор обязан его сохранить');
    assert.match(afterCall, /^sess-/, 'в cookie должна остаться настоящая сессия');
  });
});

test('истёкшая сессия: ensureAuth прозрачно перелогинивается', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await p.ensureAuth();
    assert.equal(mock.state.loginCalls, 1);

    mock.invalidateSessions();
    p.authenticated = false; // как после перезапуска процесса

    const me = await p.whoami();
    assert.equal(me.courierId, COURIER_ID);
    assert.equal(mock.state.loginCalls, 2, 'должен был произойти повторный вход');
  });
});

test('повторный ensureAuth не делает лишних запросов на вход', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await p.ensureAuth();
    await p.ensureAuth();
    await p.ensureAuth();
    assert.equal(mock.state.loginCalls, 1);
  });
});

test('вход по готовой cookie сессии (без пароля)', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    // Сначала кто-то вошёл и получил валидную сессию.
    const first = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await first.login();
    const session = mock.latestSession();

    // Затем коннектор настраивают только сессией, без пароля.
    const p = new PartnerCabinetProvider({ baseUrl, session });
    const me = await p.whoami();
    assert.equal(me.courierId, COURIER_ID);
    assert.equal(mock.state.loginCalls, 1, 'второго входа быть не должно — сессия уже валидна');
  });
});

test('required_captcha распознаётся особым образом', async () => {
  await withCabinet({ loginRequiresCaptcha: true }, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await assert.rejects(() => p.login(), (e) => {
      assert.equal(e.needsCaptcha, true);
      assert.match(e.humanMessage, /капч/i);
      return true;
    });
  });
});

test('GET-методы вызываются без CSRF-заголовка, POST — с ним', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await p.ensureAuth();
    await p.getCommissionHistory();
    await p.listCouriers();

    const profileReq = mock.requestsTo('/partner/courier-partner-profile').at(-1);
    assert.equal(profileReq.method, 'GET');
    assert.equal(profileReq.csrf, null, 'GET не требует CSRF');

    const historyReq = mock.requestsTo('/partner/commission-history').at(-1);
    assert.equal(historyReq.method, 'GET');

    const couriersReq = mock.requestsTo('/partner/couriers').at(-1);
    assert.equal(couriersReq.method, 'POST');
    assert.equal(couriersReq.csrf, 'csrf-token-value');
  });
});

test('конверт с ошибкой: HTTP 200, но is_successful=false → бросается ApiError', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, email: GOOD_EMAIL, password: GOOD_PASSWORD });
    await p.ensureAuth();
    // Двойник вернёт access_denied на чужой courier_id.
    await assert.rejects(() => p.getOrders({ date: new Date(), courierId: 999999 }), (e) => {
      assert.ok(e instanceof ApiError);
      assert.deepEqual(e.errors, ['access_denied']);
      assert.match(e.humanMessage, /доступ/i);
      return true;
    });
  });
});

test('переданная сессия не подошла → invalid_session (а не «нет данных»)', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl, session: 'anon-bogus' });
    await assert.rejects(() => p.login({ force: true }), (e) => {
      assert.deepEqual(e.errors, ['invalid_session']);
      assert.match(e.humanMessage, /сессия/i);
      return true;
    });
  });
});

test('анонимная cookie без пароля → missing_credentials (вход не настроен)', async () => {
  await withCabinet({}, async (mock, baseUrl) => {
    const p = new PartnerCabinetProvider({ baseUrl });
    await p.client.bootstrap(); // сервер выдал анонимную p_session
    assert.match(p.client.jar.get('p_session'), /^anon-/);

    await assert.rejects(() => p.ensureAuth(), (e) => {
      assert.deepEqual(e.errors, ['missing_credentials']);
      assert.match(e.humanMessage, /учётные данные/i);
      return true;
    });
    assert.equal(mock.state.loginCalls, 0, 'попыток входа с пустыми данными быть не должно');
  });
});
