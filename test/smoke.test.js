/**
 * Тесты ядра: нормализация, геометрия, маршрутизация, провайдеры, HAR.
 * Запуск: node --test test/
 * Сеть не требуется.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOrder, toStops, routableOrders, isTerminalStatus } from '../src/lib/model.js';
import { haversineKm, roadKm, pathLengthKm, toGpx, estimateMinutes } from '../src/lib/geo.js';
import { greedyRoute, exactRoute, planRoute, routeCost, validPrecedence, improveByRelocate } from '../src/lib/route.js';
import { planDay, stopsToRows, toCsv } from '../src/lib/planner.js';
import { DemoProvider } from '../src/providers/demo.js';
import { discoverFromHar } from '../src/providers/har.js';
import { CookieJar, ApiError } from '../src/lib/http.js';
import { isPlaceholderCredential, loadConfig } from '../src/lib/config.js';

/* ─────────────────────────── модель ─────────────────────────── */

test('normalizeOrder: разбирает форму курьерско-партнёрского API', () => {
  const raw = {
    order_id: 9177,
    status: 'assigned',
    points: [
      { point_id: 'p1', order_id: 9177, sequence: 0, address: 'Склад', latitude: 55.75, longitude: 37.61, phone: '9161112233' },
      { point_id: 'p2', order_id: 9177, sequence: 1, address: 'Клиент', latitude: 55.76, longitude: 37.62, visited_datetime: '2026-11-09T10:00:00+03:00' },
    ],
  };
  const o = normalizeOrder(raw, { source: 'partner-cabinet' });
  assert.equal(o.id, '9177');
  assert.equal(o.source, 'partner-cabinet');
  assert.equal(o.points.length, 2);
  assert.equal(o.points[0].role, 'pickup');
  assert.equal(o.points[1].role, 'delivery');
  assert.equal(o.points[0].hasCoordinates, true);
  assert.equal(o.points[1].isVisited, true);
  assert.equal(o.points[0].phone, '9161112233');
});

test('normalizeOrder: точка без координат помечается', () => {
  const o = normalizeOrder({ order_id: 1, points: [{ address: 'без координат' }] });
  assert.equal(o.points[0].hasCoordinates, false);
  assert.equal(o.points[0].lat, null);
});

test('isTerminalStatus / routableOrders отсекают закрытые заказы', () => {
  assert.equal(isTerminalStatus('done'), true);
  assert.equal(isTerminalStatus('cancelled'), true);
  assert.equal(isTerminalStatus('assigned'), false);

  const orders = [
    normalizeOrder({ order_id: 'a', status: 'done', points: [{ latitude: 1, longitude: 1 }] }),
    normalizeOrder({ order_id: 'b', status: 'assigned', points: [{ latitude: 1, longitude: 1 }] }),
    normalizeOrder({ order_id: 'c', status: 'assigned', points: [{ address: 'нет координат' }] }),
  ];
  const r = routableOrders(orders);
  assert.deepEqual(r.map((o) => o.id), ['b']);
});

test('toStops: по умолчанию пропускает посещённые точки', () => {
  const o = normalizeOrder({
    order_id: 'x',
    status: 'assigned',
    points: [
      { point_id: 'a', latitude: 55.7, longitude: 37.6, visited_datetime: '2026-11-09T09:00:00Z' },
      { point_id: 'b', latitude: 55.8, longitude: 37.7 },
    ],
  });
  assert.equal(toStops([o]).length, 1);
  assert.equal(toStops([o])[0].pointId, 'b');
  assert.equal(toStops([o], { includeVisited: true }).length, 2);
});

/* ─────────────────────────── геометрия ─────────────────────────── */

test('haversineKm: ~1.11 км на 0.01° широты', () => {
  const d = haversineKm({ lat: 55.75, lon: 37.61 }, { lat: 55.76, lon: 37.61 });
  assert.ok(Math.abs(d - 1.112) < 0.01, `получилось ${d}`);
});

test('roadKm применяет коэффициент удлинения', () => {
  const a = { lat: 55.75, lon: 37.61 };
  const b = { lat: 55.76, lon: 37.62 };
  assert.ok(roadKm(a, b) > haversineKm(a, b));
});

test('pathLengthKm суммирует перегоны', () => {
  const pts = [
    { lat: 55.75, lon: 37.61 },
    { lat: 55.76, lon: 37.61 },
    { lat: 55.77, lon: 37.61 },
  ];
  const total = pathLengthKm(pts, haversineKm);
  assert.ok(Math.abs(total - 2.224) < 0.05, `получилось ${total}`);
});

test('estimateMinutes учитывает обслуживание на точках', () => {
  assert.equal(estimateMinutes(0, 0, { averageSpeedKmh: 18, serviceMinutesPerStop: 7 }), 0);
  assert.ok(estimateMinutes(18, 2, { averageSpeedKmh: 18, serviceMinutesPerStop: 7 }) >= 60 + 14 - 1);
});

/* ─────────────────────────── маршрутизация ─────────────────────────── */

/** Четыре точки на прямой: A(0) → B(1) → C(2) → D(3) по оси X. */
function lineStops() {
  const mk = (x, orderId, role) => ({ key: `${orderId}:${x}`, orderId, pointId: String(x), role, lat: 0, lon: x, address: `точка ${x}` });
  return [mk(0, 'o1', 'pickup'), mk(3, 'o1', 'delivery'), mk(1, 'o2', 'pickup'), mk(2, 'o2', 'delivery')];
}

const lineDist = (a, b) => Math.abs(a.lon - b.lon);

test('exactRoute: находит оптимум и соблюдает предшествование', () => {
  const stops = lineStops();
  const r = exactRoute(stops, { distanceFn: lineDist });
  assert.ok(r, 'точное решение должно найтись');
  assert.equal(r.exact, true);
  assert.equal(r.cost, 3); // 0→1→2→3
  assert.ok(validPrecedence(r.ordered));
  const pos = (id) => r.ordered.findIndex((s) => s.orderId === id && s.role === 'pickup');
  const posD = (id) => r.ordered.findIndex((s) => s.orderId === id && s.role === 'delivery');
  assert.ok(pos('o1') < posD('o1'));
  assert.ok(pos('o2') < posD('o2'));
});

test('exactRoute: учитывает старт и финиш в стоимости', () => {
  const stops = [lineStops()[0], lineStops()[1]]; // только o1
  const r = exactRoute(stops, { start: { lat: 0, lon: 0 }, end: { lat: 0, lon: 4 }, distanceFn: lineDist });
  assert.equal(r.cost, 4); // 0→0→3→4
});

test('greedyRoute: НЕ подмешивает финиш в список остановок', () => {
  const stops = lineStops();
  const end = { lat: 0, lon: 10, address: 'финиш' };
  const r = greedyRoute(stops, { start: { lat: 0, lon: 0 }, end, distanceFn: lineDist });
  assert.equal(r.length, stops.length);
  assert.ok(!r.includes(end));
});

test('improveByRelocate: не ухудшает и не ломает предшествование', () => {
  const stops = lineStops();
  const greedy = greedyRoute(stops, { distanceFn: lineDist });
  const before = routeCost(greedy, { distanceFn: lineDist });
  const { ordered, cost } = improveByRelocate(greedy, { distanceFn: lineDist });
  assert.ok(cost <= before + 1e-9);
  assert.ok(validPrecedence(ordered));
});

test('planRoute: выбор метода по размеру задачи', () => {
  const small = planRoute(lineStops(), { distanceFn: lineDist });
  assert.equal(small.exact, true);
  assert.equal(small.method, 'held-karp');

  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push({ key: `p${i}`, orderId: `o${i}`, pointId: `p${i}`, role: 'pickup', lat: 0, lon: i * 2 });
    many.push({ key: `d${i}`, orderId: `o${i}`, pointId: `d${i}`, role: 'delivery', lat: 0, lon: i * 2 + 1 });
  }
  const big = planRoute(many, { distanceFn: lineDist });
  assert.equal(big.exact, false);
  assert.equal(big.method, 'greedy+relocate');
  assert.equal(big.ordered.length, 24);
  assert.ok(big.warnings.some((w) => /эвристическ/i.test(w)));
});

test('planRoute: пустой вход не падает', () => {
  const r = planRoute([], {});
  assert.equal(r.ordered.length, 0);
  assert.equal(r.method, 'empty');
});

test('выполненный забор не блокирует свою доставку', () => {
  const orders = [
    normalizeOrder({
      order_id: 'a',
      status: 'assigned',
      points: [
        { point_id: 'a0', latitude: 55.75, longitude: 37.61, visited_datetime: '2026-11-09T09:00:00+03:00' },
        { point_id: 'a1', latitude: 55.76, longitude: 37.62 },
      ],
    }),
  ];
  const stops = toStops(orders);
  assert.equal(stops.length, 1, 'посещённый забор выпадает из маршрута');
  assert.equal(stops[0].role, 'delivery');
  assert.equal(stops[0].pickupDone, true);
  assert.equal(stops[0].pickupPresent, true);

  const plan = planRoute(stops, { distanceFn: lineDist });
  assert.equal(plan.ordered.length, 1, 'доставка обязана остаться в маршруте');
  assert.ok(validPrecedence(plan.ordered));
  assert.equal(plan.warnings.length, 0, 'это не «сирота», предупреждать не о чем');
});

test('planRoute: предупреждает, если забора нет в данных вовсе', () => {
  const stops = [
    { key: 'x:d', orderId: 'x', pointId: 'd', role: 'delivery', lat: 0, lon: 0, pickupPresent: false, address: 'доставка' },
  ];
  const plan = planRoute(stops, { distanceFn: lineDist });
  assert.equal(plan.ordered.length, 1);
  assert.ok(plan.warnings.some((w) => /забор/i.test(w)));
  assert.ok(validPrecedence(plan.ordered), 'без забора ограничение не применяется');
});

/* ─────────────────────────── планировщик дня ─────────────────────────── */

test('planDay: демо-день даёт упорядоченный маршрут с оценкой', async () => {
  const demo = new DemoProvider();
  const data = await demo.getOrders({ date: new Date('2026-11-09T12:00:00+03:00') });
  const plan = await planDay({ orders: data.orders, routing: { distanceMode: 'haversine' } });

  assert.ok(plan.ordered.length > 0);
  assert.ok(plan.costKm > 0);
  assert.ok(plan.durationMin > 0);
  // Первый заказ в демо частично выполнен — его посещённая точка не попадает в маршрут.
  assert.equal(plan.stops.some((s) => s.isVisited), false);
  assert.ok(validPrecedence(plan.ordered));
  assert.equal(plan.distanceMode, 'haversine');
});

test('planDay: отменённые заказы уходят в skippedOrders', async () => {
  const demo = new DemoProvider();
  const data = await demo.getOrders({});
  const plan = await planDay({ orders: [...data.orders, ...data.cancelled], routing: {} });
  assert.ok(plan.skippedOrders.length >= 1);
});

test('stopsToRows / toCsv дают пригодный к выгрузке результат', async () => {
  const demo = new DemoProvider();
  const data = await demo.getOrders({});
  const plan = await planDay({ orders: data.orders, routing: {} });
  const rows = stopsToRows(plan.ordered);
  assert.equal(rows.length, plan.ordered.length);
  assert.match(rows[0].mapsUrl, /yandex\.ru\/maps/);
  const csv = toCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('заказ'));
});

test('toGpx формирует валидную по структуре ленту', async () => {
  const demo = new DemoProvider();
  const data = await demo.getOrders({});
  const plan = await planDay({ orders: data.orders, routing: {} });
  const gpx = toGpx(plan.ordered);
  assert.match(gpx, /^<\?xml/);
  assert.ok(gpx.includes('<gpx'));
  assert.equal((gpx.match(/<wpt /g) || []).length, plan.ordered.length);
});

/* ─────────────────────────── провайдеры ─────────────────────────── */

test('DemoProvider реализует интерфейс провайдера', async () => {
  const p = new DemoProvider();
  assert.equal(p.id, 'demo');
  assert.ok(await p.login());
  assert.ok(await p.whoami());
  const orders = await p.getOrders({});
  assert.equal(orders.orders.length, 8);
  assert.equal(orders.cancelled.length, 1);
  assert.ok(Array.isArray(await p.probe()));
});

/* ─────────────────────────── HAR ─────────────────────────── */

test('discoverFromHar: находит эндпоинты, авторизацию и заказы', () => {
  const har = {
    log: {
      entries: [
        {
          request: {
            method: 'POST',
            url: 'https://app.example.ru/api/v1/courier/orders?date=2026-11-09',
            headers: [{ name: 'Authorization', value: 'Bearer abcdefghijklmnop' }],
            postData: { text: '{"date":"2026-11-09"}' },
          },
          response: { status: 200, content: { mimeType: 'application/json', text: '{"orders":[{"order_id":1}]}' } },
        },
        {
          request: { method: 'GET', url: 'https://app.example.ru/static/main.js', headers: [] },
          response: { status: 200, content: { mimeType: 'application/javascript', text: 'x' } },
        },
        {
          request: { method: 'GET', url: 'https://www.google-analytics.com/collect', headers: [] },
          response: { status: 200, content: { mimeType: 'text/plain', text: '' } },
        },
      ],
    },
  };

  const d = discoverFromHar(har.log.entries);
  assert.deepEqual(d.hosts, ['app.example.ru']);
  assert.equal(d.endpoints.length, 1);
  assert.ok(d.authHeaders.authorization);
  assert.ok(!d.authHeaders.authorization.includes('abcdefghijklmnop'), 'секрет должен быть замаскирован');
  assert.equal(d.orderCandidates.length, 1);
  assert.ok(d.endpoints[0].responseShape.some((s) => s.includes('orders')));
});

/* ─────────────────────────── HTTP-утилиты ─────────────────────────── */

test('CookieJar: разбирает Set-Cookie и учитывает удаление', () => {
  const jar = new CookieJar();
  const headers = {
    getSetCookie: () => [
      'p_session=abc.def.123; Path=/; HttpOnly',
      'session=xyz; Path=/',
      'gone=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ],
  };
  jar.absorb(headers);
  assert.equal(jar.get('p_session'), 'abc.def.123');
  assert.equal(jar.get('session'), 'xyz');
  assert.equal(jar.get('gone'), undefined);
  assert.match(jar.header(), /p_session=abc\.def\.123/);
});

test('ApiError: распознаёт капчу и человекочитаемый текст', () => {
  const e = new ApiError(['invalid_credentials'], { query: 'POST /partner/login' });
  assert.equal(e.needsCaptcha, false);
  assert.match(e.humanMessage, /логин или пароль/i);

  const c = new ApiError(['required_captcha'], { query: 'POST /partner/login' });
  assert.equal(c.needsCaptcha, true);
  assert.match(c.humanMessage, /капч/i);

  const n = new ApiError(['not_logged_in'], { query: 'GET /partner/courier-partner-profile' });
  assert.equal(n.notLoggedIn, true);
});

test('ApiError: есть понятный текст для missing_credentials и invalid_session', () => {
  assert.match(new ApiError(['missing_credentials']).humanMessage, /учётные данные/i);
  assert.match(new ApiError(['invalid_session']).humanMessage, /сессия/i);
});

/* ─────────────────────────── конфигурация ─────────────────────────── */

test('config: значения-заглушки не считаются учётными данными', () => {
  // Заглушки из config.example.json
  assert.equal(isPlaceholderCredential('ваш-логин@example.com'), true);
  assert.equal(isPlaceholderCredential('ваш-пароль'), true);
  assert.equal(isPlaceholderCredential('Ваш-пароль'), true);
  assert.equal(isPlaceholderCredential('your-login@example.com'), true);
  // Пустое значение — тоже «не настроено»
  assert.equal(isPlaceholderCredential(''), true);
  assert.equal(isPlaceholderCredential('   '), true);
  assert.equal(isPlaceholderCredential(null), true);
  assert.equal(isPlaceholderCredential(undefined), true);
  // Настоящие значения
  assert.equal(isPlaceholderCredential('courier@example.test'), false);
  assert.equal(isPlaceholderCredential('p@real-courier.ru'), false);
  assert.equal(isPlaceholderCredential('9161234567'), false);
});

test('config: заглушки не доходят до коннектора, структура сохраняется', () => {
  const cfg = loadConfig({ reload: true });
  // Даже без config.local.json в коннектор не должны попасть «ваш-...».
  assert.ok(!String(cfg.partnerCabinet.email || '').includes('ваш'), 'email не должен быть заглушкой');
  assert.ok(!String(cfg.partnerCabinet.password || '').includes('ваш'), 'password не должен быть заглушкой');
  assert.ok(!String(cfg.partnerCabinet.session || '').includes('ваш'), 'session не должен быть заглушкой');
  // Значения по умолчанию при этом на месте.
  assert.equal(typeof cfg.server.port, 'number');
  assert.equal(typeof cfg.routing.averageSpeedKmh, 'number');
  assert.ok(cfg.partnerCabinet.baseUrl.startsWith('https://'));
});
