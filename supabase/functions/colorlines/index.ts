// Color Lines — Telegram Stars backend (Supabase Edge Function, Deno)
// Маршруты: /health, /setup, /api/invoice, /api/state, /api/score, /api/top, /webhook
import { createClient } from "jsr:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Секрет вебхука (secret_token + ключ /setup). Задаётся секретом окружения — в репозитории его НЕТ.
const TG_SECRET = Deno.env.get("TG_SECRET") ?? "";
const WEBAPP_URL = "https://1stgul9.github.io/colorlines/";
const ALLOW_ORIGIN = "https://1stgul9.github.io";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method: string, body: unknown) {
  const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description ?? "tg error"}`);
  return j.result;
}

// ── Каталог цен (источник правды; совпадает с клиентом) ──
const POWER: Record<string, { name: string; unit: number; packs: Record<number, number> }> = {
  bomb: { name: "Бомба", unit: 2, packs: { 5: 8 } },
  shuffle: { name: "Замена", unit: 1, packs: { 5: 4 } },
  breather: { name: "Передышка", unit: 1, packs: { 5: 4 } },
  revive: { name: "Продолжение", unit: 3, packs: { 3: 7 } },
};
const SKIN: Record<string, { name: string; price: number }> = {
  treniki: { name: "Треники", price: 15 }, sport: { name: "Спортивка", price: 15 },
  frak: { name: "Фрак", price: 35 }, shuba: { name: "Шуба", price: 50 }, royal: { name: "Королевская мантия", price: 100 },
};
function priceFor(kind: string, id: string, qty: number) {
  qty = Math.max(1, qty | 0);
  if (kind === "power") {
    const it = POWER[id]; if (!it) return null;
    const stars = it.packs[qty] ?? it.unit * qty;
    return { stars, title: `${it.name} ×${qty}`, desc: "Усиление для игры «Цветные линии»" };
  }
  if (kind === "skin") {
    const it = SKIN[id]; if (!it || qty !== 1) return null;
    return { stars: it.price, title: `Образ «${it.name}»`, desc: "Косметический образ персонажа" };
  }
  return null;
}

const STARTER = { bomb: 3, shuffle: 3, breather: 3, revive: 3 };
const defProfile = () => ({ inv: { ...STARTER }, skins: { owned: ["poor"], equip: "poor" }, best: 0, bestName: "" });

// ── Проверка подписи Telegram WebApp initData ──
const enc = (s: string) => new TextEncoder().encode(s);
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(keyBytes: Uint8Array, msg: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
}
async function verifyInitData(initData: string): Promise<any> {
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); if (!hash) return null;
  p.delete("hash");
  const dataCheck = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc("WebAppData"), enc(BOT_TOKEN));
  const calc = toHex(await hmac(secret, enc(dataCheck)));
  if (calc !== hash) return null;
  const authDate = parseInt(p.get("auth_date") || "0", 10);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

// ── Доступ к БД (service_role обходит RLS) ──
async function getProfile(userId: number) {
  const { data } = await db.from("cl_players").select("profile").eq("user_id", userId).maybeSingle();
  return data?.profile ? { ...defProfile(), ...data.profile } : defProfile();
}
async function saveProfile(userId: number, name: string, profile: unknown) {
  await db.from("cl_players").upsert({ user_id: userId, name: name || "", profile, updated_at: new Date().toISOString() });
}
async function registerPayment(chargeId: string, userId: number, payload: string, stars: number) {
  if (!chargeId) return false;
  const { error } = await db.from("cl_payments").insert({ charge_id: chargeId, user_id: userId, payload, stars });
  if (error) { if ((error as any).code === "23505") return false; throw error; }
  return true;
}

const cors = { "Access-Control-Allow-Origin": ALLOW_ORIGIN, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extra } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (path.endsWith("/health")) return json({ ok: true, bot: !!BOT_TOKEN });

  // Одноразовая настройка: вебхук + кнопка меню (открыть в браузере один раз)
  if (path.endsWith("/setup")) {
    if (!TG_SECRET || url.searchParams.get("key") !== TG_SECRET) return json({ error: "bad key" }, 403);
    const base = `${url.origin}${path.replace(/\/setup$/, "")}`;
    const out: Record<string, unknown> = {};
    try { out.webhook = await tg("setWebhook", { url: `${base}/webhook`, secret_token: TG_SECRET, allowed_updates: ["message", "pre_checkout_query"] }); } catch (e) { out.webhookError = String(e); }
    try { out.menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "🎮 Играть", web_app: { url: WEBAPP_URL } } }); } catch (e) { out.menuError = String(e); }
    return json({ ok: true, ...out });
  }

  if (path.endsWith("/api/invoice")) {
    const body = await req.json().catch(() => ({}));
    const user = await verifyInitData(body.initData);
    if (!user) return json({ error: "Не прошла проверка Telegram" }, 401, cors);
    const pr = priceFor(body.kind, body.id, body.qty);
    if (!pr) return json({ error: "Неизвестный товар" }, 400, cors);
    const payload = JSON.stringify({ u: user.id, k: body.kind, id: body.id, q: Math.max(1, (body.qty | 0) || 1) });
    if (payload.length > 128) return json({ error: "payload too long" }, 400, cors);
    try {
      const link = await tg("createInvoiceLink", { title: pr.title, description: pr.desc, payload, currency: "XTR", prices: [{ label: pr.title, amount: pr.stars }] });
      return json({ link }, 200, cors);
    } catch { return json({ error: "Ошибка создания счёта" }, 500, cors); }
  }

  if (path.endsWith("/api/state")) {
    const body = await req.json().catch(() => ({}));
    const user = await verifyInitData(body.initData);
    if (!user) return json({ error: "auth" }, 401, cors);
    return json(await getProfile(user.id), 200, cors);
  }

  if (path.endsWith("/api/score")) {
    const body = await req.json().catch(() => ({}));
    const user = await verifyInitData(body.initData);
    if (!user) return json({ error: "auth" }, 401, cors);
    const score = Math.max(0, parseInt(body.score, 10) || 0);
    const p = await getProfile(user.id);
    if (score > (p.best || 0)) { p.best = score; p.bestName = user.first_name || user.username || "—"; await saveProfile(user.id, p.bestName, p); }
    return json({ best: p.best }, 200, cors);
  }

  if (path.endsWith("/api/top")) {
    const { data } = await db.rpc("cl_leaderboard", { lim: 20 });
    return json(data || [], 200, cors);
  }

  if (path.endsWith("/webhook")) {
    if (!TG_SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== TG_SECRET) return new Response("forbidden", { status: 403 });
    const update = await req.json().catch(() => ({}));
    try { await handleUpdate(update); } catch (e) { console.error("update", e); }
    return new Response("ok");
  }

  return new Response("not found", { status: 404 });
});

async function handleUpdate(update: any) {
  if (update.pre_checkout_query) {
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    return;
  }
  const msg = update.message;
  if (msg?.successful_payment) {
    const sp = msg.successful_payment;
    let data: any; try { data = JSON.parse(sp.invoice_payload); } catch { return; }
    const fresh = await registerPayment(sp.telegram_payment_charge_id, data.u, sp.invoice_payload, sp.total_amount);
    if (!fresh) return;
    const p = await getProfile(data.u);
    if (data.k === "power") { p.inv = p.inv || {}; p.inv[data.id] = (p.inv[data.id] || 0) + (data.q || 1); }
    else if (data.k === "skin") { p.skins = p.skins || { owned: ["poor"], equip: "poor" }; if (!p.skins.owned.includes(data.id)) p.skins.owned.push(data.id); p.skins.equip = data.id; }
    await saveProfile(data.u, msg.from?.first_name || "", p);
    try { await tg("sendMessage", { chat_id: data.u, text: "✅ Покупка зачислена! Открой игру — всё на месте." }); } catch { /* ignore */ }
    return;
  }
  if (msg?.text?.startsWith("/start")) {
    try {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "Жми, чтобы играть в «Цветные линии» 🎮", reply_markup: { inline_keyboard: [[{ text: "🎮 Играть", web_app: { url: WEBAPP_URL } }]] } });
    } catch { /* ignore */ }
  }
}
