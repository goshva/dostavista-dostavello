/**
 * Построение маршрута на день.
 *
 * Модель задачи: есть остановки (забор и доставка по каждому заказу) и
 * ограничение предшествования — у одного заказа забор обязан идти раньше
 * доставки. Нужен порядок объезда с минимальным пробегом.
 *
 *  - до 16 остановок  → точное решение (Хелд—Карп с учётом предшествования);
 *  - больше           → жадный алгоритм «ближайший доступный» + улучшение
 *                       перестановкой (relocate), которое не ломает
 *                       предшествование.
 */

import { roadKm, pathLengthKm } from './geo.js';

const EXACT_LIMIT = 16;

/** Отсортировать роли: забор всегда раньше доставки того же заказа. */
function pickupIndexMap(stops) {
  const m = new Map();
  stops.forEach((s, i) => {
    if (s.role === 'pickup') m.set(s.orderId, i);
  });
  return m;
}

/**
 * Жадный алгоритм с учётом предшествования.
 * @param {Array} stops
 * @param {{start?:object,end?:object,distanceFn?:Function}} opts
 */
export function greedyRoute(stops, { start = null, end = null, distanceFn = roadKm } = {}) {
  const remaining = stops.slice();
  const ordered = [];
  const pickupsDone = new Set();
  let current = start;

  while (remaining.length) {
    const available = remaining.filter(
      (s) => s.role === 'pickup' || pickupsDone.has(s.orderId)
    );
    // Если доставки «висят» без забора (данные неполные) — всё равно берём,
    // иначе маршрут не построится вовсе.
    const pool = available.length ? available : remaining;

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = current ? distanceFn(current, pool[i]) : 0;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const chosen = pool[bestIdx];
    remaining.splice(remaining.indexOf(chosen), 1);
    ordered.push(chosen);
    if (chosen.role === 'pickup') pickupsDone.add(chosen.orderId);
    current = chosen;
  }

  // Финиш в список остановок НЕ добавляем: он учитывается только в стоимости
  // (routeCost/buildLegs), иначе оптимизатор начал бы двигать сам финиш.
  return ordered;
}

/** Полная стоимость пути, включая старт и финиш. */
export function routeCost(ordered, { start = null, end = null, distanceFn = roadKm } = {}) {
  const seq = [];
  if (start) seq.push(start);
  seq.push(...ordered);
  if (end) seq.push(end);
  return pathLengthKm(seq, distanceFn);
}

/** Улучшение перестановкой: пробуем перенести остановку в другую позицию. */
export function improveByRelocate(ordered, { start = null, end = null, distanceFn = roadKm, passes = 50 } = {}) {
  let best = ordered.slice();
  let bestCost = routeCost(best, { start, end, distanceFn });

  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (let i = 0; i < best.length; i++) {
      for (let j = 0; j < best.length; j++) {
        if (i === j) continue;
        const candidate = best.slice();
        const [moved] = candidate.splice(i, 1);
        candidate.splice(j, 0, moved);

        // Позиции заборов пересчитываем на каждом шаге: после переноса они другие.
        if (!validPrecedence(candidate)) continue;

        const cost = routeCost(candidate, { start, end, distanceFn });
        if (cost + 1e-9 < bestCost) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { ordered: best, cost: bestCost };
}

/** Проверка, что во всей последовательности забор идёт раньше своих доставок. */
export function validPrecedence(ordered, picks = pickupIndexMap(ordered)) {
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    if (s.role !== 'delivery') continue;
    const pi = picks.get(s.orderId);
    // Нет точки забора в выборке — значит забор уже выполнен (или данных нет):
    // ограничение предшествования для такой доставки не применяется.
    if (pi === undefined) continue;
    if (pi > i) return false;
  }
  return true;
}

/**
 * Точное решение (Хелд—Карп) с ограничением предшествования.
 * Применимо к небольшим n — а день курьера это обычно 5–15 точек.
 */
export function exactRoute(stops, { start = null, end = null, distanceFn = roadKm } = {}) {
  const n = stops.length;
  if (n === 0) return { ordered: [], cost: 0, exact: true };
  if (n > EXACT_LIMIT) return null;

  // Индексы «заборов» по заказу.
  const pickupBit = new Map();
  for (let i = 0; i < n; i++) {
    if (stops[i].role === 'pickup') pickupBit.set(stops[i].orderId, i);
  }

  const size = 1 << n;
  const dp = new Float64Array(size * n).fill(Infinity);
  const parent = new Int32Array(size * n).fill(-1);

  // Предрасчёт: расстояние от старта и между остановками.
  const fromStart = stops.map((s) => (start ? distanceFn(start, s) : 0));

  const allowed = (mask, i) => {
    const s = stops[i];
    if (s.role === 'pickup') return true;
    const pb = pickupBit.get(s.orderId);
    if (pb === undefined) return true; // нет забора в данных — не блокируем
    return (mask & (1 << pb)) !== 0;
  };

  for (let i = 0; i < n; i++) {
    if (!allowed(0, i)) continue;
    dp[(1 << i) * n + i] = fromStart[i];
  }

  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      const cur = dp[mask * n + last];
      if (!Number.isFinite(cur)) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nextMask = mask | (1 << next);
        if (!allowed(nextMask, next)) continue;
        const d = distanceFn(stops[last], stops[next]);
        const cand = cur + d;
        const idx = nextMask * n + next;
        if (cand < dp[idx]) {
          dp[idx] = cand;
          parent[idx] = last;
        }
      }
    }
  }

  const full = size - 1;
  let bestLast = -1;
  let bestCost = Infinity;
  for (let last = 0; last < n; last++) {
    let c = dp[full * n + last];
    if (!Number.isFinite(c)) continue;
    if (end) c += distanceFn(stops[last], end);
    if (c < bestCost) {
      bestCost = c;
      bestLast = last;
    }
  }
  if (bestLast < 0) return null; // предшествование сделало задачу неразрешимой

  const ordered = [];
  let mask = full;
  let cur = bestLast;
  while (cur !== -1) {
    ordered.push(stops[cur]);
    const prev = parent[mask * n + cur];
    mask ^= 1 << cur;
    cur = prev;
  }
  ordered.reverse();
  return { ordered, cost: bestCost, exact: true };
}

/**
 * Главная функция: построить маршрут на день.
 *
 * @param {Array} stops остановки из toStops()
 * @param {object} opts
 * @returns {{ordered:Array, costKm:number, exact:boolean, method:string, warnings:string[]}}
 */
export function planRoute(stops, opts = {}) {
  const { start = null, end = null, distanceFn = roadKm, forceHeuristic = false } = opts;
  const warnings = [];

  if (!stops.length) {
    return { ordered: [], costKm: 0, exact: true, method: 'empty', warnings: ['Нет остановок для маршрута.'] };
  }

  // Проверяем целостность данных: доставка есть, а забора у заказа нет вовсе.
  const orphanDeliveries = stops.filter((s) => s.role === 'delivery' && s.pickupPresent === false);
  if (orphanDeliveries.length) {
    warnings.push(
      `У ${new Set(orphanDeliveries.map((s) => s.orderId)).size} заказ(ов) нет точки забора в выборке — ` +
        'порядок для них не гарантирован.'
    );
  }

  if (!forceHeuristic && stops.length <= EXACT_LIMIT) {
    const exact = exactRoute(stops, { start, end, distanceFn });
    if (exact) {
      return { ordered: exact.ordered, costKm: exact.cost, exact: true, method: 'held-karp', warnings };
    }
    warnings.push('Точное решение невозможно из-за ограничений предшествования — применён эвристический метод.');
  } else if (stops.length > EXACT_LIMIT) {
    warnings.push(`Остановок ${stops.length} — больше ${EXACT_LIMIT}, применён эвристический метод.`);
  }

  const greedy = greedyRoute(stops, { start, end, distanceFn });
  const improved = improveByRelocate(greedy, { start, end, distanceFn });
  return { ordered: improved.ordered, costKm: improved.cost, exact: false, method: 'greedy+relocate', warnings };
}

/** Разбить маршрут на перегоны для отображения и экспорта. */
export function buildLegs(ordered, { start = null, distanceFn = roadKm } = {}) {
  const seq = start ? [start, ...ordered] : ordered;
  const legs = [];
  for (let i = 1; i < seq.length; i++) {
    legs.push({
      from: seq[i - 1],
      to: seq[i],
      km: distanceFn(seq[i - 1], seq[i]),
    });
  }
  return legs;
}
