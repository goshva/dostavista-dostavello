/**
 * Тесты HAR-провайдера — «запасного пути» для тех, кто работает через
 * мобильное приложение: трафик записывается один раз, и по нему можно
 * и найти эндпоинты, и проиграть свои заказы офлайн.
 *
 * Сеть не требуется.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HarReplayProvider, parseHar, discoverFromHar, shapeOf } from '../src/providers/har.js';
import { createProvider } from '../src/providers/index.js';
import { planDay } from '../src/lib/planner.js';

/** Собрать HAR с ответом, похожим на /partner/courier-info. */
function makeHar({ host = 'app.example.ru', pathName = '/api/v1/courier/orders', orders = true } = {}) {
  const payload = orders
    ? {
        is_successful: true,
        courier: { courier_id: 4242, full_name: 'Иван Петров', is_working: true, has_order: true },
        orders: [
          {
            order_id: '9304',
            status: 'active',
            points: [
              { point_id: 'p1', order_id: '9304', latitude: 55.7558, longitude: 37.6173, address: 'Москва, Солянка, 13', phone: '9161112233', visited_datetime: null },
              { point_id: 'p2', order_id: '9304', latitude: 55.7621, longitude: 37.6402, address: 'Москва, Покровка, 27', phone: '9161112244', visited_datetime: null },
            ],
          },
        ],
        abandoned_orders: [],
        cancelled_orders: [],
        locations: [],
      }
    : { is_successful: true, orders: [] };

  return {
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-11-09T09:00:00+03:00',
          request: {
            method: 'POST',
            url: `https://${host}${pathName}?date=2026-11-09`,
            headers: [
              { name: 'Authorization', value: 'Bearer supersecrettokenvalue123' },
              { name: 'Content-Type', value: 'application/json' },
            ],
            postData: { mimeType: 'application/json', text: '{"date":"2026-11-09"}' },
          },
          response: {
            status: 200,
            content: { mimeType: 'application/json', text: JSON.stringify(payload) },
          },
        },
        {
          request: { method: 'GET', url: `https://${host}/static/app.js`, headers: [] },
          response: { status: 200, content: { mimeType: 'application/javascript', text: 'var a=1' } },
        },
      ],
    },
  };
}

function writeTempHar(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-har-'));
  const file = path.join(dir, 'flow.har');
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return { file, dir };
}

/* ─────────────────────────── разбор ─────────────────────────── */

test('parseHar читает файл и отвергает посторонний документ', () => {
  const { file, dir } = writeTempHar(makeHar());
  try {
    const entries = parseHar(file);
    assert.equal(entries.length, 2);
    assert.throws(() => parseHar('{"foo":1}'), /HAR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shapeOf описывает структуру JSON до заданной глубины', () => {
  const shape = shapeOf({ a: 1, b: { c: 'x' }, list: [{ id: 1, nested: { z: true } }] }, 3);
  assert.ok(shape.includes('a: number'));
  assert.ok(shape.includes('b.c: string'));
  assert.ok(shape.some((s) => s.includes('list[]')));
});

test('discover находит эндпоинт заказов и прячет секреты', () => {
  const d = discoverFromHar(makeHar().log.entries);
  assert.deepEqual(d.hosts, ['app.example.ru']);
  // Статика отфильтрована, остаётся только API.
  assert.equal(d.endpoints.length, 1);
  assert.equal(d.endpoints[0].method, 'POST');
  assert.equal(d.endpoints[0].path, '/api/v1/courier/orders');
  assert.ok(d.orderCandidates.length >= 1);
  // Токен не должен попасть в отчёт целиком.
  const authValue = d.authHeaders.authorization || '';
  assert.ok(authValue.length > 0, 'заголовок авторизации должен быть найден');
  assert.ok(!authValue.includes('supersecrettokenvalue123'), 'значение токена не должно раскрываться');
  assert.ok(authValue.includes('…'), 'значение должно быть замаскировано');
});

/* ─────────────────────────── реплей ─────────────────────────── */

test('HarReplayProvider отдаёт заказы из захвата в канонической модели', async () => {
  const { file, dir } = writeTempHar(makeHar());
  try {
    const p = new HarReplayProvider({ harPath: file, match: '/courier/orders' });
    assert.equal(p.id, 'har');

    const data = await p.getOrders();
    assert.equal(data.orders.length, 1);
    assert.equal(data.courierId, 4242);

    const order = data.orders[0];
    assert.equal(order.id, '9304');
    assert.equal(order.source, 'har');
    assert.equal(order.points.length, 2);
    assert.equal(order.points[0].role, 'pickup');
    assert.equal(order.points[1].role, 'delivery');
    assert.equal(order.points[0].hasCoordinates, true);
    assert.equal(order.points[0].address, 'Москва, Солянка, 13');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HarReplayProvider: по захвату строится маршрут', async () => {
  const { file, dir } = writeTempHar(makeHar());
  try {
    const p = new HarReplayProvider({ harPath: file, match: '/courier/orders' });
    const data = await p.getOrders();
    const plan = await planDay({ orders: data.orders, routing: { distanceMode: 'haversine' } });
    assert.equal(plan.ordered.length, 2);
    assert.equal(plan.ordered[0].role, 'pickup', 'забор должен идти первым');
    assert.ok(plan.costKm > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HarReplayProvider: понятная ошибка, если в захвате нет нужного ответа', async () => {
  const { file, dir } = writeTempHar(makeHar());
  try {
    const p = new HarReplayProvider({ harPath: file, match: '/нет-такого-пути' });
    await assert.rejects(() => p.getOrders(), (e) => {
      assert.match(e.message, /--match/, 'подсказка про --match обязательна');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HarReplayProvider: probe перечисляет найденные эндпоинты', async () => {
  const { file, dir } = writeTempHar(makeHar());
  try {
    const p = new HarReplayProvider({ harPath: file });
    const rows = await p.probe();
    assert.equal(rows.length, 1);
    assert.match(rows[0].name, /POST .*courier\/orders/);
    assert.ok(rows[0].keys.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('фабрика: провайдер har создаётся с путём к захвату', async () => {
  const { file, dir } = writeTempHar(makeHar({ pathName: '/orders' }));
  try {
    const p = createProvider('har', { har: { harPath: file, match: '/orders' } });
    assert.equal(p.id, 'har');
    const data = await p.getOrders();
    assert.equal(data.orders.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
