import crypto from 'node:crypto';
import { PIN } from './config.js';
import { one, run, now } from './db.js';

const COOKIE = 'cofre_s';
const DAYS = 180;

// Trava contra chute de PIN: 5 erros por IP = 15 min bloqueado; 20 erros no total = todos bloqueados por 15 min.
const fails = new Map(); // ip -> { n, until }
let global = { n: 0, since: Date.now(), until: 0 };
const WINDOW = 15 * 60_000;

function blocked(ip) {
  const t = Date.now();
  if (global.until > t) return Math.ceil((global.until - t) / 60_000);
  const f = fails.get(ip);
  return f && f.until > t ? Math.ceil((f.until - t) / 60_000) : 0;
}
function registerFail(ip) {
  const t = Date.now();
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) { f.until = t + WINDOW; f.n = 0; }
  fails.set(ip, f);
  if (t - global.since > WINDOW) global = { n: 0, since: t, until: 0 };
  if (++global.n >= 20) { global.until = t + WINDOW; global.n = 0; }
}

const tokenOf = (req) => (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`))?.[1];

export function authed(req) {
  if (!PIN) return true;
  const t = tokenOf(req);
  return Boolean(t && one('SELECT 1 FROM sessions WHERE token = ? AND expires_at > ?', t, now()));
}

export function login(req, res) {
  const ip = req.ip || 'x';
  const wait = blocked(ip);
  if (wait) return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${wait} min.` });
  const pin = String(req.body?.pin || '');
  const ok = !PIN || (pin.length === PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(PIN)));
  if (!ok) {
    registerFail(ip);
    return setTimeout(() => res.status(401).json({ error: 'PIN incorreto' }), 800);
  }
  fails.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  run('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)', token, now(),
    new Date(Date.now() + DAYS * 864e5).toISOString());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}

export function logout(req, res) {
  const t = tokenOf(req);
  if (t) run('DELETE FROM sessions WHERE token = ?', t);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

// "Sair de todos os aparelhos"
export function logoutAll(req, res) {
  run('DELETE FROM sessions');
  logout(req, res);
}

export const requireAuth = (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'login necessário' }));
