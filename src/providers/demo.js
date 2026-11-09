/**
 * Демо-провайдер: синтетический день курьера.
 *
 * Нужен, чтобы web-интерфейс и маршрутизатор можно было посмотреть и
 * протестировать без доступа к аккаунту:
 *     node src/cli.js serve --provider demo
 */

import { normalizeOrder } from '../lib/model.js';

const BASE = { lat: 55.7558, lon: 37.6173 }; // Москва, центр

function jitter(seed, spread = 0.055) {
  // Детерминированный «шум», чтобы демо было воспроизводимым.
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * spread;
}

function mkPoint(i, orderId, seq, address, seed, visited = null) {
  const lat = BASE.lat + jitter(seed) + (seq === 0 ? 0 : 0.01);
  const lon = BASE.lon + jitter(seed + 7.3) + (seq === 0 ? 0 : 0.012);
  return {
    point_id: `${orderId}-${seq}`,
    order_id: orderId,
    sequence: seq,
    address,
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lon.toFixed(6)),
    phone: `91600000${String(i).padStart(2, '0')}`,
    status: visited ? 'visited' : 'pending',
    visited_datetime: visited,
  };
}

const SAMPLE = [
  ['Склад, Москва, Нижняя Сыромятническая, 10', 'Москва, Покровка, 27'],
  ['Москва, Арбат, 12', 'Москва, Пречистенка, 30'],
  ['Москва, Тверская, 8', 'Москва, Малая Бронная, 4'],
  ['Москва, Земляной Вал, 27', 'Москва, Солянка, 13'],
  ['Москва, Большая Дмитровка, 20', 'Москва, Петровка, 26'],
  ['Москва, Ленинский проспект, 30', 'Москва, Гагаринский пер., 5'],
  ['Москва, Кутузовский проспект, 12', 'Москва, Новый Арбат, 15'],
  ['Москва, Садовая-Кудринская, 8', 'Москва, Красная Пресня, 24'],
];

export class DemoProvider {
  static id = 'demo';
  static title = 'Демо-данные (без подключения к Достависте)';

  constructor(cfg = {}) {
    this.cfg = cfg;
    this.selfCourierId = 4242;
  }

  get id() {
    return DemoProvider.id;
  }

  async login() {
    return { demo: true };
  }

  async ensureAuth() {
    return this;
  }

  async whoami() {
    return {
      partner: { fullName: 'Демо Курьер', phone: '9160000000', email: 'demo@example.com' },
      courierId: this.selfCourierId,
      commissionPercent: 12,
    };
  }

  async listCouriers() {
    return {
      list: [
        { courierId: this.selfCourierId, fullName: 'Демо Курьер', phone: '9160000000', status: 'active', statusName: 'В работе' },
      ],
      count: 1,
    };
  }

  async resolveSelfCourierId() {
    return this.selfCourierId;
  }

  async getOrders({ date = new Date() } = {}) {
    const now = new Date(date);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(23, 59, 59, 0);
    const orders = SAMPLE.map(([pickup, drop], i) => {
      const id = String(100500 + i);
      // Первый заказ частично выполнен — проверяем, что он не попадёт в маршрут.
      const visited = i === 0 ? new Date(now.getTime() - 90 * 60000).toISOString() : null;
      return normalizeOrder(
        {
          order_id: id,
          status: i === 0 ? 'in_progress' : 'assigned',
          points: [mkPoint(i * 2 + 1, id, 0, pickup, i + 1, visited), mkPoint(i * 2 + 2, id, 1, drop, i + 20)],
        },
        { source: this.id }
      );
    });

    return {
      courierId: this.selfCourierId,
      period: { from: dayStart.toISOString(), to: dayEnd.toISOString() },
      courier: { courier_id: this.selfCourierId, full_name: 'Демо Курьер', is_working: true, has_order: true },
      orders,
      abandoned: [],
      cancelled: [
        normalizeOrder(
          {
            order_id: '100777',
            status: 'cancelled',
            points: [mkPoint(99, '100777', 0, 'Москва, отменённый забор', 3), mkPoint(98, '100777', 1, 'Москва, отменённая доставка', 4)],
          },
          { source: this.id }
        ),
      ],
      locations: [],
      raw: { demo: true },
    };
  }

  async getOrderLocations() {
    return [];
  }

  async getProblems() {
    return { courier: null, problems: [], count: 0 };
  }

  async probe() {
    return [{ name: 'demo', path: '(нет сети)', method: '-', ok: true, keys: ['orders'] }];
  }
}
