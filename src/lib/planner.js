/**
 * Связка «данные → маршрут»: общая логика для CLI и web-сервера.
 */

import { toStops, routableOrders, isTerminalStatus } from './model.js';
import { roadKm, osrmMatrix, estimateMinutes, formatKm, formatDuration } from './geo.js';
import { planRoute, buildLegs } from './route.js';

/**
 * Построить функцию расстояния. В режиме osrm один раз запрашиваем матрицу
 * и дальше работаем по индексам; при неудаче молча откатываемся на haversine.
 */
export async function makeDistanceFn(points, routing = {}) {
  const mode = routing.distanceMode || 'haversine';
  if (mode !== 'osrm') return { fn: roadKm, mode: 'haversine', warning: null };

  const idx = new Map(points.map((p, i) => [p, i]));
  const matrix = await osrmMatrix(points, { baseUrl: routing.osrmBaseUrl });
  if (!matrix) {
    return {
      fn: roadKm,
      mode: 'haversine',
      warning: 'OSRM недоступен — расстояния посчитаны по прямой с коэффициентом 1.3.',
    };
  }
  return {
    mode: 'osrm',
    warning: null,
    fn: (a, b) => {
      const i = idx.get(a);
      const j = idx.get(b);
      if (i === undefined || j === undefined) return roadKm(a, b);
      const v = matrix[i][j];
      return Number.isFinite(v) ? v : roadKm(a, b);
    },
  };
}

/**
 * Спланировать день.
 *
 * @param {object} p
 * @param {Array} p.orders        нормализованные заказы
 * @param {object} [p.routing]    конфиг routing
 * @param {object|null} [p.start] {lat,lon,address}
 * @param {object|null} [p.end]
 * @param {boolean} [p.forceHeuristic]
 */
export async function planDay({ orders, routing = {}, start = null, end = null, forceHeuristic = false } = {}) {
  const warnings = [];

  const active = routableOrders(orders);
  const skipped = orders.filter((o) => !active.includes(o));

  const stops = toStops(active);
  const noCoords = active.flatMap((o) => o.points.filter((p) => !p.hasCoordinates));
  if (noCoords.length) {
    warnings.push(
      `${noCoords.length} точк(и) без координат пропущено — включите геокодинг в config.local.json (geocoding.enabled).`
    );
  }

  if (!stops.length) {
    return {
      stops: [],
      ordered: [],
      legs: [],
      costKm: 0,
      durationMin: 0,
      method: 'empty',
      exact: true,
      warnings: [...warnings, 'Нет точек для маршрута.'],
      skippedOrders: skipped.map((o) => ({ id: o.id, status: o.status, reason: o.statusName })),
    };
  }

  // Точки для матрицы: старт + остановки + финиш.
  const matrixPoints = [...(start ? [start] : []), ...stops, ...(end ? [end] : [])];
  const { fn: distanceFn, mode, warning } = await makeDistanceFn(matrixPoints, routing);
  if (warning) warnings.push(warning);

  const plan = planRoute(stops, { start, end, distanceFn, forceHeuristic });
  const legs = buildLegs(plan.ordered, { start, distanceFn });

  if (end) legs.push({ from: plan.ordered[plan.ordered.length - 1] || start, to: end, km: distanceFn(plan.ordered[plan.ordered.length - 1] || start, end) });

  const minutes = estimateMinutes(plan.costKm, plan.ordered.length, routing);

  return {
    stops,
    ordered: plan.ordered,
    legs,
    costKm: plan.costKm,
    costText: formatKm(plan.costKm),
    durationMin: minutes,
    durationText: formatDuration(minutes),
    distanceMode: mode,
    method: plan.method,
    exact: plan.exact,
    warnings: [...warnings, ...plan.warnings],
    skippedOrders: skipped.map((o) => ({ id: o.id, status: o.status, reason: isTerminalStatus(o.status) ? o.statusName : 'нет координат' })),
  };
}

/** Плоский вид для CSV/GPX/UI. */
export function stopsToRows(ordered, { start = null } = {}) {
  return ordered.map((s, i) => ({
    n: i + 1,
    orderId: s.orderId,
    role: s.role === 'pickup' ? 'забор' : 'доставка',
    address: s.address,
    phone: s.phone,
    lat: s.lat,
    lon: s.lon,
    mapsUrl: `https://yandex.ru/maps/?rtext=~${s.lat},${s.lon}&rtt=auto`,
    pointUrl: `https://yandex.ru/maps/?pt=${s.lon},${s.lat}&z=17&l=map`,
  }));
}

export function toCsv(rows) {
  const head = ['№', 'заказ', 'действие', 'адрес', 'телефон', 'широта', 'долгота'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(';')];
  for (const r of rows) {
    lines.push([r.n, r.orderId, r.role, r.address, r.phone, r.lat, r.lon].map(esc).join(';'));
  }
  // BOM, чтобы Excel не ломал кириллицу.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
