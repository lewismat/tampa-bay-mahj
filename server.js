/**
 * Tampa Bay Mahj — Event Inquiry App
 * Zero-dependency Node.js server (no npm install needed).
 *
 * Run:   node server.js
 * Form:      http://localhost:3000
 * Dashboard: http://localhost:3000/dashboard
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { inquiries: [], visits: [] }; }
}
function saveDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css',
  '.js': 'application/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) { res.writeHead(status, headers); res.end(body); }
function sendJSON(res, status, obj) { send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function clean(v, max = 2000) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  // record a visit
  if (req.method === 'POST' && pathname === '/api/track') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const cookies = parseCookies(req);
      let visitorId = cookies.tbm_vid;
      const isNew = !visitorId;
      if (!visitorId) visitorId = crypto.randomUUID();

      db.visits.push({
        id: crypto.randomUUID(),
        visitorId,
        time: new Date().toISOString(),
        page: clean(body.page, 100) || '/',
        referrer: clean(body.referrer, 300),
        userAgent: clean(req.headers['user-agent'] || '', 300),
        ip: getIP(req),
        screen: clean(body.screen, 30),
      });
      saveDB(db);

      const headers = { 'Content-Type': 'application/json' };
      if (isNew) headers['Set-Cookie'] = 'tbm_vid=' + visitorId + '; Max-Age=31536000; Path=/; SameSite=Lax';
      send(res, 200, JSON.stringify({ ok: true }), headers);
    } catch { sendJSON(res, 400, { ok: false }); }
    return;
  }

  // submit inquiry
  if (req.method === 'POST' && pathname === '/api/inquiries') {
    try {
      const b = JSON.parse((await readBody(req)) || '{}');
      const required = ['firstName', 'lastName', 'email', 'phone', 'eventType', 'eventDate'];
      for (const f of required) {
        if (!clean(b[f])) return sendJSON(res, 400, { ok: false, error: 'Missing field: ' + f });
      }
      const cookies = parseCookies(req);
      const inquiry = {
        id: crypto.randomUUID(),
        submittedAt: new Date().toISOString(),
        visitorId: cookies.tbm_vid || null,
        ip: getIP(req),
        firstName: clean(b.firstName, 100),
        lastName: clean(b.lastName, 100),
        email: clean(b.email, 200),
        phone: clean(b.phone, 50),
        eventType: clean(b.eventType, 100),
        eventDate: clean(b.eventDate, 30),
        startTime: clean(b.startTime, 30),
        locationName: clean(b.locationName, 200),
        streetAddress: clean(b.streetAddress, 300),
        city: clean(b.city, 100),
        state: clean(b.state, 50),
        zip: clean(b.zip, 20),
        aboutEvent: clean(b.aboutEvent, 3000),
        guestCount: clean(b.guestCount, 20),
        anythingElse: clean(b.anythingElse, 3000),
        status: 'new',
      };
      db.inquiries.unshift(inquiry);
      saveDB(db);
      sendJSON(res, 200, { ok: true, id: inquiry.id });
    } catch { sendJSON(res, 400, { ok: false, error: 'Invalid submission' }); }
    return;
  }

  // dashboard data
  if (req.method === 'GET' && pathname === '/api/dashboard') {
    const uniqueVisitors = new Set(db.visits.map((v) => v.visitorId)).size;
    const formVisits = db.visits.filter((v) => v.page === '/' || v.page === '/index.html');
    sendJSON(res, 200, {
      inquiries: db.inquiries,
      visits: db.visits.slice(-500).reverse(),
      stats: {
        totalVisits: formVisits.length,
        uniqueVisitors,
        totalInquiries: db.inquiries.length,
        conversionRate: uniqueVisitors ? Math.round((db.inquiries.length / uniqueVisitors) * 100) : 0,
      },
    });
    return;
  }

  // update inquiry status
  if (req.method === 'PATCH' && pathname.startsWith('/api/inquiries/')) {
    try {
      const id = pathname.split('/').pop();
      const b = JSON.parse((await readBody(req)) || '{}');
      const inquiry = db.inquiries.find((q) => q.id === id);
      if (!inquiry) return sendJSON(res, 404, { ok: false });
      const allowed = ['new', 'contacted', 'booked', 'archived'];
      if (allowed.includes(b.status)) inquiry.status = b.status;
      saveDB(db);
      sendJSON(res, 200, { ok: true });
    } catch { sendJSON(res, 400, { ok: false }); }
    return;
  }

  // static files
  if (req.method === 'GET') {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    if (filePath === '/dashboard') filePath = '/dashboard.html';
    filePath = path.normalize(filePath).replace(/^([.][.][\/\\])+/, '');
    const full = path.join(PUBLIC_DIR, filePath);
    if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, data, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    });
    return;
  }

  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Tampa Bay Mahj is up!');
  console.log('  Inquiry form:  http://localhost:' + PORT);
  console.log('  Dashboard:     http://localhost:' + PORT + '/dashboard');
  console.log('');
});
