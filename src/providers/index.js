/**
 * Фабрика провайдеров.
 *
 * Провайдер — это адаптер источника данных о заказах курьера.
 * Интерфейс, который должен реализовать любой провайдер:
 *
 *   id                       строка-идентификатор
 *   login()                  авторизация (если нужна)
 *   ensureAuth()             гарантировать рабочую сессию
 *   whoami()                 кто мы: профиль + courierId
 *   getOrders({date,...})    → { orders[], abandoned[], cancelled[], courierId }
 *   getOrderLocations(id)    трек по заказу
 *   probe()                  диагностика эндпоинтов
 */

import { PartnerCabinetProvider } from './partnerCabinet.js';
import { BapiProvider } from './bapi.js';
import { HarReplayProvider } from './har.js';
import { DemoProvider } from './demo.js';

export const PROVIDERS = {
  [PartnerCabinetProvider.id]: PartnerCabinetProvider,
  [BapiProvider.id]: BapiProvider,
  [HarReplayProvider.id]: HarReplayProvider,
  [DemoProvider.id]: DemoProvider,
};

export function listProviderIds() {
  return Object.keys(PROVIDERS);
}

/**
 * Создать провайдер по имени.
 * @param {string} name
 * @param {object} cfg   весь конфиг
 * @param {object} [opts] { debug, overrides }
 */
export function createProvider(name, cfg, opts = {}) {
  const Ctor = PROVIDERS[name];
  if (!Ctor) {
    throw new Error(`Неизвестный провайдер «${name}». Доступны: ${listProviderIds().join(', ')}`);
  }

  switch (name) {
    case 'partner-cabinet':
      return new Ctor({ ...(cfg.partnerCabinet || {}), ...(opts.overrides || {}) }, opts);
    case 'bapi':
      return new Ctor({ ...(cfg.bapi || {}), ...(opts.overrides || {}) }, opts);
    case 'har':
      return new Ctor({ ...(cfg.har || {}), ...(opts.overrides || {}) }, opts);
    case 'demo':
      return new Ctor({}, opts);
    default:
      return new Ctor({ ...(cfg[name] || {}), ...(opts.overrides || {}) }, opts);
  }
}

export { PartnerCabinetProvider, BapiProvider, HarReplayProvider, DemoProvider };
