# Как найти API курьерского приложения (и не зависеть от APK)

Курьерская сторона Достависты работает через мобильное приложение; веб-кабинета для
одиночного курьера компания не предлагает, а API приложения недокументирован.
Значит, эндпоинты надо один раз **обнаружить**. Ниже — рабочие способы по возрастанию
сложности. Первые два не требуют разбирать APK.

> Сначала проверьте более простой путь: возможно, вам достаточно
> курьерско-партнёрского кабинета — [API-COURIER-PARTNER.md](API-COURIER-PARTNER.md).
> Это уже готовый, проверенный API с вашими заказами и координатами точек.

---

## Способ A. Браузер (самый простой)

Подходит, если вы вообще заходите в какой-то веб-кабинет или в приложение-обёртку
на WebView.

1. Chrome/Edge → `F12` → вкладка **Network** → включите «Preserve log».
2. Выполните в интерфейсе действие «показать мои заказы».
3. Правый клик по списку запросов → **Save all as HAR with content**.
4. Разберите:

   ```bash
   node src/cli.js discover --har captures/app.har
   ```

---

## Способ B. mitmproxy (мобильное приложение)

Перехват трафика телефона. Это **разовый** замер: чтобы узнать адреса, а не чтобы
пользоваться приложением постоянно.

1. Установите mitmproxy на компьютер (<https://mitmproxy.org>).
2. Запустите:

   ```bash
   mitmproxy --save-stream-file flow.mitm
   ```

3. На телефоне укажите Wi-Fi-прокси = IP компьютера, порт `8080`.
4. Откройте на телефоне `http://mitm.it` и установите сертификат mitmproxy
   (на Android: «VPN и приложения» → «Установить сертификат» → «Сертификат ЦС»).
5. **Android 7+**: приложение доверяет только системным сертификатам. Варианты:
   * эмулятор/рутованный аппарат — перенести сертификат в `/system/etc/security/cacerts`;
   * или использовать `frida` (способ C).
6. Понажимайте в приложении «мои заказы», затем остановите mitmproxy (`q`).
7. Конвертируйте поток в HAR и разберите:

   ```bash
   mitmdump -nr flow.mitm --set hardump=out.har
   node src/cli.js discover --har out.har
   ```

---

## Способ C. Frida / objection (если включён certificate pinning)

Когда приложение проверяет сертификат и перехват рвётся:

```bash
pip install frida-tools objection
objection -g <package.name> explore
# внутри:
android sslpinning disable
```

Дальше повторяйте способ B. Пакет приложения смотрите на странице приложения в
Google Play / App Store или через `adb shell pm list packages | findstr -i dostav`.

---

## Способ D. Статический разбор APK (только чтобы найти адреса)

> Приложение здесь используется **как источник знаний о протоколе**, а не как способ
> работы. Постоянно им пользоваться не нужно — это и было вашей целью.

```bash
jadx -d out app.apk
strings out/**/*.so app.apk | findstr /i "https:// api/ dostavista"
```

Что искать: базовые URL, имена заголовков авторизации, пути вида `/api/v1/...`,
`/courier/...`, поля вроде `order_id`, `tasks`, `shift`.

---

## Что показывает `discover`

```bash
node src/cli.js discover --har captures/out.har
```

* **Хосты** — все домены, куда ходило приложение (аналитика и статика отфильтрованы).
* **Заголовки авторизации** — `authorization`, `x-*-token`, `cookie`, `x-session`…
  Значения маскируются: в отчёт попадают только начало, конец и длина.
* **Кандидаты на «заказы курьера»** — запросы, в пути которых есть
  `order|task|shift|courier|route|point|assign|profile`, вместе со схемой JSON-ответа.
* **Все эндпоинты** — метод, путь, код ответа, число повторов.

Добавьте `--json`, чтобы получить полный машинный отчёт.

---

## Как превратить находку в провайдер

Интерфейс провайдера — в `src/providers/index.js`. Минимальный шаблон:

```js
// src/providers/myAppApi.js
import { normalizeOrder } from '../lib/model.js';

export class MyAppApiProvider {
  static id = 'my-app-api';
  static title = 'API мобильного приложения (мой захват)';

  constructor(cfg = {}, opts = {}) {
    this.baseUrl = cfg.baseUrl || 'https://<хост из HAR>';
    this.token = cfg.token || '';        // заголовок/кука из HAR
  }

  get id() { return MyAppApiProvider.id; }
  async login() { return { ok: true }; }
  async ensureAuth() { return this; }
  async whoami() { return { courierId: null, partner: null }; }
  async listCouriers() { return { list: [], count: 0 }; }

  async getOrders({ date = new Date() } = {}) {
    const res = await fetch(`${this.baseUrl}/<путь из HAR>`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ date: date.toISOString().slice(0, 10) }),
    });
    const json = await res.json();
    return {
      courierId: null,
      orders: (json.orders || []).map((o) => normalizeOrder(o, { source: this.id })),
      abandoned: [], cancelled: [], locations: [], raw: json,
    };
  }

  async getOrderLocations() { return []; }
  async getProblems() { return { courier: null, problems: [], count: 0 }; }
  async probe() { return []; }
}
```

Зарегистрируйте его в `src/providers/index.js` (`PROVIDERS`, `createProvider`)
и добавьте секцию в `config.local.json`.

Пока провайдер не готов, можно работать **реплеем** уже снятого трафика:

```bash
node src/cli.js route --provider har --har captures/out.har --match /orders
```

---

## Этика и безопасность

* Перехватывайте **только свой собственный** трафик со своего устройства и своего аккаунта.
* HAR-файлы содержат cookie сессии и персональные данные клиентов (адреса, телефоны).
  Каталог `captures/` и `*.har` уже в `.gitignore` — не публикуйте их.
* Перехват трафика может нарушать пользовательское соглашение сервиса, даже если
  вы смотрите только свои данные. Оценивайте риск сами.
* Ничего не автоматизируйте в сторону *записи* (создание/принятие/отмена заказов),
  пока не убедитесь, что это разрешено: инструмент задуман как read-only помощник.
