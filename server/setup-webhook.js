'use strict';
/*
 * Разовая настройка вебхука Telegram на этот сервер.
 * Запуск:  BOT_TOKEN=... PUBLIC_URL=https://твой-сервер WEBHOOK_SECRET=... node setup-webhook.js
 */
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const SECRET = process.env.WEBHOOK_SECRET || '';

if (!BOT_TOKEN || !BASE) { console.error('Нужны переменные BOT_TOKEN и PUBLIC_URL'); process.exit(1); }

const url = `${BASE}/webhook/${SECRET}`.replace(/\/+$/, '');
(async () => {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, allowed_updates: ['message', 'pre_checkout_query'] }),
  });
  const j = await r.json();
  console.log('setWebhook →', j);
  console.log('URL вебхука:', url);
})();
