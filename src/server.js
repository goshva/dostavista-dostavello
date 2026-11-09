/**
 * Web-интерфейс курьера: HTTP-сервер + REST API + статика.
 *
 * Сервер слушает только 127.0.0.1 по умолчанию — это личный инструмент,
 * в нём живёт ваша сессия Достависты.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadSession, saveSession, clearSession } from './lib/config.js';
import { createProvider } from './providers/index.js';
import { ApiError, HttpError } from './lib/http.js';
import { planDay, stopsToRows, toCsv } from './lib/planner.js';
import { toGpx } from './lib/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

/**
 * Разобрать дату. Для «YYYY-MM-DD» берём ЛОКАЛЬНУЮ полночь:
 * new Date('2026-11-09') даёт UTC, и в западных зонах это предыдущий день.
 */
function parseDay(value) {
  if (!value) return new Date();
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // Защита от выхода за пределы каталога статики.
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/** Обёртка: превращает исключения провайдера в понятные HTTP-ответы. */
function handle(fn) {
  return async (req, res, url) => {
    try {
      await fn(req, res, url);
    } catch (e) {
      if (e instanceof ApiError) {
        // Всё, что связано со входом, — это 401, а не «плохой шлюз»:
        // клиент должен показать форму входа, а не «сервер сломался».
        const authIssue =
          e.notLoggedIn ||
          e.errors.includes('missing_credentials') ||
          e.errors.includes('invalid_credentials') ||
          e.errors.includes('invalid_session') ||
          e.errors.includes('invalid_csrf');
        const status = authIssue ? 401 : e.needsCaptcha ? 428 : 502;
        return sendJson(res, status, {
          error: e.humanMessage,
          codes: e.errors,
          parameterErrors: e.parameterErrors,
        });
      }
      if (e instanceof HttpError) {
        return sendJson(res, e.status === 404 ? 404 : 502, { error: e.message, url: e.url });
      }
      return sendJson(res, 500, { error: e?.message || String(e) });
    }
  };
}

/**
 * @param {object} p
 * @param {object} p.args  разобранные флаги CLI
 */
export async function startServer({ args = {} } = {}) {
  const cfg = loadConfig();
  const name = args.provider && args.provider !== true ? String(args.provider) : cfg.provider || 'partner-cabinet';
  const session = loadSession();
  const overrides = {};
  if (session?.provider === name && session?.cookies?.p_session) overrides.session = session.cookies.p_session;
  if (args.har && args.har !== true) overrides.harPath = String(args.har);

  const provider = createProvider(name, cfg, { debug: Boolean(args.debug), overrides });

  const host = (args.host && args.host !== true ? String(args.host) : cfg.server?.host) || '127.0.0.1';
  const port = Number(args.port && args.port !== true ? args.port : cfg.server?.port) || 8787;

  const routes = {
    'GET /api/health': handle(async (req, res) => {
      sendJson(res, 200, { ok: true, provider: provider.id, providerTitle: provider.constructor.title, time: new Date().toISOString() });
    }),

    'GET /api/session': handle(async (req, res) => {
      // Проверка сессии не должна падать: если войти нечем, это просто «не авторизован».
      // ВАЖНО: анонимная cookie p_session выдаётся сервером ещё до входа, поэтому
      // единственный надёжный признак — успешный ответ API.
      try {
        const me = await provider.whoami();
        sendJson(res, 200, { authenticated: true, provider: provider.id, ...me });
      } catch (e) {
        if (e instanceof ApiError) {
          return sendJson(res, 200, {
            authenticated: false,
            provider: provider.id,
            canLogin: Boolean(provider.email && provider.password),
            reason: e.humanMessage,
            codes: e.errors,
          });
        }
        throw e;
      }
    }),

    'POST /api/login': handle(async (req, res) => {
      const body = await readBody(req);
      if (!provider.client) return sendJson(res, 400, { error: 'Провайдер не поддерживает вход.' });

      // Пробуем вход на ОДНОРАЗОВОМ провайдере: иначе опечатка в пароле
      // «залипнет» в рабочем процессе, и восстановиться можно будет только
      // перезапуском сервера.
      const attempt = createProvider(name, cfg, {
        overrides: {
          ...(body.email ? { email: String(body.email) } : {}),
          ...(body.password ? { password: String(body.password) } : {}),
          ...(body.session ? { session: String(body.session) } : {}),
        },
      });

      await attempt.login({ force: true });
      const me = await attempt.whoami();

      // Успех — переносим сессию и рабочие учётные данные в живой провайдер.
      provider.email = attempt.email;
      provider.password = attempt.password;
      provider.sessionToken = attempt.sessionToken;
      provider.client.jar = attempt.client.jar;
      provider.client.csrfToken = attempt.client.csrfToken;
      provider.authenticated = true;
      provider.profile = null;
      provider.selfCourierId = null;

      saveSession({ provider: provider.id, cookies: provider.client.jar.toJSON(), savedAt: new Date().toISOString() });
      sendJson(res, 200, { ok: true, ...me });
    }),

    'POST /api/logout': handle(async (req, res) => {
      clearSession();
      if (provider.client) {
        provider.client.jar.set('p_session', '');
        provider.client.csrfToken = null;
      }
      provider.authenticated = false;
      provider.profile = null;
      provider.selfCourierId = null;
      sendJson(res, 200, { ok: true });
    }),

    'GET /api/couriers': handle(async (req, res) => {
      await provider.ensureAuth();
      const r = await provider.listCouriers({ limit: 200 });
      sendJson(res, 200, r);
    }),

    'GET /api/orders': handle(async (req, res, url) => {
      await provider.ensureAuth();
      const date = parseDay(url.searchParams.get('date'));
      const courierId = url.searchParams.get('courier');
      const data = await provider.getOrders({ date, courierId: courierId ? Number(courierId) : undefined });
      sendJson(res, 200, data);
    }),

    'POST /api/plan': handle(async (req, res) => {
      await provider.ensureAuth();
      const body = await readBody(req);
      const date = parseDay(body.date);
      const data = await provider.getOrders({ date, courierId: body.courierId ? Number(body.courierId) : undefined });

      const start = body.start || cfg.routing?.startPoint || null;
      const end = body.end || cfg.routing?.endPoint || null;
      const plan = await planDay({
        orders: data.orders,
        routing: { ...cfg.routing, distanceMode: body.mode || cfg.routing?.distanceMode },
        start,
        end,
      });
      sendJson(res, 200, {
        date: date.toISOString(),
        courierId: data.courierId,
        orders: data.orders,
        cancelled: data.cancelled,
        abandoned: data.abandoned,
        plan,
        rows: stopsToRows(plan.ordered, { start }),
      });
    }),

    'GET /api/export/gpx': handle(async (req, res, url) => {
      await provider.ensureAuth();
      const date = parseDay(url.searchParams.get('date'));
      const data = await provider.getOrders({ date });
      const plan = await planDay({ orders: data.orders, routing: cfg.routing });
      const text = toGpx(plan.ordered, { name: `Маршрут ${date.toLocaleDateString('ru-RU')}` });
      sendText(res, 200, text, 'application/gpx+xml; charset=utf-8', {
        'Content-Disposition': `attachment; filename="route-${date.toISOString().slice(0, 10)}.gpx"`,
      });
    }),

    'GET /api/export/csv': handle(async (req, res, url) => {
      await provider.ensureAuth();
      const date = parseDay(url.searchParams.get('date'));
      const data = await provider.getOrders({ date });
      const plan = await planDay({ orders: data.orders, routing: cfg.routing });
      sendText(res, 200, toCsv(stopsToRows(plan.ordered)), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="route-${date.toISOString().slice(0, 10)}.csv"`,
      });
    }),

    'GET /api/probe': handle(async (req, res) => {
      await provider.ensureAuth();
      sendJson(res, 200, await provider.probe());
    }),

    'GET /api/endpoints': handle(async (req, res) => {
      const { ENDPOINTS } = await import('./providers/partnerCabinet.js');
      sendJson(res, 200, ENDPOINTS);
    }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(res, url.pathname);
    }
    const handler = routes[key];
    if (!handler) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: `Нет такого метода: ${key}` });
      return sendText(res, 404, 'Not found');
    }
    return handler(req, res, url);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`\n  Курьерский web-кабинет:  http://${shown}:${port}`);
  console.log(`  Провайдер:               ${provider.id} (${provider.constructor.title || ''})`);
  console.log(`  Остановить:              Ctrl+C\n`);

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
