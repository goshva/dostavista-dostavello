#!/usr/bin/env node
/**
 * Проверка web-интерфейса курьера в НАСТОЯЩЕМ браузере.
 *
 * Поднимает сервер кабинета, запускает Chrome/Edge в headless-режиме,
 * подключается к нему по DevTools Protocol (CDP) и:
 *   - собирает ошибки JS и сообщения консоли;
 *   - нажимает «Построить маршрут на день»;
 *   - проверяет, что появились метрики, список остановок и карта;
 *   - проверяет порядок остановок и работу выгрузок.
 *
 * Зависимостей нет: WebSocket и fetch — встроенные в Node.
 *
 * Запуск:  node tools/ui-check.mjs [--provider demo] [--keep-open]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────── поиск браузера ─────────────────────────── */

function findBrowser() {
  const candidates = [
    process.env.DV_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* пропускаем */
    }
  }
  return null;
}

/* ─────────────────────────── мини-CDP-клиент ─────────────────────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  /** Выполнить выражение в странице и вернуть значение. */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`Исключение в странице: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    }
    return r.result?.value;
  }
}

/* ─────────────────────────── вспомогательное ─────────────────────────── */

async function waitForPort(port, { timeout = 20000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* ещё не поднялся */
    }
    await sleep(150);
  }
  throw new Error('Браузер не открыл отладочный порт');
}

async function waitForHttp(url, { timeout = 25000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
    await sleep(150);
  }
  throw new Error(`Сервер не ответил по ${url}`);
}

async function evalUntil(cdp, expression, predicate, { timeout = 20000, interval = 200, label = 'условия' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await cdp.evaluate(expression);
    if (predicate(last)) return last;
    await sleep(interval);
  }
  throw new Error(`Таймаут ожидания ${label}. Последнее значение: ${JSON.stringify(last)}`);
}

/* ──────────────────────────────── сценарий ──────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const provider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'demo';
  const keepOpen = args.includes('--keep-open');
  /** Сценарий «пользователь не авторизован»: ждём форму входа, а не маршрут. */
  const expectLogin = args.includes('--expect-login');

  const browser = findBrowser();
  if (!browser) {
    console.log(C.warn('Браузер (Chrome/Edge) не найден — проверка интерфейса пропущена.'));
    console.log(C.dim('Укажите путь явно: DV_BROWSER="C:\\путь\\chrome.exe" node tools/ui-check.mjs'));
    return 0;
  }
  console.log(C.bold('Проверка web-интерфейса в реальном браузере'));
  console.log(C.dim(`  браузер:  ${browser}`));

  const appPort = 8700 + Math.floor(Math.random() * 200);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-ui-'));
  let server = null;
  let browserProc = null;
  const problems = [];
  const consoleErrors = [];
  const pageExceptions = [];

  try {
    // 1. Сервер кабинета
    server = spawn(process.execPath, ['src/cli.js', 'serve', '--provider', provider, '--port', String(appPort)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`);
    console.log(C.dim(`  сервер:   http://127.0.0.1:${appPort} (${provider})`));

    // 2. Браузер
    browserProc = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    // Порт отладки Chrome печатает в stderr.
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('не дождались DevTools listening')), 20000);
      browserProc.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
      browserProc.on('exit', (code) => reject(new Error(`браузер завершился с кодом ${code}`)));
    });
    const debugPort = Number(new URL(wsUrl).port);
    await waitForPort(debugPort);
    console.log(C.dim(`  отладка:  порт ${debugPort}`));

    // 3. Страница-цель
    let targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    let page = targets.find((t) => t.type === 'page');
    if (!page) {
      page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('не удалось подключиться к странице по CDP')), { once: true });
    });
    const cdp = new Cdp(ws);

    cdp.on('Runtime.exceptionThrown', (p) => {
      pageExceptions.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') consoleErrors.push(`${p.entry.source}: ${p.entry.text}`);
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    // 4. Открываем кабинет
    const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    await Promise.race([loaded, sleep(12000)]);
    console.log(C.dim('  страница загружена'));

    // 5. Приложение поднялось, сессия определена
    const who = await evalUntil(
      cdp,
      `return { text: document.querySelector('#who-text')?.textContent || '', dot: document.querySelector('#auth-dot')?.className || '', provider: document.querySelector('#provider-label')?.textContent || '' };`,
      (v) => v && v.text && !/проверка сессии/.test(v.text),
      { label: 'определения сессии' }
    );
    console.log(`  сессия:   ${C.dim(who.text)}  (${who.provider})`);
    if (!who.text.includes('Демо') && provider === 'demo') {
      problems.push(`ожидался демо-курьер, получено: ${who.text}`);
    }

    // 6. Нажимаем «Построить маршрут на день» — как это делает пользователь
    const clicked = await cdp.evaluate(`
      const b = document.querySelector('#btn-build');
      if (!b) return { ok: false, why: 'кнопка не найдена' };
      b.click();
      return { ok: true, disabled: b.disabled };
    `);
    if (!clicked?.ok) problems.push(`кнопка построения: ${clicked?.why}`);

    if (expectLogin) {
      // Сценарий без авторизации: должно открыться окно входа с понятным текстом.
      const st = await evalUntil(
        cdp,
        `return {
           modal: !document.querySelector('#login-modal').classList.contains('hidden'),
           alerts: [...document.querySelectorAll('#alerts .alert')].map(a => a.textContent),
           who: document.querySelector('#who-text')?.textContent || '',
           stops: document.querySelectorAll('#stops li.stop').length,
         };`,
        (v) => v && v.modal,
        { label: 'окна входа', timeout: 20000 }
      );
      console.log(`  сессия:    ${C.dim(st.who)}`);
      console.log(`  поведение: ${C.ok('открылась форма входа')}${st.alerts.length ? `, сообщение: ${C.dim(st.alerts[0])}` : ''}`);
      const check = (cond, message) => {
        if (!cond) problems.push(message);
      };
      check(st.alerts.length > 0, 'нет сообщения пользователю о необходимости входа');
      check(/войти/i.test(st.alerts.join(' ')), `сообщение не подсказывает войти: ${st.alerts.join(' ')}`);
      check(st.stops === 0, 'маршрут не должен строиться без входа');
      check(/не авторизован/i.test(st.who), `статус должен быть «не авторизован», получено: ${st.who}`);
      check(pageExceptions.length === 0, `исключения JS: ${pageExceptions.length}`);
      console.log('');
      if (problems.length) {
        console.log(C.bad(`ИТОГ: найдено проблем — ${problems.length}`));
        for (const p of problems) console.log(`  • ${p}`);
        return 1;
      }
      console.log(C.ok('ИТОГ: без авторизации интерфейс корректно просит войти, ошибок JS нет.'));
      return 0;
    }

    // 7. Ждём появления маршрута
    const stops = await evalUntil(
      cdp,
      `return document.querySelectorAll('#stops li.stop').length;`,
      (n) => n > 0,
      { label: 'списка остановок', timeout: 25000 }
    );
    console.log(`  остановок: ${C.ok(String(stops))}`);

    // 8. Собираем результат
    const summary = await cdp.evaluate(`
      const stats = [...document.querySelectorAll('#stats .stat')].map(s => ({
        k: s.querySelector('.k')?.textContent || '', v: s.querySelector('.v')?.textContent || ''
      }));
      const stops = [...document.querySelectorAll('#stops li.stop')].map(li => ({
        n: li.querySelector('.n')?.textContent || '',
        addr: li.querySelector('.addr')?.textContent || '',
        badge: li.querySelector('.badge')?.textContent || '',
        order: [...li.querySelectorAll('.meta span')].map(x => x.textContent).find(t => /^заказ/.test(t)) || '',
        tel: li.querySelector('a[href^="tel:"]')?.getAttribute('href') || '',
        maps: !!li.querySelector('a.act[target="_blank"]'),
        actions: li.querySelectorAll('a.act').length,
      }));
      const alerts = [...document.querySelectorAll('#alerts .alert')].map(a => a.textContent);
      return {
        stats, stops, alerts,
        hasLeaflet: typeof window.L !== 'undefined' && !window.__noLeaflet,
        mapVisible: !document.querySelector('#map').classList.contains('hidden'),
        fallbackVisible: !document.querySelector('#map-fallback').classList.contains('hidden'),
        svgPoints: document.querySelectorAll('#plan-svg circle').length,
        gpxHref: document.querySelector('#lnk-gpx')?.getAttribute('href') || '',
        csvHref: document.querySelector('#lnk-csv')?.getAttribute('href') || '',
        ordersPanelHidden: document.querySelector('#orders-panel')?.hidden,
        ordersCount: document.querySelector('#orders-count')?.textContent || '',
      };
    `);

    const stat = (k) => summary.stats.find((s) => s.k === k)?.v ?? '—';
    console.log(`  метрики:   точек ${C.bold(stat('точек'))}, пробег ${C.bold(stat('пробег'))}, время ${C.bold(stat('время'))}, заказов ${stat('заказов')}, метод ${stat('метод')}`);
    console.log(`  карта:     ${summary.hasLeaflet ? C.ok('Leaflet активен') : C.warn('Leaflet недоступен → SVG-схема')}${summary.mapVisible ? '' : ', контейнер скрыт'}${summary.fallbackVisible ? `, точек на схеме: ${summary.svgPoints}` : ''}`);

    // 9. Проверки
    const check = (cond, message) => {
      if (!cond) problems.push(message);
    };
    check(summary.stops.length === stops, 'число элементов списка не совпало');
    check(summary.stops.every((s) => s.addr && s.addr !== '—'), 'есть остановки без адреса');
    check(summary.stops.every((s) => s.badge === 'забор' || s.badge === 'доставка'), 'у остановки нет роли');
    check(summary.stops.every((s) => /^заказ \d+/.test(s.order)), 'у остановки нет номера заказа');
    check(summary.stops.every((s) => s.actions >= 1), 'у остановки нет действий (маршрут/карты)');
    check(summary.stops.some((s) => s.tel.startsWith('tel:+7')), 'нет ни одной ссылки «позвонить»');
    check(summary.stops.every((s) => s.maps), 'нет ссылок «открыть в картах»');
    check(summary.stats.length >= 4, 'метрики не отрисованы');
    check(Number(stat('точек')) === summary.stops.length, 'метрика «точек» расходится со списком');
    check(/км|м/.test(stat('пробег')), 'пробег не отрисован');
    check(summary.gpxHref.includes('/api/export/gpx'), 'ссылка GPX не настроена');
    check(summary.csvHref.includes('/api/export/csv'), 'ссылка CSV не настроена');
    check(!summary.ordersPanelHidden && Number(summary.ordersCount) > 0, 'панель заказов не заполнена');
    check(summary.mapVisible || summary.fallbackVisible, 'не отрисована ни карта, ни схема');

    // Порядок: забор раньше доставки своего заказа.
    const pos = new Map();
    let precedenceOk = true;
    summary.stops.forEach((s, i) => {
      const id = s.order.replace('заказ ', '');
      if (s.badge === 'забор') pos.set(id, i);
      else if (s.badge === 'доставка' && pos.has(id) && pos.get(id) > i) precedenceOk = false;
    });
    check(precedenceOk, 'нарушен порядок: доставка раньше своего забора');

    // 10. Скачиваем выгрузку прямо со страницы
    const csvRes = await fetch(`http://127.0.0.1:${appPort}${summary.csvHref}`);
    const csvText = await csvRes.text();
    check(csvRes.ok && csvText.includes('заказ'), `CSV не выгрузился (HTTP ${csvRes.status})`);
    console.log(`  выгрузка:  CSV ${csvRes.ok ? C.ok(String(csvRes.status)) : C.bad(String(csvRes.status))}, ${C.dim(String(csvText.split('\n').length - 2) + ' строк данных')}`);

    console.log('');
    console.log(C.bold('  Первые три остановки маршрута:'));
    for (const s of summary.stops.slice(0, 3)) {
      console.log(`    ${s.n}. [${s.badge}] ${s.addr}  ${C.dim(s.order)}`);
    }
    if (summary.alerts.length) {
      console.log('');
      for (const a of summary.alerts) console.log(`  ${C.warn('предупреждение')}: ${a}`);
    }

    // 11. Ошибки JS
    if (pageExceptions.length) {
      console.log('');
      console.log(C.bad(`  Исключения в странице (${pageExceptions.length}):`));
      for (const e of pageExceptions.slice(0, 6)) console.log(C.dim(`    ${e.split('\n')[0]}`));
      problems.push(`исключения JS: ${pageExceptions.length}`);
    }
    const realConsoleErrors = consoleErrors.filter((e) => !/favicon|unpkg|net::ERR|Failed to load resource/i.test(e));
    if (realConsoleErrors.length) {
      console.log(C.bad(`  Ошибки в консоли (${realConsoleErrors.length}):`));
      for (const e of realConsoleErrors.slice(0, 6)) console.log(C.dim(`    ${e}`));
      problems.push(`ошибки консоли: ${realConsoleErrors.length}`);
    }

    console.log('');
    if (problems.length) {
      console.log(C.bad(`ИТОГ: найдено проблем — ${problems.length}`));
      for (const p of problems) console.log(`  • ${p}`);
      return 1;
    }
    console.log(C.ok('ИТОГ: интерфейс работает — маршрут построен, ошибок JS нет.'));
    return 0;
  } catch (e) {
    console.log('');
    console.log(C.bad(`ИТОГ: проверка не прошла — ${e.message}`));
    return 1;
  } finally {
    if (keepOpen) {
      console.log(C.dim('\n  --keep-open: сервер и браузер оставлены запущенными.'));
    } else {
      try {
        browserProc?.kill();
      } catch {}
      try {
        server?.kill();
      } catch {}
      await sleep(300);
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

process.exitCode = await main();
