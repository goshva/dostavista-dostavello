# Официальный BAPI Достависты (сторона интернет-магазина) — актуализация

Источники, которые были запрошены для этой работы:

* Google Doc «API Dostavista для интернет-магазинов» —
  <https://docs.google.com/document/d/1-yjBzfkI9Zb44kkQB_rMcq5pNeLThyD6YbvXR9wl7IY/edit>
  (текст сохранён локально в `local-only/research/bapi-doc.txt`, в репозиторий не
  попадает: это чужой документ);
* PHP-клиент <https://github.com/kstkn/dostavista> (неофициальный, `gietos/dostavista`).

---

## 1. Итог актуализации: API закрыт

Проверено живыми запросами **2026-11-09**.

| Адрес из документации | Результат сейчас |
|---|---|
| `https://dostavista.ru/bapi/order` (GET и POST) | `404` → `{"error":"Not found"}` |
| `https://dostavista.ru/bapi/calculate` | `404` |
| `https://robot.dostavista.ru/bapi/order` | `404` → HTML-заглушка SPA «Такая страница не найдена» |
| `https://robot.dostavista.ru/bapi/` | `404` |
| `https://robotapitest.dostavista.ru/bapi/order` (тестовый контур) | `404` |
| `https://partner.dostavista.ru/bapi/order` | `404` → `{"error":"Not found"}` |
| `http://robotapi.dostavista.ru/bapi` (из README kstkn/dostavista) | **DNS-записи не существует** (`DNS name does not exist`) |
| `/api`, `/api/v1`, `/api/order`, `/openapi.json`, `/swagger.json`, `/api-docs` на всех хостах | JSON не отдают (`404`/HTML) |

Проверить самостоятельно:

```bash
node src/cli.js bapi-diagnose
```

**Вывод.** Публичный BAPI в описанном в документации виде больше не опубликован.
Токены, выданные ранее, по этим адресам не работают. Никакого публичного JSON-API
на поддоменах Достависты найти не удалось — единственная живая API-поверхность,
отдающая данные курьера, это курьерско-партнёрский кабинет
([API-COURIER-PARTNER.md](API-COURIER-PARTNER.md)).

Отдельно важно: **BAPI и не решал вашу задачу.** Он даёт заказы, созданные
*магазином* (вашим `client_id`), а не заказы, назначенные *вам как курьеру*.
Данные курьера в нём — только имя, телефон и фото курьера, назначенного на заказ.

---

## 2. Что делать, если BAPI нужен по работе

1. Напишите на `api@dostavista.ru` (в документе именно этот канал выдачи токенов)
   и запросите **актуальный боевой адрес API** и подтверждение статуса интеграции.
2. Если рабочий адрес и токен появятся — впишите их в `config.local.json`:

   ```json
   {
     "provider": "bapi",
     "bapi": { "baseUrl": "https://<выданный-хост>", "clientId": "…", "token": "…" }
   }
   ```

   Реализация задокументированного контракта уже готова в `src/providers/bapi.js`
   (`calculateOrder`, `createOrder`, `listOrders`, `getOrderInfo`, `cancelOrder`,
   `getSettings`, `setSettings`) — менять код не потребуется.
3. Не публикуйте токен: в документе прямо сказано, что при компрометации токен надо
   перегенерировать в личном кабинете («Настройки» → «Доступ к API»).

---

## 3. Задокументированный контракт (справочно, на случай восстановления доступа)

### Авторизация

`client_id` (целое, id магазина) и `token` (секрет) передаются **в каждом запросе**.
Тестовый контур: аккаунт на `https://apitest.dostavista.ru`, запрос токена письмом
на `api@dostavista.ru` («Подключение по API»), почта отправителя должна совпадать
с логином профиля. Токен перегенерируется в ЛК: «Настройки» → «Доступ к API».

Ответы — JSON. Успех: `"result": "1"` (иногда `1` числом). Ошибка:

```json
{"result":"0","error_code":[10,12],"error_message":["Incorrect phone number"]}
```

### Методы

| Назначение | Метод и путь |
|---|---|
| Расчёт стоимости | `POST /bapi/calculate` |
| Создание заказа | `POST /bapi/order` |
| Список заказов | `GET /bapi/order?client_id=&token=[&order_id[]=…]` |
| Информация о заказе | `GET /bapi/order/<order-id>?client_id=&token=[&show-points=1]` |
| Отмена заказа | `POST /bapi/cancel-order` (`order_id`, `substatus_id`) |
| Настройки: получить | `GET /bapi/client-settings` |
| Настройки: изменить | `POST /bapi/client-settings` (`bapi_callback_url`, `points_time_optional`) |

### Параметры заказа (создание/расчёт)

Общие: `require_car` (`0` пеший ≤15 кг / `1` легковой ≤200 кг / `2` грузовой),
`matter` (что везём — категория товара), `insurance` (≤ 50 000),
`backpayment_method` (`1` электронные деньги / `2` карта / `3` выкуп курьером),
`backpayment_details`, `bapi_user_agent` (для площадок, ≤ 16 символов),
`sms_notification`, `recipients_sms_notification`.

Точки, индекс `0` — забор, `1..N` — доставка:

| Параметр | Обяз. | Смысл |
|---|---|---|
| `point[i][address]` | да | «город, улица, дом» без слов «город/район/улица/дом» |
| `point[i][required_time_start]` | да | «прибыть с», ISO 8601: `YYYY-MM-DDTHH:MM:SSZ` |
| `point[i][required_time]` | да | «прибыть до», тот же формат |
| `point[i][contact_person]` | нет | имя контактного лица |
| `point[i][phone]` | да | 10 цифр без `+`, скобок и кодов |
| `point[i][weight]` | нет | для адресов доставки |
| `point[i][taking]` | нет | сумма к получению (или выкупа на точке 0 при `backpayment_method=3`) |
| `point[i][client_order_id]` | нет | номер заказа в магазине (для SMS) |
| `point[i][note]` | нет | офис/квартира, как пройти, сдача и т. п. |

Ограничения: `required_time` > `required_time_start`; время на последующей точке не
меньше, чем на предыдущей; ограничения по суммарному весу зависят от `require_car`.

### Поля информации о заказе

`order_id`, `status`, `status_name`, `created`, `cost`, `require_car`, `insurance`,
`insurance_fee`, `taking_transfer_fee`, `weight_fee`, `courier{phone, name, photo}`,
`points[]` (при `show-points=1`) с дополнительными `point_id`, `sequence`,
`is_empty_time_start`.

### Статусы заказов

| Код | Значение |
|---|---|
| 0 | создан (курьеры не видят) |
| 1 | доступен курьерам |
| 2 | активен (курьер назначен) |
| 3 | завершён |
| 10 | отменён |
| 16 | отложен |

### Причины отмены (`substatus_id`)

`1` — не нашли курьера, `3` — пропала необходимость, `4` — добавление адреса в другой заказ.

### Автоматическое извещение об изменениях

POST на `bapi_callback_url` из настроек, JSON UTF-8:

```json
{"event":"order_changed","signature":"…","data":{"order_id":"9304","status":"2","status_name":"Активен","courier":{"phone":"9198765432","name":"Иван Петров"}}}
```

`signature` = `MD5(token + JSON, в котором значение signature заменено на пустую строку)`.
Пример из документа: при `token = "AAAAAAAAAAAAAA"` подпись равна
`001f88f691f46b433e0e492be1c01d1f`.

---

## 4. Что ещё поменялось с момента написания документа

* `robotapi.dostavista.ru` (боевой хост в README `kstkn/dostavista`) — **поддомен
  больше не существует**; документация при этом указывает `https://dostavista.ru/bapi`.
* Поддомен `robot.dostavista.ru` сейчас отдаёт SPA основного сайта
  (`canonical: https://dostavista.ru/`), а не API.
* Библиотека `kstkn/dostavista` (PHP, Guzzle) не обновлялась и на новых адресах
  не заработает; её схема (`OrderRequest`, `Point`, `calculateOrder`, `createOrder`,
  `cancelOrder`) полностью соответствует контракту из §3 и учтена в
  `src/providers/bapi.js`.

---

## 5. Альтернативы для программной работы с доставкой

Если нужен именно программный доступ к доставке, есть смысл смотреть в сторону
официальных API других служб, где документация поддерживается:

* Яндекс Доставка — <https://yandex.com/support/delivery-profile/ru/api/>
* ApiShip (агрегатор, среди служб — Dostavista) — <https://docs.apiship.ru>

Для задачи «мои заказы как курьера» это не подходит — там сторона заказчика.
Ваш случай закрывает курьерско-партнёрский кабинет:
[API-COURIER-PARTNER.md](API-COURIER-PARTNER.md).
