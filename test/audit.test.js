/**
 * Тесты аудитора эндпоинтов: классификация ответов сервера и безопасность
 * (аудитор не должен трогать изменяющие эндпоинты).
 *
 * Сеть не требуется: используется поддельный клиент.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classify,
  auditEndpoints,
  runControl,
  sampleBody,
  READ_ONLY_ENDPOINTS,
  VERDICTS,
} from '../src/lib/audit.js';
import { ApiError, HttpError } from '../src/lib/http.js';
import { ENDPOINTS } from '../src/providers/partnerCabinet.js';

/* ─────────────────────────── классификация ─────────────────────────── */

test('classify: not_logged_in означает, что маршрут верен', () => {
  const r = classify({ apiError: new ApiError(['not_logged_in'], {}) });
  assert.equal(r.verdict, VERDICTS.ROUTE_OK);
});

test('classify: access_denied — маршрут тоже верен', () => {
  const r = classify({ apiError: new ApiError(['access_denied'], {}) });
  assert.equal(r.verdict, VERDICTS.ROUTE_OK);
});

test('classify: invalid_parameters показывает, какие параметры неверны', () => {
  const e = new ApiError(['invalid_parameters'], { parameterErrors: { email: ['invalid_email'] } });
  const r = classify({ apiError: e });
  assert.equal(r.verdict, VERDICTS.PARAMS_WRONG);
  assert.match(r.detail, /invalid_email/);
});

test('classify: unknown_method и HTTP 404 — путь неверен', () => {
  assert.equal(classify({ apiError: new ApiError(['unknown_method'], {}) }).verdict, VERDICTS.PATH_WRONG);
  assert.equal(classify({ httpError: new HttpError('404', { status: 404 }) }).verdict, VERDICTS.PATH_WRONG);
});

test('classify: HTTP 405 — не тот метод, HTTP 403 — вопрос доступа', () => {
  assert.equal(classify({ httpError: new HttpError('405', { status: 405 }) }).verdict, VERDICTS.METHOD_WRONG);
  assert.equal(classify({ httpError: new HttpError('403', { status: 403 }) }).verdict, VERDICTS.ROUTE_OK);
});

test('classify: ответ без входа помечается как ОТКРЫТ (это важно заметить)', () => {
  const r = classify({ data: { is_successful: true, orders: [] } });
  assert.equal(r.verdict, VERDICTS.OPEN);
});

/* ─────────────────────────── образцы тел ─────────────────────────── */

test('sampleBody: у методов с параметрами они заданы и синтаксически корректны', () => {
  const info = sampleBody('courierInfo', { courierId: 42 });
  assert.equal(info.courier_id, 42);
  assert.match(info.from_datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(info.to_datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

  const map = sampleBody('couriersOnMap');
  assert.equal(typeof map.east_south_latitude, 'number');
  assert.equal(typeof map.east_south_longitude, 'number');
  assert.equal(typeof map.north_west_longitude, 'number');

  const list = sampleBody('couriers');
  assert.match(list.work_started_date_from, /^\d{4}-\d{2}-\d{2}$/);

  assert.deepEqual(sampleBody('myProfile'), {});
});

/* ─────────────────────────── безопасность ─────────────────────────── */

test('белый список аудита не содержит ни одного изменяющего эндпоинта', () => {
  const forbidden = [
    'logout',
    'sendRecoveryEmail',
    'editMyProfile',
    'switchPartner',
    'createCourier',
    'editCourierProfile',
    'sendSelfEmployedRequest',
    'couriersExport',
    'generateReport',
    'setInstructionUrl',
  ];
  for (const name of forbidden) {
    assert.ok(!READ_ONLY_ENDPOINTS.has(name), `${name} не должен попадать в аудит`);
  }
  // И все имена из белого списка должны существовать в карте эндпоинтов.
  for (const name of READ_ONLY_ENDPOINTS) {
    assert.ok(ENDPOINTS[name], `в ENDPOINTS нет «${name}» — опечатка в белом списке`);
  }
});

test('auditEndpoints: изменяющие эндпоинты не запрашиваются вообще', async () => {
  const called = [];
  const client = {
    async query(path, body, method) {
      called.push({ path, body, method });
      throw new ApiError(['not_logged_in'], {});
    },
  };
  const { skipped } = await auditEndpoints(client, ENDPOINTS, { delayMs: 0 });

  const forbiddenPaths = Object.entries(ENDPOINTS)
    .filter(([name]) => !READ_ONLY_ENDPOINTS.has(name))
    .map(([, ep]) => ep.path);
  for (const p of called) {
    assert.ok(!forbiddenPaths.includes(p.path), `аудитор тронул изменяющий эндпоинт ${p.path}`);
  }
  assert.ok(skipped.length > 0, 'должны быть пропущенные эндпоинты');
  assert.equal(called.length, READ_ONLY_ENDPOINTS.size);
});

/* ─────────────────────────── сводка ─────────────────────────── */

test('auditEndpoints: считает вердикты и заполняет тела запросов', async () => {
  const seen = [];
  const client = {
    async query(path, body, method) {
      seen.push({ path, body, method });
      if (path === '/partner/courier-info') {
        const e = new ApiError(['invalid_parameters'], { parameterErrors: { courier_id: ['required'] } });
        throw e;
      }
      throw new ApiError(['not_logged_in'], {});
    },
  };

  const { rows, summary } = await auditEndpoints(client, ENDPOINTS, { delayMs: 0 });
  assert.equal(summary.total, READ_ONLY_ENDPOINTS.size);
  assert.equal(summary.paramsWrong, 1);
  assert.equal(summary.routeOk, READ_ONLY_ENDPOINTS.size - 1);

  const infoRow = rows.find((r) => r.name === 'courierInfo');
  assert.equal(infoRow.verdict, VERDICTS.PARAMS_WRONG);
  assert.deepEqual(infoRow.params, { courier_id: ['required'] });

  // GET-запросы уходят без тела, POST — с телом.
  const getRow = seen.find((s) => s.path === '/partner/commission-history');
  assert.equal(getRow.method, 'GET');
  assert.deepEqual(getRow.body, {});
  const postRow = seen.find((s) => s.path === '/partner/couriers');
  assert.equal(postRow.method, 'POST');
  assert.ok(postRow.body.limit >= 1);
});

test('runControl: пустышки, отвергнутые сервером, дают valid=true', async () => {
  const client = {
    async query() {
      throw new HttpError('404', { status: 404 });
    },
  };
  const r = await runControl(client, { delayMs: 0 });
  assert.equal(r.valid, true);
  assert.equal(r.results.length, 2);
});

test('runControl: если сервер отвечает одинаково на всё — контроль НЕ пройден', async () => {
  // Худший случай: выдуманный путь тоже «выглядит настоящим».
  const client = {
    async query() {
      throw new ApiError(['not_logged_in'], {});
    },
  };
  const r = await runControl(client, { delayMs: 0 });
  assert.equal(r.valid, false, 'аудит в таком случае недостоверен и должен это признать');
});
