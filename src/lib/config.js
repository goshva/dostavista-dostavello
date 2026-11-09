/**
 * Конфигурация проекта.
 *
 * Порядок поиска:
 *   1. переменные окружения (DV_*)
 *   2. config.local.json   (в .gitignore, здесь лежат секреты)
 *   3. config.json
 *   4. config.example.json (значения по умолчанию)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;

  const base = readJson(path.join(ROOT, 'config.example.json')) || {};
  let cfg = base;
  for (const name of ['config.json', 'config.local.json']) {
    const c = readJson(path.join(ROOT, name));
    if (c) cfg = deepMerge(cfg, c);
  }

  // config.example.json подставляется как база, а в нём лежат ЗАГЛУШКИ
  // («ваш-логин@example.com»). Их нельзя принимать за учётные данные: иначе
  // коннектор отправит их на сервер вместо того, чтобы сказать «настройте вход».
  cfg.partnerCabinet = cfg.partnerCabinet || {};
  if (isPlaceholderCredential(cfg.partnerCabinet.email)) cfg.partnerCabinet.email = '';
  if (isPlaceholderCredential(cfg.partnerCabinet.password)) cfg.partnerCabinet.password = '';
  if (isPlaceholderCredential(cfg.partnerCabinet.session)) cfg.partnerCabinet.session = '';
  cfg.bapi = cfg.bapi || {};
  if (isPlaceholderCredential(cfg.bapi.clientId)) cfg.bapi.clientId = '';
  if (isPlaceholderCredential(cfg.bapi.token)) cfg.bapi.token = '';

  // Переменные окружения имеют высший приоритет.
  const env = process.env;
  if (env.DV_PROVIDER) cfg.provider = env.DV_PROVIDER;
  if (env.DV_EMAIL) cfg.partnerCabinet.email = env.DV_EMAIL;
  if (env.DV_PASSWORD) cfg.partnerCabinet.password = env.DV_PASSWORD;
  if (env.DV_SESSION) cfg.partnerCabinet.session = env.DV_SESSION;
  if (env.DV_BASE_URL) cfg.partnerCabinet.baseUrl = env.DV_BASE_URL;
  if (env.DV_PORT) cfg.server = { ...(cfg.server || {}), port: Number(env.DV_PORT) };
  if (env.DV_DISTANCE_MODE) cfg.routing = { ...(cfg.routing || {}), distanceMode: env.DV_DISTANCE_MODE };

  cached = cfg;
  return cfg;
}

/** Значения-заглушки из config.example.json и пустые строки. */
const PLACEHOLDERS = new Set([
  'ваш-логин@example.com',
  'ваш-пароль',
  'your-login@example.com',
  'your-password',
  'example.com',
  '<...>',
]);

export function isPlaceholderCredential(value) {
  const v = String(value ?? '').trim();
  if (!v) return true;
  if (PLACEHOLDERS.has(v.toLowerCase())) return true;
  return /^ваш[-_ ]/i.test(v) || /^your[-_ ]/i.test(v);
}

const SESSION_FILE = path.join(ROOT, '.session.json');

export function saveSession(data) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  return SESSION_FILE;
}

export function loadSession() {
  return readJson(SESSION_FILE);
}

export function clearSession() {
  try {
    fs.unlinkSync(SESSION_FILE);
    return true;
  } catch {
    return false;
  }
}

export { SESSION_FILE };
