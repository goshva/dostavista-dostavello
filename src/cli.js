#!/usr/bin/env node
/**
 * CLI курьерского коннектора.
 *
 *   node src/cli.js providers
 *   node src/cli.js login
 *   node src/cli.js whoami
 *   node src/cli.js couriers
 *   node src/cli.js orders --date 2026-11-09
 *   node src/cli.js route  --date 2026-11-09 --gpx day.gpx --csv day.csv
 *   node src/cli.js serve  --port 8787
 *   node src/cli.js probe
 *   node src/cli.js discover --har captures/flow.har
 *   node src/cli.js bapi-diagnose
 *
 * Провайдер по умолчанию — partner-cabinet. Переопределяется
 * флагом --provider или переменной DV_PROVIDER.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig, saveSession, loadSession, clearSession, SESSION_FILE } from './lib/config.js';
import { createProvider, listProviderIds } from './providers/index.js';
import { ApiError, HttpError } from './lib/http.js';
import { planDay, stopsToRows, toCsv } from './lib/planner.js';
import { toGpx, formatKm, formatDuration } from './lib/geo.js';
import { discoverFromHar, parseHar } from './providers/har.js';
import { BapiProvider } from './providers/bapi.js';

/* ─────────────────────────── разбор аргументов ─────────────────────────── */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function parseDate(v) {
  if (!v || v === true) return new Date();
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Не удалось разобрать дату: ${s}`);
  return d;
}

function parsePoint(v, label) {
  if (!v || v === true) return null;
  const [lat, lon] = String(v).split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`${label}: ожидается формат "широта,долгота", получено "${v}"`);
  }
  return { lat, lon, address: null };
}

function buildProvider(args) {
  const cfg = loadConfig();
  const name = (args.provider && args.provider !== true ? String(args.provider) : cfg.provider) || 'partner-cabinet';
  const session = loadSession();
  const overrides = {};
  if (session?.cookies) overrides.session = session.cookies.p_session || overrides.session;
  if (args.session && args.session !== true) overrides.session = String(args.session);
  if (args.email && args.email !== true) overrides.email = String(args.email);
  if (args.password && args.password !== true) overrides.password = String(args.password);
  if (args.har && args.har !== true && name === 'har') overrides.harPath = String(args.har);
  if (args.match && args.match !== true) overrides.match = String(args.match);
  if (args.courier && args.courier !== true && name === 'har') overrides.courierId = Number(args.courier);

  const provider = createProvider(name, cfg, { debug: Boolean(args.debug), overrides });
  return { provider, cfg, name };
}

function printErr(e) {
  if (e instanceof ApiError) {
    console.error(C.red(`✖ ${e.humanMessage}`));
    if (e.parameterErrors) console.error(C.dim(`  parameter_errors: ${JSON.stringify(e.parameterErrors)}`));
    console.error(C.dim(`  коды: ${e.errors.join(', ')}`));
  } else if (e instanceof HttpError) {
    console.error(C.red(`✖ ${e.message}`));
    if (e.body) console.error(C.dim(`  ${String(e.body).slice(0, 300)}`));
  } else {
    console.error(C.red(`✖ ${e?.message || e}`));
  }
}

/* ──────────────────────────────── команды ──────────────────────────────── */

async function cmdProviders() {
  console.log(C.bold('Доступные провайдеры данных:'));
  for (const id of listProviderIds()) {
    const { PROVIDERS } = await import('./providers/index.js');
    const P = PROVIDERS[id];
    console.log(`  ${C.cyan(id.padEnd(16))} ${P.title || ''}`);
  }
}

async function cmdLogin(args) {
  const { provider, name } = buildProvider(args);
  if (name === 'demo') {
    console.log(C.yellow('Провайдер demo не требует входа.'));
    return;
  }
  await provider.login();
  const cookies = provider.client?.jar?.toJSON?.() || {};
  if (Object.keys(cookies).length) {
    saveSession({ provider: name, cookies, savedAt: new Date().toISOString() });
    console.log(C.green(`✔ Сессия сохранена в ${path.relative(process.cwd(), SESSION_FILE)}`));
  } else {
    console.log(C.yellow('Сессия не содержит cookie — сохранять нечего.'));
  }
  if (provider.client?.lastServerDatetime) {
    console.log(C.dim(`  серверное время: ${provider.client.lastServerDatetime}`));
  }
}

async function cmdLogout() {
  const removed = clearSession();
  console.log(removed ? C.green('✔ Локальная сессия удалена.') : C.dim('Локальной сессии не было.'));
}

async function cmdWhoami(args) {
  const { provider } = buildProvider(args);
  await provider.ensureAuth();
  const me = await provider.whoami();
  if (args.json) {
    console.log(JSON.stringify(me, null, 2));
    return;
  }
  console.log(C.bold('Кто я'));
  const p = me.partner || {};
  console.log(`  провайдер      ${C.cyan(provider.id)}`);
  console.log(`  имя            ${p.fullName || p.full_name || p.name || '—'}`);
  console.log(`  телефон        ${p.phone || '—'}`);
  console.log(`  courier_id     ${me.courierId ?? C.yellow('не определён (укажите --courier)')}`);
  if (me.commissionPercent != null) console.log(`  комиссия       ${me.commissionPercent}%`);
}

async function cmdCouriers(args) {
  const { provider } = buildProvider(args);
  await provider.ensureAuth();
  const { list, count } = await provider.listCouriers({ limit: args.limit ? Number(args.limit) : 200 });
  if (args.json) {
    console.log(JSON.stringify({ list, count }, null, 2));
    return;
  }
  console.log(C.bold(`Курьеры (${count})`));
  for (const c of list) {
    console.log(`  ${String(c.courierId).padEnd(8)} ${(c.fullName || '—').padEnd(28)} ${(c.phone || '—').padEnd(13)} ${c.statusName}`);
  }
  if (!list.length) console.log(C.dim('  пусто'));
}

async function fetchOrders(args) {
  const { provider, cfg } = buildProvider(args);
  await provider.ensureAuth();
  const date = parseDate(args.date);
  const courierId = args.courier && args.courier !== true ? Number(args.courier) : undefined;
  const data = await provider.getOrders({ date, courierId });
  return { provider, cfg, date, data };
}

async function cmdOrders(args) {
  const { provider, data, date } = await fetchOrders(args);
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const day = date.toLocaleDateString('ru-RU');
  console.log(C.bold(`Заказы на ${day}  (провайдер: ${provider.id}, курьер: ${data.courierId ?? '—'})`));
  console.log('');
  const show = (title, arr, color) => {
    if (!arr?.length) return;
    console.log(C.bold(`${title} (${arr.length})`));
    for (const o of arr) {
      console.log(`  ${color('●')} ${C.cyan(o.id.padEnd(10))} ${o.statusName.padEnd(24)} точек: ${o.points.length}`);
      for (const p of o.points) {
        const mark = p.isVisited ? C.green('✓') : '·';
        const role = p.role === 'pickup' ? 'забор ' : 'достав';
        console.log(
          `      ${mark} ${role} ${(p.address || '—').padEnd(46)} ${p.hasCoordinates ? C.dim(`${p.lat.toFixed(5)},${p.lon.toFixed(5)}`) : C.yellow('нет координат')}`
        );
      }
    }
    console.log('');
  };
  show('В работе', data.orders, C.green);
  show('Отменённые', data.cancelled, C.red);
  show('Пропущенные', data.abandoned, C.yellow);
  if (!data.orders.length && !data.cancelled.length && !data.abandoned.length) {
    console.log(C.dim('  На эту дату заказов нет.'));
  }
}

async function cmdRoute(args) {
  const { provider, cfg, date, data } = await fetchOrders(args);
  const start = parsePoint(args.start, 'старт') || cfg.routing?.startPoint || null;
  const end = parsePoint(args.end, 'финиш') || cfg.routing?.endPoint || null;

  const plan = await planDay({
    orders: data.orders,
    routing: { ...cfg.routing, distanceMode: args.mode && args.mode !== true ? String(args.mode) : cfg.routing?.distanceMode },
    start,
    end,
    forceHeuristic: Boolean(args.heuristic),
  });

  if (args.json) {
    console.log(JSON.stringify({ date: date.toISOString(), provider: provider.id, ...plan }, null, 2));
  } else {
    console.log(C.bold(`Маршрут на ${date.toLocaleDateString('ru-RU')}`) + C.dim(`  (${plan.method}${plan.exact ? ', оптимум' : ''})`));
    console.log('');
    if (start) console.log(`  ${C.dim('старт')}    ${start.address || `${start.lat},${start.lon}`}`);
    plan.ordered.forEach((s, i) => {
      const leg = plan.legs[i];
      const legText = leg && Number.isFinite(leg.km) ? C.dim(`+${formatKm(leg.km)}`) : '';
      console.log(
        `  ${C.cyan(String(i + 1).padStart(2))}. ${(s.role === 'pickup' ? 'ЗАБОР   ' : 'ДОСТАВКА')} ${(s.address || '').padEnd(44)} ${legText}`
      );
      console.log(`      ${C.dim(`заказ ${s.orderId}${s.phone ? ' · ' + s.phone : ''}`)}`);
    });
    if (end) console.log(`  ${C.dim('финиш')}   ${end.address || `${end.lat},${end.lon}`}`);
    console.log('');
    console.log(`  ${C.bold('Итого')}: ${C.green(formatKm(plan.costKm))}, ~${formatDuration(plan.durationMin)} (${plan.distanceMode})`);
    console.log(`  ${C.dim(`точек: ${plan.ordered.length}, из них заборов: ${plan.ordered.filter((s) => s.role === 'pickup').length}`)}`);
    for (const w of plan.warnings) console.log(`  ${C.yellow('!')} ${w}`);
    if (plan.skippedOrders.length) {
      console.log(`  ${C.dim(`Пропущено заказов: ${plan.skippedOrders.length} (${plan.skippedOrders.map((s) => s.id + ': ' + s.reason).join(', ')})`)}`);
    }
  }

  const rows = stopsToRows(plan.ordered, { start });

  if (args.gpx && args.gpx !== true) {
    fs.writeFileSync(String(args.gpx), toGpx(start ? [start, ...plan.ordered] : plan.ordered));
    console.log(C.green(`✔ GPX записан: ${args.gpx}`));
  }
  if (args.csv && args.csv !== true) {
    fs.writeFileSync(String(args.csv), toCsv(rows), 'utf8');
    console.log(C.green(`✔ CSV записан: ${args.csv}`));
  }
}

async function cmdProbe(args) {
  const { provider } = buildProvider(args);
  await provider.ensureAuth();
  const results = await provider.probe();
  console.log(C.bold(`Диагностика эндпоинтов (${provider.id})`));
  for (const r of results) {
    const mark = r.ok ? C.green('OK  ') : C.red('FAIL');
    console.log(`  ${mark} ${String(r.method || '').padEnd(5)} ${String(r.path).padEnd(42)} ${r.ok ? C.dim((r.keys || []).join(', ').slice(0, 90)) : C.red(r.error || '')}`);
  }
}

async function cmdDiscover(args) {
  const har = args.har && args.har !== true ? String(args.har) : null;
  if (!har) throw new Error('Укажите файл: --har captures/flow.har');
  const entries = parseHar(har);
  const d = discoverFromHar(entries);
  console.log(C.bold(`Разбор ${har}: записей ${entries.length}`));
  console.log('');
  console.log(C.bold('Хосты:'), d.hosts.join(', ') || '—');
  console.log('');
  console.log(C.bold('Заголовки авторизации:'));
  for (const [k, v] of Object.entries(d.authHeaders)) console.log(`  ${k}: ${v}`);
  if (!Object.keys(d.authHeaders).length) console.log(C.dim('  не найдено'));
  console.log('');
  console.log(C.bold(`Кандидаты на «заказы курьера» (${d.orderCandidates.length}):`));
  for (const e of d.orderCandidates) {
    console.log(`  ${C.cyan(`${e.method} ${e.path}`)}  [${e.status}] hits=${e.hits}`);
    if (e.responseShape.length) console.log(C.dim(`      ${e.responseShape.slice(0, 10).join(', ')}`));
  }
  console.log('');
  console.log(C.bold(`Все эндпоинты (${d.endpoints.length}):`));
  for (const e of d.endpoints.slice(0, 60)) {
    console.log(`  ${String(e.method).padEnd(5)} ${e.path.padEnd(46)} [${e.status}] ×${e.hits}`);
  }
  for (const n of d.notes) console.log(C.yellow(`\n  ! ${n}`));

  if (args.json) console.log(JSON.stringify(d, null, 2));
}

async function cmdBapiDiagnose(args) {
  console.log(C.bold('Проверка задокументированных адресов BAPI…'));
  const results = await BapiProvider.diagnose({
    clientId: args.clientId && args.clientId !== true ? String(args.clientId) : '1',
    token: args.token && args.token !== true ? String(args.token) : 'diagnose',
  });
  for (const r of results) {
    const mark = r.isJson ? C.green('JSON') : r.status === 404 ? C.red('404 ') : C.yellow(String(r.status ?? 'ERR'));
    console.log(`  [${mark}] ${r.url}`);
    if (r.body) console.log(C.dim(`         ${r.body}`));
    if (r.error) console.log(C.dim(`         ${r.error}`));
  }
  console.log('');
  console.log(C.yellow('Ожидаемый итог: все адреса из документации сейчас недоступны. См. docs/API-DOSTAVISTA-BAPI.md.'));
}

async function cmdAudit(args) {
  const { provider } = buildProvider(args);
  if (!provider.client) {
    throw new Error('Аудит эндпоинтов доступен только для провайдера partner-cabinet.');
  }
  const { ENDPOINTS } = await import('./providers/partnerCabinet.js');
  const { auditEndpoints, runControl, VERDICTS } = await import('./lib/audit.js');

  const loggedIn = Boolean(provider.client.jar.get('p_session') && provider.email && provider.password);
  console.log(C.bold('Аудит карты эндпоинтов против живого сервера'));
  console.log(C.dim(`  база: ${provider.baseUrl}`));
  console.log(C.dim('  проверяются только читающие эндпоинты; меняющие состояние пропускаются'));
  console.log('');

  await provider.client.ensureCsrf();

  // Отрицательный контроль: доказательство, что признак вообще что-то значит.
  const control = await runControl(provider.client, { delayMs: args.fast ? 120 : 400 });
  for (const r of control.results) {
    console.log(C.dim(`  контроль ${r.method.padEnd(4)} ${r.path.padEnd(38)} → ${r.verdict}`));
  }
  if (!control.valid) {
    console.log('');
    console.log(C.red('  ВНИМАНИЕ: контроль не пройден — выдуманные пути выглядят как настоящие.'));
    console.log(C.red('  Результаты аудита ниже недостоверны: сервер отвечает одинаково на всё.'));
  }
  console.log('');

  const marks = {
    [VERDICTS.ROUTE_OK]: C.green('OK     '),
    [VERDICTS.OPEN]: C.yellow('ОТКРЫТ '),
    [VERDICTS.PARAMS_WRONG]: C.red('ПАРАМ  '),
    [VERDICTS.PATH_WRONG]: C.red('ПУТЬ   '),
    [VERDICTS.METHOD_WRONG]: C.red('МЕТОД  '),
    [VERDICTS.UNKNOWN_RESPONSE]: C.yellow('?      '),
    [VERDICTS.NETWORK_ERROR]: C.red('СЕТЬ   '),
  };

  const { rows, summary, skipped } = await auditEndpoints(provider.client, ENDPOINTS, {
    courierId: args.courier && args.courier !== true ? Number(args.courier) : 1,
    delayMs: args.fast ? 120 : 400,
    onResult(row) {
      const mark = marks[row.verdict] || C.yellow('?      ');
      console.log(`${mark} ${String(row.method).padEnd(4)} ${String(row.path).padEnd(42)} ${C.dim(row.detail || '')}`);
    },
  });

  console.log('');
  console.log(C.bold('Итог:'));
  console.log(`  маршрут верен (нужен только вход): ${C.green(String(summary.routeOk))} из ${summary.total}`);
  if (summary.paramsWrong) console.log(`  ${C.red('параметры отклонены: ' + summary.paramsWrong)} — см. detail выше`);
  if (summary.pathWrong) console.log(`  ${C.red('путь не найден: ' + summary.pathWrong)}`);
  if (summary.methodWrong) console.log(`  ${C.red('метод не тот: ' + summary.methodWrong)}`);
  if (summary.open) console.log(`  ${C.yellow('отдали данные без входа: ' + summary.open)}`);
  if (summary.other) console.log(`  ${C.yellow('прочие ответы: ' + summary.other)}`);
  console.log(C.dim(`  пропущено изменяющих эндпоинтов: ${skipped.length}`));

  if (args.json) {
    console.log('');
    console.log(JSON.stringify({ control, summary, rows, skipped }, null, 2));
  }
  if (!loggedIn) {
    console.log('');
    console.log(C.dim('  Аудит выполнен без сессии: видно, что маршруты и параметры принимаются,'));
    console.log(C.dim('  но не видно содержимого ответов. Для полного аудита выполните login.'));
  }
}

async function cmdServe(args) {
  const { startServer } = await import('./server.js');
  await startServer({ args });
}

function usage() {
  console.log(`${C.bold('Курьерский коннектор Достависта')}

  node src/cli.js <команда> [флаги]

${C.bold('Команды')}
  providers           список провайдеров данных
  login               войти и сохранить сессию
  logout              забыть локальную сессию
  whoami              профиль и courier_id
  couriers            список курьеров партнёра
  orders              заказы на дату
  route               маршрут на день (оптимизация порядка объезда)
  serve               поднять web-интерфейс курьера
  probe               какие эндпоинты отвечают
  audit               проверить карту эндпоинтов против живого сервера
  discover --har f    разобрать захваченный трафик и найти эндпоинты
  bapi-diagnose       проверить живость задокументированного BAPI

${C.bold('Общие флаги')}
  --provider <id>     partner-cabinet | demo | har | bapi
  --json              машинный вывод
  --debug             печатать HTTP-запросы
  --email, --password переопределить учётные данные
  --session <token>   готовая cookie p_session

${C.bold('Флаги orders / route')}
  --date YYYY-MM-DD   дата (по умолчанию сегодня)
  --courier <id>      courier_id (если не определяется автоматически)

${C.bold('Флаги route')}
  --start lat,lon     начальная точка
  --end lat,lon       конечная точка
  --mode osrm|haversine
  --heuristic         не считать точный оптимум
  --gpx file.gpx      выгрузить трек
  --csv file.csv      выгрузить список точек

${C.bold('Примеры')}
  node src/cli.js serve --provider demo
  node src/cli.js route --date 2026-11-09 --start 55.75,37.61 --gpx day.gpx
`);
}

/* ──────────────────────────────── запуск ──────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] || 'help';

  try {
    switch (cmd) {
      case 'providers': return await cmdProviders();
      case 'login': return await cmdLogin(args);
      case 'logout': return await cmdLogout();
      case 'whoami': return await cmdWhoami(args);
      case 'couriers': return await cmdCouriers(args);
      case 'orders': return await cmdOrders(args);
      case 'route': return await cmdRoute(args);
      case 'probe': return await cmdProbe(args);
      case 'audit': return await cmdAudit(args);
      case 'discover': return await cmdDiscover(args);
      case 'bapi-diagnose': return await cmdBapiDiagnose(args);
      case 'serve': return await cmdServe(args);
      case 'help':
      case '--help':
      case '-h': return usage();
      default:
        console.error(C.red(`Неизвестная команда: ${cmd}`));
        usage();
        process.exitCode = 2;
    }
  } catch (e) {
    printErr(e);
    process.exitCode = 1;
  }
}

main();
