# Бэкенд «Цветные линии» — Telegram Stars

Приём оплаты звёздами Telegram (валюта `XTR`) и честное хранение покупок/рекордов на сервере
(localStorage на клиенте легко подделать). Игра-статика остаётся на GitHub Pages, этот сервис —
отдельно (напр. Render), рядом с FitPulse.

## Что умеет
- `POST /api/invoice` — создаёт счёт (invoice link). Цену считает **сервер** по каталогу (клиент не может подделать сумму). Тело: `{ kind:'power'|'skin', id, qty, initData }`.
- `POST /webhook/<secret>` — апдейты Telegram:
  - `pre_checkout_query` → подтверждение покупки (обязательно ≤10 сек);
  - `successful_payment` → начисление покупки игроку (идемпотентно по `telegram_payment_charge_id`).
- `POST /api/state` — авторитетный баланс игрока `{ inv, skins, best, bestName }`.
- `POST /api/score` — отправить счёт в таблицу лидеров.
- `GET  /api/top` — топ-20 (для ленты «Претенденты»).
- `GET  /health` — проверка живости.

Все `/api/*` проверяют подпись `initData` Telegram WebApp (HMAC по токену бота) — нельзя прикинуться чужим.

## Каталог цен (⭐)
Должен совпадать с клиентом (`index.html`):
- Усиления: бомба 2 (×5=8), замена 1 (×5=4), передышка 1 (×5=4), продолжение 3 (×3=7).
- Скины: треники 15, спортивка 15, фрак 35, шуба 50, королевская мантия 100.

## Локальный запуск
```
cd server
cp .env.example .env     # впиши BOT_TOKEN (DATABASE_URL можно оставить пустым — тогда in-memory)
npm install
npm start
```
Без `DATABASE_URL` данные хранятся в памяти (сбрасываются при рестарте) — только для разработки.

## Деплой на Render
1. Создай Postgres (проще всего — Supabase, как у FitPulse) и возьми строку подключения → `DATABASE_URL`.
2. New → Web Service → этот репозиторий, **Root Directory = `server`** (или используй `server/render.yaml`).
3. Env vars: `BOT_TOKEN`, `DATABASE_URL`, `WEBHOOK_SECRET` (любая случайная строка), `WEBAPP_ORIGINS=https://1stgul9.github.io`, `WEBAPP_URL=https://1stgul9.github.io/colorlines/`.
4. После деплоя пропиши вебхук:
   ```
   BOT_TOKEN=... PUBLIC_URL=https://<твой-сервис>.onrender.com WEBHOOK_SECRET=... npm run setup-webhook
   ```

## Включение на клиенте
В `index.html` найди строку:
```js
const INVOICE_API=''; // пусто = демо
```
и подставь адрес эндпоинта счёта:
```js
const INVOICE_API='https://<твой-сервис>.onrender.com/api/invoice';
```
После этого клиент:
- создаёт счёт через сервер и открывает оплату `tg.openInvoice`;
- после успешной оплаты подтягивает баланс c `/api/state` (начисление делает вебхук — источник правды сервер);
- при старте тоже синхронизируется с сервером (`syncFromServer()`), демо-режим отключается автоматически.

## Важно про Telegram Stars
- Для `XTR` **не нужен** provider token; `amount` в `prices` — это число звёзд.
- Возврат средств (если понадобится): `refundStarPayment(user_id, telegram_payment_charge_id)` через Bot API.
- Цифровые товары за Stars не требуют подключения платёжного провайдера в @BotFather.
