'use strict';
/*
 * Бэкенд «Цветные линии» — приём Telegram Stars (XTR) и честное хранение покупок/рекордов.
 * Деплой: отдельный web-сервис (напр. Render). Игра (статика) остаётся на GitHub Pages.
 * Включение на клиенте: в index.html задать  const INVOICE_API='https://<этот-сервер>/api/invoice'
 */
const express = require('express');
const crypto = require('crypto');
const store = require('./store');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';            // секрет в URL вебхука
const WEBAPP_ORIGINS = (process.env.WEBAPP_ORIGINS || 'https://1stgul9.github.io').split(',').map(s => s.trim());
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://1stgul9.github.io/colorlines/';

if (!BOT_TOKEN) console.warn('⚠️  BOT_TOKEN не задан — реальные платежи работать не будут (только /health).');

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description || 'tg error'}`);
  return j.result;
}

// ── Каталог — ИСТОЧНИК ПРАВДЫ по ценам (должен совпадать с клиентом) ──
const POWER = {
  bomb:     { name: 'Бомба',       unit: 2, packs: { 5: 8 } },
  shuffle:  { name: 'Замена',      unit: 1, packs: { 5: 4 } },
  breather: { name: 'Передышка',   unit: 1, packs: { 5: 4 } },
  revive:   { name: 'Продолжение', unit: 3, packs: { 3: 7 } },
};
const SKIN = {
  treniki: { name: 'Треники', price: 15 }, sport: { name: 'Спортивка', price: 15 },
  frak: { name: 'Фрак', price: 35 }, shuba: { name: 'Шуба', price: 50 }, royal: { name: 'Королевская мантия', price: 100 },
};

function priceFor(kind, id, qty) {
  qty = Math.max(1, parseInt(qty, 10) || 1);
  if (kind === 'power') {
    const it = POWER[id]; if (!it) return null;
    const stars = it.packs[qty] != null ? it.packs[qty] : it.unit * qty;
    return { stars, title: `${it.name} ×${qty}`, desc: 'Усиление для игры «Цветные линии»' };
  }
  if (kind === 'skin') {
    const it = SKIN[id]; if (!it || qty !== 1) return null;
    return { stars: it.price, title: `Образ «${it.name}»`, desc: 'Косметический образ персонажа' };
  }
  return null;
}

// ── Проверка подписи Telegram WebApp initData (защита от подделки пользователя) ──
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc !== hash) return null;
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;   // не старше суток
  try { return JSON.parse(params.get('user') || 'null'); } catch (e) { return null; }
}

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS только для нашего мини-аппа
app.use('/api', (req, res, next) => {
  const o = req.headers.origin;
  if (o && WEBAPP_ORIGINS.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, pg: store.usingPg, bot: !!BOT_TOKEN }));

// 1) Создать счёт (invoice link) на покупку — цену считает СЕРВЕР по каталогу
app.post('/api/invoice', async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.status(401).json({ error: 'Не прошла проверка Telegram' });
    const { kind, id, qty } = req.body;
    const pr = priceFor(kind, id, qty);
    if (!pr) return res.status(400).json({ error: 'Неизвестный товар' });
    const payload = JSON.stringify({ u: user.id, k: kind, id, q: Math.max(1, parseInt(qty, 10) || 1) });
    if (payload.length > 128) return res.status(400).json({ error: 'payload too long' });
    const link = await tg('createInvoiceLink', {
      title: pr.title, description: pr.desc, payload,
      currency: 'XTR', prices: [{ label: pr.title, amount: pr.stars }],   // XTR: amount = число звёзд, provider_token НЕ нужен
    });
    res.json({ link });
  } catch (e) { console.error('invoice', e); res.status(500).json({ error: 'Ошибка создания счёта' }); }
});

// 2) Авторитетный баланс игрока (инвентарь, скины, рекорд)
app.post('/api/state', async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.status(401).json({ error: 'auth' });
    res.json(await store.getProfile(user.id));
  } catch (e) { console.error('state', e); res.status(500).json({ error: 'err' }); }
});

// 3) Отправить счёт для таблицы лидеров
app.post('/api/score', async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);
    if (!user) return res.status(401).json({ error: 'auth' });
    const score = Math.max(0, parseInt(req.body.score, 10) || 0);
    const p = await store.getProfile(user.id);
    if (score > (p.best || 0)) {
      p.best = score; p.bestName = user.first_name || user.username || '—';
      await store.saveProfile(user.id, p.bestName, p);
    }
    res.json({ best: p.best });
  } catch (e) { console.error('score', e); res.status(500).json({ error: 'err' }); }
});

// 4) Таблица лидеров (для ленты «Претенденты»)
app.get('/api/top', async (req, res) => {
  try { res.json(await store.topScores(20)); } catch (e) { res.status(500).json({ error: 'err' }); }
});

// ── Webhook Telegram ──
app.post('/webhook/:secret?', async (req, res) => {
  if (WEBHOOK_SECRET && req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200);                      // отвечаем сразу, обрабатываем асинхронно
  try { await handleUpdate(req.body); } catch (e) { console.error('update', e); }
});

async function handleUpdate(update) {
  // подтверждение перед оплатой — обязателен ответ за ≤10 сек
  if (update.pre_checkout_query) {
    await tg('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    return;
  }
  const msg = update.message;
  if (msg && msg.successful_payment) {
    const sp = msg.successful_payment;
    let data; try { data = JSON.parse(sp.invoice_payload); } catch (e) { return; }
    const userId = data.u;
    // идемпотентность: один charge_id начисляем ровно раз
    const fresh = await store.registerPayment(sp.telegram_payment_charge_id, userId, sp.invoice_payload, sp.total_amount);
    if (!fresh) return;
    const p = await store.getProfile(userId);
    if (data.k === 'power') { p.inv = p.inv || {}; p.inv[data.id] = (p.inv[data.id] || 0) + (data.q || 1); }
    else if (data.k === 'skin') {
      p.skins = p.skins || { owned: ['poor'], equip: 'poor' };
      if (!p.skins.owned.includes(data.id)) p.skins.owned.push(data.id);
      p.skins.equip = data.id;
    }
    await store.saveProfile(userId, (msg.from && msg.from.first_name) || '', p);
    try { await tg('sendMessage', { chat_id: userId, text: '✅ Покупка зачислена! Открой игру — всё на месте.' }); } catch (e) {}
    return;
  }
  // /start → кнопка запуска мини-аппа (удобно, необязательно)
  if (msg && msg.text && msg.text.startsWith('/start')) {
    try {
      await tg('sendMessage', {
        chat_id: msg.chat.id, text: 'Жми, чтобы играть в «Цветные линии» 🎮',
        reply_markup: { inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: WEBAPP_URL } }]] },
      });
    } catch (e) {}
  }
}

store.init()
  .then(() => app.listen(PORT, () => console.log(`Color Lines Stars backend on :${PORT} (pg=${store.usingPg})`)))
  .catch((e) => { console.error('init failed', e); process.exit(1); });
