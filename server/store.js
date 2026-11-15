'use strict';
/*
 * Хранилище профилей и платежей.
 * Если задан DATABASE_URL → Postgres (напр. Supabase, как в FitPulse).
 * Иначе → in-memory (ТОЛЬКО для локальной разработки: данные теряются при рестарте).
 */
const DATABASE_URL = process.env.DATABASE_URL || '';
const usingPg = !!DATABASE_URL;

const STARTER = { bomb: 3, shuffle: 3, breather: 3, revive: 3 };   // подарок новому игроку (как в клиенте)
const DEFAULT_PROFILE = () => ({ inv: { ...STARTER }, skins: { owned: ['poor'], equip: 'poor' }, best: 0, bestName: '' });

let pool = null;
if (usingPg) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
}
const mem = { players: new Map(), payments: new Set() };

async function init() {
  if (!usingPg) { console.log('store: in-memory (dev). Задай DATABASE_URL для продакшена.'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id BIGINT PRIMARY KEY,
      name TEXT,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS payments (
      charge_id TEXT PRIMARY KEY,
      user_id BIGINT,
      payload TEXT,
      stars INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('store: Postgres готов.');
}

async function getProfile(userId) {
  if (!usingPg) {
    const p = mem.players.get(String(userId));
    return p ? JSON.parse(JSON.stringify(p)) : DEFAULT_PROFILE();
  }
  const r = await pool.query('SELECT profile FROM players WHERE user_id=$1', [userId]);
  if (!r.rows.length) return DEFAULT_PROFILE();
  return { ...DEFAULT_PROFILE(), ...r.rows[0].profile };
}

async function saveProfile(userId, name, profile) {
  if (!usingPg) { mem.players.set(String(userId), JSON.parse(JSON.stringify(profile))); return; }
  await pool.query(
    `INSERT INTO players(user_id,name,profile,updated_at) VALUES($1,$2,$3,now())
     ON CONFLICT(user_id) DO UPDATE SET name=EXCLUDED.name, profile=EXCLUDED.profile, updated_at=now()`,
    [userId, name || '', profile]
  );
}

// true = платёж новый (зафиксирован); false = уже обработан (защита от двойного начисления)
async function registerPayment(chargeId, userId, payload, stars) {
  if (!chargeId) return false;
  if (!usingPg) { if (mem.payments.has(chargeId)) return false; mem.payments.add(chargeId); return true; }
  try {
    await pool.query('INSERT INTO payments(charge_id,user_id,payload,stars) VALUES($1,$2,$3,$4)', [chargeId, userId, payload, stars]);
    return true;
  } catch (e) { if (e.code === '23505') return false; throw e; }   // 23505 = unique_violation
}

async function topScores(limit = 20) {
  if (!usingPg) {
    return [...mem.players.values()]
      .map((p) => ({ name: p.bestName || p.name || '—', score: p.best || 0 }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(profile->>'bestName',''), name, '—') AS name,
            COALESCE((profile->>'best')::int,0) AS score
     FROM players ORDER BY score DESC LIMIT $1`, [limit]
  );
  return r.rows.map((x) => ({ name: x.name, score: Number(x.score) }));
}

module.exports = { init, getProfile, saveProfile, registerPayment, topScores, STARTER, DEFAULT_PROFILE, usingPg };
