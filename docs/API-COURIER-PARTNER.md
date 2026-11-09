# API курьерско-партнёрского кабинета Достависты

**Статус:** восстановлено реверс-инжинирингом и проверено живыми запросами 2026-11-09.
**Кабинет:** <https://partner.dostavista.ru> — SPA `courier-partner-cabinet`.
**Официальной документации нет.**

> Это единственная найденная живая HTTP-поверхность, которая отдаёт **личные данные
> курьера и его заказы**. Публичный BAPI для интернет-магазинов больше не работает
> (см. [API-DOSTAVISTA-BAPI.md](API-DOSTAVISTA-BAPI.md)).

---

## 1. Как это было восстановлено

Источники:

1. Поддомены — через журнал сертификатов: `crt.sh/?q=%.dostavista.ru` → найдены
   `couriers.dostavista.ru` (лендинг на Tilda) и `partner.dostavista.ru`.
2. Страница кабинета отдаёт бандл `/js/courier-partner-cabinet.1b72f5695f0f0f5e9501.js`.
3. Из бандла извлечены вызовы `client.query("<путь>", <тело>, "<метод>")` и код
   маппинга ответов — это дало и пути, и имена полей запросов/ответов.
4. Формы запросов проверены живыми запросами (см. §6 «Доказательства»).

Сырые материалы (бандл кабинета, карта эндпоинтов, выгрузки) лежат **локально**,
в каталоге `local-only/`, и в репозиторий не попадают — см. раздел об этике в README.

---

## 2. Транспорт и авторизация

| Аспект | Значение |
|---|---|
| База | `https://partner.dostavista.ru` (тот же origin, что и кабинет) |
| Формат | JSON, `Content-Type: application/json` |
| Методы | `POST` по умолчанию, часть методов — `GET` |
| CSRF | заголовок `X-CSRF-Token`, значение из `<meta name="csrf-token" content="…">` на `GET /` |
| Сессия | подписанный токен (Flask-подобный `payload.sig.timestamp`), носится в cookie **`p_session`** |
| Namespace | у API-сессии в payload — `courier_partner_api` (у анонимной — `client_api`) |
| Cookie от `GET /` | `session`, `dv-device`, `first_visit_*`, эксперименты `e1_ru` и т. п. |

### Конверт ответа

Любой ответ API — объект:

```json
{
  "is_successful": true,
  "errors": [],
  "parameter_errors": null,
  "session": "eyJuYW1lc3BhY2UiOiJjb3VyaWVyX3BhcnRuZXJfYXBpIn0.….…",
  "server_datetime": "2026-11-09T10:54:48+03:00",
  "…данные метода…"
}
```

* `is_successful` — единственный признак успеха. **HTTP-код всегда `200`**, даже при ошибке.
* `errors` — массив кодов. Встреченные: `invalid_credentials`, `not_logged_in`,
  `required_captcha`, `invalid_parameters`, `access_denied`.
* `parameter_errors` — объект вида `{поле: [сообщение]}`, когда `errors`
  содержит `invalid_parameters`.
* `session` — при успехе приходит свежий токен; его нужно записать в cookie `p_session`.

### Анонимная сессия, проверка входа и ротация

Практические наблюдения (проверено 2026-11-09), без которых реализация будет
ломаться:

1. **Анонимная cookie `p_session` выдаётся ещё до входа.** Простой `GET /` уже
   ставит `Set-Cookie: p_session=…` (payload с namespace `client_api`).
   Значит, «cookie есть» ≠ «мы вошли». Признак входа — только успешный ответ API
   (`is_successful: true`) либо отсутствие `not_logged_in`.
2. **Ротация сессии.** Почти каждый ответ содержит новый `session`. Если не
   записывать его обратно в cookie, сессия быстро «отвалится».
3. **Проверка делом.** Самый дешёвый способ убедиться, что сессия рабочая, —
   запросить `GET /partner/courier-partner-profile`: анонимная или протухшая
   сессия даёт `errors: ["not_logged_in"]`.
4. **CSRF обязателен только для POST.** GET-методы работают без `X-CSRF-Token`,
   но сам токен всё равно берётся со страницы `GET /`.
5. **`email` валидируется на сервере.** На пустой или некорректный адрес приходит
   `errors: ["invalid_parameters"]` с `parameter_errors: {"email":["invalid_email"]}`.
   То есть перед запросом надо проверять, что учётные данные вообще заданы, иначе
   на сервер уйдут значения-заглушки.

Пункты 1, 2 и 3 закреплены регресс-тестами в `test/partner-cabinet.test.js`
(набор поднимает локальный сервер-двойник с тем же поведением).

### Проверенные ответы об ошибках

```jsonc
// POST /partner/login с неверным паролем
{"is_successful":false,"errors":["invalid_credentials"],
 "parameter_errors":null,"session":"…","server_datetime":"2026-11-09T10:54:48+03:00"}

// GET /partner/courier-partner-profile без сессии
{"is_successful":false,"errors":["not_logged_in"], …}
```

### Капча

Если вход требует капчи, приходит `errors: ["required_captcha"]`. Тогда автоматический
вход невозможен: войдите один раз в браузере и перенесите значение cookie `p_session`
в `config.local.json` → `partnerCabinet.session` (или используйте форму
«Войти по cookie сессии» в web-кабинете).

---

## 3. Полная карта эндпоинтов

### Авторизация

| Метод | Путь | Тело запроса | Ответ |
|---|---|---|---|
| POST | `/partner/login` | `{email, password}` | `session` (+ данные партнёра) |
| POST | `/partner/logout` | `{}` | — |
| POST | `/partner/send-recovery-email` | `{email}` | — |
| POST | `/partner/courier-switch` | `{courier_id}` | `session` для смены партнёра |
| GET | `/partner/courier-partners-allowed-to-switch` | — | `courier_partners[]` |
| GET | `/partner/admin-courier-partners` | — | `courier_partners[]` |

### Профиль

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/partner/courier-partner-profile` | — | `courierPartner{}`, `courier_partner_tariff.commission_percent` |
| POST | `/partner/edit-courier-partner-profile` | `{courier_partner_tariff:{commission_percent}}` | — |

### Курьеры

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/partner/couriers` | `{work_started_date_from, work_started_date_till, status, search_text, offset, limit}` | `couriers[]`, `couriers_count` |
| POST | `/partner/couriers-export` | те же фильтры | файл |
| POST | `/partner/courier-bindings` | `{status, phone, offset, limit}` | `bindings[]`, `total_count` |
| GET | `/partner/courier-countries` | — | `countries` |
| POST | `/partner/create-courier` | данные курьера | — |
| POST | `/partner/get-courier-profile` | `{courier_id}` | профиль |
| POST | `/partner/edit-courier-profile` | данные курьера | — |
| POST | `/partner/send-self-employed-request` | `{courier_id}` | — |

Поля ответа `/partner/couriers`:
`courier_id`, `status`, `phone`, `full_name`, `work_started_datetime`, `ban_reason`.

### Курьеры на карте

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/partner/couriers-on-map` | `{is_active, has_order, east_south_latitude, east_south_longitude, north_west_latitude, north_west_longitude, phone?}` | `couriers[]`, `courier_statistics{}` |

`couriers[]`: `courier_id`, `phone`, `full_name`, `latitude`, `longitude`,
`has_coordinates`, `has_order`, `is_working`.

`courier_statistics`: `active_busy_couriers_count`, `active_free_couriers_count`,
`inactive_couriers_count`, `in_area_couriers_count`, `total_couriers_count`.

### ⭐ Заказы курьера — ключевой метод

```
POST /partner/courier-info
Тело: {courier_id, from_datetime, to_datetime}     // ISO 8601 с таймзоной
```

Ответ:

```jsonc
{
  "is_successful": true,
  "courier": {
    "courier_id": 12345,
    "full_name": "Иван Петров",
    "has_coordinates": true,
    "has_order": true,
    "is_working": true
    // …прочие поля профиля курьера
  },
  "orders":           [ /* Order */ ],
  "abandoned_orders": [ /* Order */ ],
  "cancelled_orders": [ /* Order */ ],
  "locations":        [ /* точки трека */ ]
}
```

Структура `Order` (из кода маппинга `driversOnMapOrderResponseToModel`):

```jsonc
{
  "order_id": "9304",
  "status": "active",
  "points": [
    {
      "point_id": "…",
      "order_id": "9304",
      "latitude": 55.7558,
      "longitude": 37.6173,
      "address": "Москва, Солянка, 13",
      "phone": "9161234567",
      "status": "pending",
      "visited_datetime": null      // ISO-строка, если точка уже посещена
    }
  ]
}
```

Точка с индексом `0` — **забор**, остальные — **доставка**. Наличие
`latitude`/`longitude` у точек означает, что маршрут можно строить без геокодинга.

> `courier-info` — то, что нужно для задачи «список заказов на доставку и маршрут
> на день». Именно этот метод использует коннектор.

### Точки конкретного заказа (трек)

```
POST /partner/courier-on-map-order-locations
Тело: {order_id}
Ответ: {locations: [...]}
```

### Проблемные заказы

```
POST /partner/courier-problems-report
Тело: {courier_id, limit, offset}
```

Ответ: `courier{courier_id, courier_status, courier_name, courier_phone, courier_region}`,
`problems[]`, `problems_count`.

`problems[]`: `problem_type`, `problem_created_datetime`, `order_created_datetime`,
`order_id`, `order_status`, `problem_report_status`, `first_point_address`,
`second_point_address`, `client_name`.

### Финансы и отчёты

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/partner/commission-history` | — | `courier_partner_commission_history[]` |
| POST | `/partner/report` | `{from_date, till_date}` | отчёт |
| GET | `/partner/available-financial-reports` | — | `reports[]` |
| POST | `/partner/generate-financial-report` | `{report_id}` | файл |

`courier_partner_commission_history[]`: `partner_commission_percent`,
`courier_partner_id`, `change_datetime`, `end_datetime`.

`reports[]`: `report_id`, `courier_partner_id`, `date_from`, `date_to`, `month`,
`year`, `taxation_system`, `amount`.

### Прочее

| Метод | Путь | Тело |
|---|---|---|
| GET | `/partner/get-instruction-url` | — → `instruction_url` |
| POST | `/partner/set-instruction-url` | `{instruction_url}` |

В бандле также есть служебные `/backend/browser-error-log`, `/backend/debug-log` —
это телеметрия фронтенда, коннектор их не использует.

---

## 4. Значения перечислений

Из бандла (`we`):

```js
CLASSIC       = 'classic'         // обычный партнёр
SELF_EMPLOYED = 'self_employed'   // самозанятый
TAKING        = 'taking'          // «Особый» партнёр (бейдж в выборе партнёра)
```

Статусы заказов на курьерской стороне приходят строками; сопоставление в
`src/lib/model.js` → `COURIER_STATUS_NAMES`.

---

## 5. Особенности и подводные камни

* **HTTP 200 при ошибке.** Ориентироваться только на `is_successful`.
* **CSRF обязателен** для POST; токен живёт на странице `GET /`, его нужно
  перечитывать после истечения сессии.
* **Ротация сессии.** Сервер возвращает новый `session` почти в каждом ответе —
  сохраняйте его, иначе сессия «отвалится».
* **Cookie, а не заголовок.** Токен носится как `p_session`; в бандле есть и
  `X-CSRF-Token`, но не `Authorization`.
* **`from_datetime` / `to_datetime`** — ISO 8601 с смещением
  (`2026-11-09T00:00:00+03:00`); фильтры списка курьеров — `YYYY-MM-DD`.
* **`courier_id` может не прийти в профиле.** Коннектор определяет его по телефону
  или, если курьер один, берёт единственного; иначе нужно указать явно (`--courier`).
* Кабинет — **партнёрский**: в нём есть управление курьерами парка. Коннектор
  использует из него только чтение своих данных.

---

## 6. Доказательства (проверено 2026-11-09)

```http
GET https://partner.dostavista.ru/
→ 200, <meta name="csrf-token" content="669a1d74…:2c99fcc7…">
  Set-Cookie: session=…; dv-device=…; first_visit_* =…

POST https://partner.dostavista.ru/partner/login
X-CSRF-Token: <из meta>
{"email":"probe@example.invalid","password":"x"}
→ 200 application/json
  {"is_successful":false,"errors":["invalid_credentials"], …}

GET https://partner.dostavista.ru/partner/courier-partner-profile
→ 200 application/json
  {"is_successful":false,"errors":["not_logged_in"], …}

POST https://partner.dostavista.ru/partner/login
{"email":"probe@example.invalid","password":"wrong-pass-123"}
→ 200 application/json
  {"is_successful":false,"errors":["invalid_credentials"], …}

POST https://partner.dostavista.ru/partner/login
{"email":"","password":""}
→ 200 application/json
  {"is_successful":false,"errors":["invalid_parameters"],
   "parameter_errors":{"email":["invalid_email"]}, …}
```

Это подтверждает: путь, метод, CSRF-механизм, формат конверта, валидацию
параметров и то, что эндпоинты живые. Успешные ответы (с реальными данными)
требуют вашей сессии.

---

## 7. Если сервис что-то поменяет

1. `node src/cli.js probe` — покажет, какие эндпоинты ещё отвечают.
2. Скачайте свежий бандл и повторите извлечение:
   ```powershell
   $r = Invoke-WebRequest 'https://partner.dostavista.ru/' -UseBasicParsing
   [regex]::Matches($r.Content,'/js/courier-partner-cabinet[^"]+\.js') | % { $_.Value }
   ```
3. Сравните с локальной копией карты эндпоинтов (`local-only/research/partner/endpoints.txt`)
   и поправьте `ENDPOINTS`
   в `src/providers/partnerCabinet.js`.

---

## 8. Аудит карты эндпоинтов против живого сервера

Карта выше восстановлена из бандла — это реконструкция. Чтобы она опиралась на факты,
есть команда:

```bash
node src/cli.js audit        # или: npm run audit
```

Она отправляет каждому **читающему** эндпоинту ровно то тело запроса, которое
использует коннектор, и классифицирует ответ:

| Ответ сервера | Вердикт | Что означает |
|---|---|---|
| `not_logged_in` / `access_denied` | `route-ok` | путь и метод верны, барьер — только вход |
| `invalid_parameters` | `params-wrong` | маршрут есть, но имена/значения параметров неверны (сервер говорит какие) |
| `unknown_method`, HTTP 404 | `path-wrong` | такого маршрута нет |
| HTTP 405 | `method-wrong` | маршрут есть, метод не тот |
| данные без входа | `no-auth-needed` | метод отдал данные анонимно (о таком надо знать) |

### Отрицательный контроль

Без него признак `not_logged_in` ничего не доказывал бы: вдруг сервер так отвечает
на что угодно. Поэтому аудит сначала дёргает заведомо выдуманные пути
(`/partner/definitely-not-a-method`, `/partner/courier-info-typo`). Если бы они тоже
выглядели «настоящими», команда прямо сообщила бы, что результаты недостоверны.

**Фактический результат (2026-11-09):** выдуманные пути дают **HTTP 404**, а все
настоящие эндпоинты — **HTTP 200** с `not_logged_in`. Контроль пройден, признак
содержателен.

### Результат: 15 из 15

Проверены все читающие эндпоинты — **все 15 подтверждены** живым сервером:

```
courier-partner-profile, courier-partners-allowed-to-switch, admin-courier-partners,
couriers, courier-bindings, courier-countries, get-courier-profile, couriers-on-map,
courier-info, courier-on-map-order-locations, courier-problems-report,
commission-history, report, available-financial-reports, get-instruction-url
```

11 изменяющих эндпоинтов аудит **не трогает**: инструмент не должен отправлять на
боевой сервер запросы, меняющие данные. Их наличие подтверждается только кодом бандла.

### Честная граница этого аудита

Аудит подтверждает **пути и методы**, но **не имена полей в телах POST-запросов**:
на этих эндпоинтах сервер проверяет авторизацию раньше параметров, поэтому
`invalid_parameters` без сессии не получить. Имена полей по-прежнему взяты из кода
кабинета. Единственный метод, который валидирует параметры до авторизации, —
`/partner/login`; на нём это и подтверждено.

Полный аудит (уже с содержимым ответов) выполняется после `login` — тогда же станет
видно `params-wrong`, если сервис переименовал поля.

---

## 9. Что аудит не проверяет

* имена полей в телах POST — см. границу в §8;
* изменяющие методы — намеренно;
* содержимое ответов без сессии.
