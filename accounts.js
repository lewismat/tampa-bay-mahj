/**
 * accounts.js — Tampa Bay Mahj: staff logins, Holly's profile card, student CRM.
 * Mounted from server.js with:  app.use(require('./accounts'));
 * No npm packages beyond express. Passwords hashed with Node's built-in scrypt.
 *
 * Env: SUPABASE_URL, SUPABASE_KEY (as elsewhere). Optional SESSION_SECRET.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || 'tbm-session-fallback-2026';
const COOKIE = 'tbm_session';
const SESSION_DAYS = 14;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[accounts] SUPABASE_URL / SUPABASE_KEY not set — account routes will error.');
}

router.use(express.json());

/* ---------------- Supabase REST ---------------- */
async function sb(pathname, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : (data && data.message) || `Supabase ${res.status}`);
  return data;
}
const enc = (v) => encodeURIComponent(v);
const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/* ---------------- password hashing (scrypt) ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- signed session cookie ---------------- */
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p.exp || Date.now() > p.exp) return null;
  return p;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSession(res, account) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const token = signToken({ id: account.id, role: account.role, name: account.name, exp });
  res.set('Set-Cookie', `${COOKIE}=${enc(token)}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax`);
}
function currentUser(req) { return verifyToken(parseCookies(req)[COOKIE]); }
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Please sign in.' });
  req.account = u; next();
}
function requireOwner(req, res, next) {
  if (!req.account || req.account.role !== 'owner') return res.status(403).json({ ok: false, error: 'Owner only.' });
  next();
}
async function accountCount() {
  const rows = await sb('accounts?select=id');
  return Array.isArray(rows) ? rows.length : 0;
}

/* ================= AUTH ================= */
router.get('/api/auth/state', async (req, res) => {
  try {
    const u = currentUser(req);
    const needsSetup = (await accountCount()) === 0;
    res.json({ ok: true, authed: !!u, needsSetup, user: u ? { id: u.id, role: u.role, name: u.name } : null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// First-run: create the first owner account (only allowed while zero accounts exist).
router.post('/api/auth/setup', async (req, res) => {
  try {
    if ((await accountCount()) > 0) return res.status(403).json({ ok: false, error: 'Setup already complete. Please sign in.' });
    const name = clean(req.body.name, 120), email = clean(req.body.email, 200).toLowerCase();
    const username = clean(req.body.username, 60).toLowerCase(), password = String(req.body.password || '');
    if (!name || !isEmail(email) || !username || password.length < 8)
      return res.status(400).json({ ok: false, error: 'Name, valid email, username, and an 8+ character password are required.' });
    const rows = await sb('accounts', { method: 'POST', body: JSON.stringify({
      name, email, username, role: 'owner', password_hash: hashPassword(password) }) });
    const acct = rows[0];
    setSession(res, acct);
    res.json({ ok: true, user: { id: acct.id, role: acct.role, name: acct.name } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/api/auth/login', async (req, res) => {
  try {
    const id = clean(req.body.identifier, 200).toLowerCase(), password = String(req.body.password || '');
    if (!id || !password) return res.status(400).json({ ok: false, error: 'Enter your login and password.' });
    const rows = await sb(`accounts?or=(email.eq.${enc(id)},username.eq.${enc(id)})&limit=1`);
    const acct = rows && rows[0];
    if (!acct || !acct.active || !verifyPassword(password, acct.password_hash))
      return res.status(401).json({ ok: false, error: 'Wrong login or password.' });
    setSession(res, acct);
    sb(`accounts?id=eq.${acct.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_login: new Date().toISOString() }) }).catch(() => {});
    res.json({ ok: true, user: { id: acct.id, role: acct.role, name: acct.name } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/auth/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

/* ================= STAFF (owner manages) ================= */
router.get('/api/staff', requireAuth, async (req, res) => {
  try {
    const rows = await sb('accounts?select=id,name,email,username,role,active,last_login,created_at&order=created_at.asc');
    res.json({ ok: true, staff: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/staff', requireAuth, requireOwner, async (req, res) => {
  try {
    const name = clean(req.body.name, 120), email = clean(req.body.email, 200).toLowerCase();
    const username = clean(req.body.username, 60).toLowerCase(), password = String(req.body.password || '');
    const role = req.body.role === 'owner' ? 'owner' : 'staff';
    if (!name || !isEmail(email) || !username || password.length < 8)
      return res.status(400).json({ ok: false, error: 'Name, valid email, username, and an 8+ character password are required.' });
    const rows = await sb('accounts', { method: 'POST', body: JSON.stringify({
      name, email, username, role, password_hash: hashPassword(password) }) });
    const a = rows[0];
    res.json({ ok: true, staff: { id: a.id, name: a.name, email: a.email, username: a.username, role: a.role } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ================= PROFILE CARD ================= */
const PROFILE_FIELDS = ['display_name','tagline','bio','credentials','offerings','photo_url','email','phone','instagram','shopmy','website'];
router.get('/api/profile', async (req, res) => {
  try {
    const rows = await sb(`profile?id=eq.holly&limit=1`);
    res.json({ ok: true, profile: (rows && rows[0]) || { id: 'holly' } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const patch = { updated_at: new Date().toISOString() };
    for (const f of PROFILE_FIELDS) if (f in req.body) patch[f] = clean(req.body[f], 4000);
    await sb(`profile?id=eq.holly`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ================= STUDENT CRM ================= */
const STU_FIELDS = ['first_name','last_name','email','phone','skill_level','tags','notes','birthday','source'];
function stuBody(b) {
  const o = {};
  for (const f of STU_FIELDS) if (f in b) o[f] = f === 'birthday' ? (clean(b[f], 20) || null) : clean(b[f], 4000);
  if (o.email) o.email = o.email.toLowerCase();
  return o;
}
router.get('/api/students', requireAuth, async (req, res) => {
  try {
    const q = clean(req.query.q, 100);
    let path = 'students?select=*&order=updated_at.desc&limit=500';
    if (q) {
      const like = `*${q}*`;
      path = `students?select=*&or=(first_name.ilike.${enc(like)},last_name.ilike.${enc(like)},email.ilike.${enc(like)},tags.ilike.${enc(like)})&order=updated_at.desc&limit=500`;
    }
    res.json({ ok: true, students: await sb(path) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/students', requireAuth, async (req, res) => {
  try {
    const body = stuBody(req.body);
    if (!body.first_name) return res.status(400).json({ ok: false, error: 'First name is required.' });
    const rows = await sb('students', { method: 'POST', body: JSON.stringify(body) });
    res.json({ ok: true, student: rows[0] });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.get('/api/students/:id', requireAuth, async (req, res) => {
  try {
    const rows = await sb(`students?id=eq.${enc(req.params.id)}&limit=1`);
    const student = rows && rows[0];
    if (!student) return res.status(404).json({ ok: false, error: 'Not found.' });
    let bookings = [], inquiries = [];
    if (student.email) {
      const em = enc(student.email);
      [bookings, inquiries] = await Promise.all([
        sb(`bookings?select=id,created_at,seats,status,slot_id&email=eq.${em}&order=created_at.desc`).catch(() => []),
        sb(`inquiries?select=id,submitted_at,event_type,event_date,status&email=eq.${em}&order=submitted_at.desc`).catch(() => []),
      ]);
    }
    res.json({ ok: true, student, history: { bookings, inquiries } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/api/students/:id', requireAuth, async (req, res) => {
  try {
    const body = stuBody(req.body); body.updated_at = new Date().toISOString();
    await sb(`students?id=eq.${enc(req.params.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ================= PAGES ================= */
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
router.get('/login',    page('login.html'));
router.get('/profile',  page('profile.html'));
router.get('/students', page('students.html'));
router.get('/card',     page('card.html'));

module.exports = router;
