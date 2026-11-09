/* Курьерский web-кабинет — клиентская логика. Без сборки и зависимостей. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  provider: null,
  authenticated: false,
  me: null,
  lastPlan: null,
  map: null,
  layer: null,
};

/* ────────────────────────────── сеть ────────────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.payload = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

function alertBox(kind, text) {
  const box = $('#alerts');
  const node = el('div', `alert ${kind}`, text);
  box.appendChild(node);
  return node;
}
const clearAlerts = () => ($('#alerts').innerHTML = '');

/* ────────────────────────────── сессия ────────────────────────────── */

async function loadSession() {
  try {
    const s = await api('/api/session');
    state.provider = s.provider;
    state.authenticated = Boolean(s.authenticated);
    state.me = s;
    $('#provider-label').textContent = s.providerTitle || s.provider || '';
    renderWho();
    if (state.authenticated) await loadCouriers();
  } catch (e) {
    $('#who-text').textContent = 'сервер недоступен';
    $('#auth-dot').className = 'dot off';
    alertBox('error', `Не удалось связаться с сервером: ${e.message}`);
  }
}

function renderWho() {
  const dot = $('#auth-dot');
  const text = $('#who-text');
  const login = $('#btn-login');
  const logout = $('#btn-logout');

  if (state.authenticated) {
    const p = state.me?.partner || {};
    const name = p.fullName || p.full_name || p.name || 'курьер';
    const id = state.me?.courierId;
    dot.className = 'dot on';
    text.textContent = `${name}${id ? ` · courier_id ${id}` : ''}`;
    login.classList.add('hidden');
    logout.classList.remove('hidden');
  } else {
    dot.className = 'dot off';
    text.textContent = 'не авторизован';
    login.classList.remove('hidden');
    logout.classList.add('hidden');
  }
}

async function loadCouriers() {
  try {
    const r = await api('/api/couriers');
    const sel = $('#courier');
    sel.innerHTML = '<option value="">— авто —</option>';
    for (const c of r.list || []) {
      const o = el('option', null, `${c.fullName || 'без имени'} · ${c.phone || ''}`);
      o.value = c.courierId;
      sel.appendChild(o);
    }
    if (state.me?.courierId) sel.value = String(state.me.courierId);
  } catch {
    /* список курьеров — не критично */
  }
}

/* ─────────────────────────── построение ─────────────────────────── */

async function buildRoute() {
  clearAlerts();
  const btn = $('#btn-build');
  btn.disabled = true;
  btn.textContent = 'Считаю…';
  try {
    const body = {
      date: $('#date').value || undefined,
      courierId: $('#courier').value || undefined,
      start: parseLatLon($('#start').value),
      end: parseLatLon($('#end').value),
      mode: $('#mode').value,
    };
    const data = await api('/api/plan', { method: 'POST', body });
    state.lastPlan = data;
    render(data);

    const d = $('#date').value || new Date().toISOString().slice(0, 10);
    $('#lnk-gpx').href = `/api/export/gpx?date=${d}`;
    $('#lnk-csv').href = `/api/export/csv?date=${d}`;
  } catch (e) {
    if (e.status === 401) {
      alertBox('error', 'Нужно войти в кабинет.');
      openLogin();
    } else if (e.status === 428) {
      alertBox('warn', 'Сервер требует капчу. Войдите один раз в браузере и перенесите cookie p_session.');
      openLogin();
    } else {
      alertBox('error', `Ошибка: ${e.message}`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Построить маршрут на день';
  }
}

function parseLatLon(v) {
  if (!v || !v.trim()) return null;
  const m = v.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  return { lat: Number(m[1].replace(',', '.')), lon: Number(m[2].replace(',', '.')), address: 'заданная точка' };
}

/* ────────────────────────────── отрисовка ────────────────────────────── */

function render(data) {
  const plan = data.plan || {};
  renderStats(data, plan);
  renderStops(data.rows || []);
  renderMap(data.rows || [], plan);
  renderOrders(data);
  for (const w of plan.warnings || []) alertBox('warn', w);
}

function renderStats(data, plan) {
  const box = $('#stats');
  box.innerHTML = '';
  const add = (k, v, good) => {
    const s = el('div', `stat${good ? ' good' : ''}`);
    s.appendChild(el('div', 'v', v));
    s.appendChild(el('div', 'k', k));
    box.appendChild(s);
  };
  add('точек', String((plan.ordered || []).length), true);
  add('пробег', plan.costText || '—');
  add('время', plan.durationText || '—');
  add('заказов', String((data.orders || []).length));
  add('метод', plan.exact ? 'точный' : 'эвристика');
  if (plan.distanceMode) add('расстояния', plan.distanceMode);
}

function renderStops(rows) {
  const list = $('#stops');
  list.innerHTML = '';
  if (!rows.length) {
    list.appendChild(el('li', 'empty', 'Нет точек для маршрута на эту дату.'));
    return;
  }
  for (const r of rows) {
    const li = el('li', `stop${r.isVisited ? ' done' : ''}`);
    const n = el('div', `n${r.role === 'забор' ? ' pickup' : ''}`, String(r.n));
    const body = el('div', 'body');
    body.appendChild(el('div', 'addr', r.address || '—'));

    const meta = el('div', 'meta');
    meta.appendChild(el('span', `badge ${r.role === 'забор' ? 'pickup' : 'delivery'}`, r.role));
    meta.appendChild(el('span', null, `заказ ${r.orderId}`));
    if (r.legKm != null) meta.appendChild(el('span', null, `+${r.legKm.toFixed(1)} км`));
    body.appendChild(meta);

    const acts = el('div', 'meta');
    if (r.phone) {
      const digits = String(r.phone).replace(/\D/g, '');
      const a = el('a', 'act', `☎ ${r.phone}`);
      a.href = `tel:+7${digits.slice(-10)}`;
      acts.appendChild(a);
    }
    if (r.pointUrl) {
      const a = el('a', 'act', 'открыть в Яндекс.Картах ↗');
      a.href = r.pointUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      acts.appendChild(a);
    }
    if (r.mapsUrl) {
      const a = el('a', 'act', 'маршрут до точки ↗');
      a.href = r.mapsUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      acts.appendChild(a);
    }
    body.appendChild(acts);

    li.appendChild(n);
    li.appendChild(body);
    list.appendChild(li);
  }
}

function renderOrders(data) {
  const panel = $('#orders-panel');
  const box = $('#orders-list');
  const all = [...(data.orders || []), ...(data.abandoned || []), ...(data.cancelled || [])];
  if (!all.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#orders-count').textContent = `${all.length}`;
  box.innerHTML = '';
  for (const o of all) {
    const d = el('div', 'order');
    const head = el('div', 'head');
    head.appendChild(el('span', 'oid', `Заказ ${o.id}`));
    head.appendChild(el('span', 'badge', o.statusName || String(o.status ?? '—')));
    head.appendChild(el('span', 'muted small', `точек: ${o.points.length}`));
    d.appendChild(head);
    const pts = el('div', 'pts');
    pts.textContent = o.points
      .map((p) => `${p.role === 'pickup' ? '⬆ забор' : '⬇ доставка'}: ${p.address || '—'}${p.isVisited ? ' ✓' : ''}`)
      .join('   ·   ');
    d.appendChild(pts);
    box.appendChild(d);
  }
}

/* ─────────────────────────────── карта ─────────────────────────────── */

function renderMap(rows, plan) {
  const pts = rows.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  if (window.L && !window.__noLeaflet) {
    $('#map').classList.remove('hidden');
    $('#map-fallback').classList.add('hidden');
    drawLeaflet(pts, plan);
  } else {
    $('#map').classList.add('hidden');
    $('#map-fallback').classList.remove('hidden');
    drawSvgPlan(pts);
  }
}

function drawLeaflet(pts, plan) {
  if (!state.map) {
    state.map = L.map('map', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(state.map);
  }
  if (state.layer) state.layer.remove();
  state.layer = L.layerGroup().addTo(state.map);

  if (!pts.length) {
    state.map.setView([55.7558, 37.6173], 11);
    return;
  }

  const coords = pts.map((p) => [p.lat, p.lon]);
  L.polyline(coords, { color: '#53bb01', weight: 4, opacity: 0.85 }).addTo(state.layer);

  pts.forEach((p, i) => {
    const isPickup = p.role === 'забор';
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 11,
      color: isPickup ? '#4aa3ef' : '#53bb01',
      fillColor: '#12151b',
      fillOpacity: 1,
      weight: 3,
    }).addTo(state.layer);
    marker.bindPopup(
      `<b>${i + 1}. ${isPickup ? 'Забор' : 'Доставка'}</b><br>` +
        `${escapeHtml(p.address || '')}<br>` +
        `Заказ ${escapeHtml(String(p.orderId))}` +
        (p.phone ? `<br><a href="tel:+7${String(p.phone).replace(/\D/g, '').slice(-10)}">${escapeHtml(p.phone)}</a>` : '')
    );
    marker.bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: 'stop-label' });
  });

  state.map.fitBounds(L.latLngBounds(coords).pad(0.18));
}

function drawSvgPlan(pts) {
  const svg = $('#plan-svg');
  svg.innerHTML = '';
  if (!pts.length) return;
  const W = 600;
  const H = 420;
  const pad = 34;
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const spanLat = maxLat - minLat || 1e-4;
  const spanLon = maxLon - minLon || 1e-4;

  const X = (lon) => pad + ((lon - minLon) / spanLon) * (W - 2 * pad);
  // Широта растёт вверх, экранная ось Y — вниз.
  const Y = (lat) => H - pad - ((lat - minLat) / spanLat) * (H - 2 * pad);

  const mk = (name, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const poly = pts.map((p) => `${X(p.lon)},${Y(p.lat)}`).join(' ');
  svg.appendChild(mk('polyline', { points: poly, fill: 'none', stroke: '#53bb01', 'stroke-width': 3, opacity: 0.85 }));

  pts.forEach((p, i) => {
    const isPickup = p.role === 'забор';
    svg.appendChild(mk('circle', { cx: X(p.lon), cy: Y(p.lat), r: 12, fill: '#12151b', stroke: isPickup ? '#4aa3ef' : '#53bb01', 'stroke-width': 3 }));
    const t = mk('text', { x: X(p.lon), y: Y(p.lat) + 4, 'text-anchor': 'middle', fill: '#e7eaf0', 'font-size': 11, 'font-weight': 700 });
    t.textContent = String(i + 1);
    svg.appendChild(t);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ──────────────────────────────── модалки ──────────────────────────────── */

function openLogin() {
  $('#login-error').textContent = '';
  $('#login-modal').classList.remove('hidden');
  $('#login-email').focus();
}
const closeLogin = () => $('#login-modal').classList.add('hidden');

async function doLogin() {
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const session = $('#login-session').value.trim();
  $('#login-error').textContent = '';
  if (!session && (!email || !password)) {
    $('#login-error').textContent = 'Укажите e-mail и пароль либо cookie сессии.';
    return;
  }
  try {
    await api('/api/login', { method: 'POST', body: { email, password, session } });
    closeLogin();
    await loadSession();
    clearAlerts();
    alertBox('info', 'Вход выполнен.');
  } catch (e) {
    $('#login-error').textContent = e.payload?.error || e.message;
    if (e.payload?.codes?.includes('required_captcha')) {
      $('#login-error').textContent += ' Попробуйте вход по cookie сессии.';
    }
  }
}

async function showProbe() {
  $('#probe-modal').classList.remove('hidden');
  $('#probe-body').textContent = 'Опрашиваю эндпоинты…';
  try {
    const rows = await api('/api/probe');
    $('#probe-body').textContent = rows
      .map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${String(r.method).padEnd(5)} ${String(r.path).padEnd(42)} ${r.ok ? (r.keys || []).join(', ') : r.error}`)
      .join('\n');
  } catch (e) {
    $('#probe-body').textContent = `Ошибка: ${e.message}`;
  }
}

/* ──────────────────────────────── запуск ──────────────────────────────── */

function init() {
  $('#date').value = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD в локальной зоне

  $('#btn-build').addEventListener('click', buildRoute);
  $('#btn-login').addEventListener('click', openLogin);
  $('#btn-close-login').addEventListener('click', closeLogin);
  $('#btn-do-login').addEventListener('click', doLogin);
  $('#login-password').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());

  $('#btn-logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.authenticated = false;
    state.me = null;
    renderWho();
    clearAlerts();
    $('#stops').innerHTML = '<li class="empty">Войдите, чтобы построить маршрут.</li>';
    $('#stats').innerHTML = '';
    $('#orders-panel').hidden = true;
  });

  $('#btn-geo').addEventListener('click', () => {
    if (!navigator.geolocation) return alertBox('warn', 'Геолокация недоступна в этом браузере.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $('#start').value = `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`;
        alertBox('info', 'Координаты подставлены в поле «Старт».');
      },
      (err) => alertBox('warn', `Не удалось получить координаты: ${err.message}`)
    );
  });

  $('#btn-probe').addEventListener('click', showProbe);
  $('#btn-close-probe').addEventListener('click', () => $('#probe-modal').classList.add('hidden'));

  loadSession();
}

document.addEventListener('DOMContentLoaded', init);
