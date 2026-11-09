/**
 * Нормализованная модель заказа.
 *
 * Разные источники (курьерско-партнёрский кабинет, официальный BAPI для
 * магазинов, HAR-захват, демо-данные) приводятся к одному виду, чтобы
 * маршрутизатор и web-интерфейс не знали, откуда пришли данные.
 */

/** Статусы заказов из официальной документации BAPI. */
export const BAPI_STATUS_NAMES = {
  0: 'Создан',
  1: 'Доступен курьерам',
  2: 'Активен (курьер назначен)',
  3: 'Завершён',
  10: 'Отменён',
  16: 'Отложен',
};

/** Человекочитаемые статусы курьерской стороны (значения приходят строками). */
export const COURIER_STATUS_NAMES = {
  created: 'Создан',
  offered: 'Предложен',
  available: 'Доступен',
  assigned: 'Назначен',
  active: 'В работе',
  in_progress: 'В работе',
  pickup: 'На заборе',
  delivery: 'На доставке',
  done: 'Выполнен',
  completed: 'Выполнен',
  finished: 'Выполнен',
  cancelled: 'Отменён',
  canceled: 'Отменён',
  abandoned: 'Пропущен',
  postponed: 'Отложен',
};

export function statusName(status, dict = COURIER_STATUS_NAMES) {
  if (status == null) return '—';
  const key = String(status).toLowerCase();
  return dict[key] || dict[status] || String(status);
}

/** Завершённые / отменённые статусы — такие точки в маршрут не берём. */
export function isTerminalStatus(status) {
  const s = String(status ?? '').toLowerCase();
  return ['done', 'completed', 'finished', 'cancelled', 'canceled', 'abandoned', '3', '10'].includes(s);
}

/**
 * Привести один «сырой» заказ к канонической форме.
 *
 * @param {object} raw
 * @param {object} [opts]
 * @param {string} [opts.source]  имя провайдера
 * @returns {{
 *   id: string, source: string, status: string|null, statusName: string,
 *   created: string|null, points: Array<object>, raw: object
 * }}
 */
export function normalizeOrder(raw, { source = 'unknown' } = {}) {
  const id = String(raw.order_id ?? raw.orderId ?? raw.id ?? '');
  const status = raw.status ?? null;
  const pointsRaw = raw.points || raw.addresses || [];

  const points = pointsRaw.map((p, i) => {
    const lat = num(p.latitude ?? p.lat ?? p.point_latitude);
    const lon = num(p.longitude ?? p.lon ?? p.lng ?? p.point_longitude);
    const visitedAt = p.visited_datetime ?? p.visitedAt ?? p.visited ?? null;
    return {
      id: String(p.point_id ?? p.pointId ?? `${id}-${i}`),
      orderId: id,
      seq: Number.isFinite(Number(p.sequence)) ? Number(p.sequence) : i,
      role: i === 0 ? 'pickup' : 'delivery',
      lat,
      lon,
      hasCoordinates: lat != null && lon != null,
      address: p.address ?? p.point_address ?? '',
      phone: p.phone ?? p.contact_phone ?? '',
      note: p.note ?? p.comment ?? '',
      status: p.status ?? null,
      visitedAt: visitedAt || null,
      isVisited: Boolean(visitedAt),
    };
  });

  return {
    id,
    source,
    status,
    statusName: raw.status_name ?? raw.statusName ?? statusName(status),
    created: raw.created ?? raw.created_datetime ?? raw.order_created_datetime ?? null,
    cost: raw.cost ?? null,
    points,
    raw,
  };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Все незакрытые заказы, у которых есть координаты. */
export function routableOrders(orders) {
  return orders.filter((o) => !isTerminalStatus(o.status) && o.points.some((p) => p.hasCoordinates));
}

/** Плоский список точек-остановок из набора заказов. */
export function toStops(orders, { includeVisited = false } = {}) {
  // Заборы, которые уже выполнены: их доставки остаются в маршруте,
  // но ограничение «забор раньше доставки» для них уже не действует.
  const visitedPickups = new Set();
  const ordersWithPickup = new Set();
  for (const o of orders) {
    for (const p of o.points) {
      if (p.role !== 'pickup') continue;
      ordersWithPickup.add(o.id);
      if (p.isVisited) visitedPickups.add(o.id);
    }
  }

  const stops = [];
  for (const o of orders) {
    for (const p of o.points) {
      if (!p.hasCoordinates) continue;
      if (!includeVisited && p.isVisited) continue;
      stops.push({
        key: `${p.orderId}:${p.id}`,
        orderId: p.orderId,
        pointId: p.id,
        role: p.role,
        lat: p.lat,
        lon: p.lon,
        address: p.address,
        phone: p.phone,
        isVisited: p.isVisited,
        visitedAt: p.visitedAt,
        /** Забор этого заказа уже сделан — ждать его не нужно. */
        pickupDone: p.role === 'delivery' && visitedPickups.has(p.orderId),
        /** Есть ли вообще точка забора у заказа в этой выборке. */
        pickupPresent: ordersWithPickup.has(p.orderId),
      });
    }
  }
  return stops;
}
