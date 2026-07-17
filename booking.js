/**
 * booking.js — Tampa Bay Mahj booking + waitlist
 *
 * Mount from server.js with ONE line:
 *     app.use(require('./booking'));
 *
 * No npm packages. Uses built-in fetch (Node 18+).
 *
 * Required env (already in Render): SUPABASE_URL, SUPABASE_KEY, DASHBOARD_PASSWORD
 * Optional: NOTIFY_EMAIL, SITE_URL, RESEND_API_KEY, FROM_EMAIL, OFFER_HOURS
 */

const express = require('express');
const path = require('path');
const mail = require('./email');
const sms = require('./sms');
const auth = require('./auth');
const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const DASH_PASS = process.env.DASHBOARD_PASSWORD;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com';
const SITE_URL = (process.env.SITE_URL || 'https://tampa-bay-mahj.onrender.com').replace(/\/$/, '');
const OFFER_HOURS = parseInt(process.env.OFFER_HOURS, 10) || 24;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[booking] SUPABASE_URL / SUPABASE_KEY not found — booking routes will error.');
}
if (!mail.configured()) {
  console.warn('[booking] Resend not configured — clients will not be emailed. Holly still gets notified.');
}

router.use(express.json());

/* ---------------------------------------------------------------- helpers */

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
  if (!res.ok) throw new Error(typeof data === 'string' ? data : data?.message || `Supabase ${res.status}`);
  return data;
}

function requireHolly(req, res, next) {
  if (!DASH_PASS) return res.status(500).send('DASHBOARD_PASSWORD is not set on the server.');
  const [type, creds] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && creds) {
    const pass = Buffer.from(creds, 'base64').toString().split(':').slice(1).join(':');
    if (pass === DASH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Tampa Bay Mahj scheduling"');
  res.status(401).send('Password required.');
}

const TYPE_LABEL = {
  private_lesson: 'Private lesson',
  group_class: 'Group class',
  private_party: 'Private party',
};

const clean = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const free = (s) => s.seats_total - s.seats_taken - (s.seats_held || 0);
const endsAt = (s) => new Date(new Date(s.starts_at).getTime() + s.duration_minutes * 60000);
const fmt = (d) => new Date(d).toLocaleString('en-US', {
  timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short',
});

// Holly's notifications keep going through FormSubmit — already working, already activated.
// A booking (or claimed waitlist seat) makes them a real student, tagged with the event.
async function upsertStudentFromBooking(person, slot) {
  try {
    const email = (person.email || '').toLowerCase();
    const when = slot && slot.starts_at
      ? new Date(slot.starts_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }) : '';
    const label = (TYPE_LABEL[slot.slot_type] || slot.slot_type || 'event') + (when ? ' \u00b7 ' + when : '');
    const tag = 'booked: ' + label;
    let ex = [];
    if (email) ex = await sb(`students?select=id,tags&email=eq.${encodeURIComponent(email)}&limit=1`).catch(() => []);
    if (ex && ex[0]) {
      const tags = (ex[0].tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!tags.includes(tag)) tags.push(tag);
      await sb(`students?id=eq.${ex[0].id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'student', source: 'event booking', tags: tags.join(', '), updated_at: new Date().toISOString() }) });
    } else {
      await sb('students', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        first_name: person.first_name, last_name: person.last_name, email, phone: person.phone,
        status: 'student', source: 'event booking', tags: tag, notes: 'Booked ' + label }) });
    }
  } catch (e) { console.error('[booking] student upsert:', e.message); }
}

async function tellHolly(subject, fields) {
  try {
    await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(NOTIFY_EMAIL)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _subject: subject, ...fields }),
    });
  } catch (e) {
    console.error('[booking] Holly notification failed:', e.message);
  }
}

/* ------------------------------------------------------------ the sweep */
/* Render's free tier has no cron, so expiry is lazy: any time the calendar
   is touched we expire dead offers and roll freed seats down the line.
   Throttled so a busy page does not hammer the database. */

let lastSweep = 0;
let sweeping = null;

async function doSweep() {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    try {
      const out = await sb('rpc/sweep_waitlist', {
        method: 'POST',
        body: JSON.stringify({ p_hours: OFFER_HOURS }),
      });
      lastSweep = Date.now();
      const offers = out?.offers || [];
      for (const o of offers) {
        const sent = await mail.waitlistOffer(o);
        // If the client could not be emailed, Holly gets the claim link to pass on
        // by text — the seat stays held either way, so the offer still means something.
        if (!sent?.ok) {
          await tellHolly(`Seat opened — text ${o.first_name} the link`, {
            Who: `${o.first_name} ${o.last_name}`,
            Phone: o.phone || '—',
            Email: o.email,
            Session: `${TYPE_LABEL[o.slot_type]} — ${fmt(o.starts_at)}`,
            Seats: o.seats,
            'Claim link': `${SITE_URL}/waitlist/${o.token}`,
            'Held until': fmt(o.expires_at),
            Why: sent?.reason || sent?.error || 'client email not sent',
          });
        }
      }
      return offers;
    } catch (e) {
      console.error('[booking] sweep failed:', e.message);
      return [];
    } finally {
      sweeping = null;
    }
  })();
  return sweeping;
}

function maybeSweep() {
  if (Date.now() - lastSweep > 60000) doSweep().catch(() => {});
}

/* ------------------------------------------------------------ public API */

// Open sessions. Full ones stay listed so people can join the waitlist.
router.get('/api/slots', async (req, res) => {
  try {
    maybeSweep();
    const rows = await sb(
      `slots?select=id,slot_type,starts_at,duration_minutes,location,seats_total,seats_taken,seats_held,price_note,notes,waitlist(status)` +
      `&published=eq.true&starts_at=gte.${new Date().toISOString()}&order=starts_at.asc`
    );
    res.json(rows.map((s) => {
      const line = (s.waitlist || []).filter((w) => w.status === 'waiting' || w.status === 'offered').length;
      const { waitlist, seats_held, seats_taken, ...rest } = s;
      return { ...rest, seats_left: Math.max(0, free(s)), waiting: line };
    }));
  } catch (e) {
    console.error('[booking] /api/slots', e.message);
    res.status(500).json({ error: 'Could not load the calendar. Please refresh.' });
  }
});

function person(b) {
  return {
    first_name: clean(b.first_name, 60),
    last_name: clean(b.last_name, 60),
    email: clean(b.email, 120),
    phone: clean(b.phone, 40),
    notes: clean(b.notes, 2000),
  };
}

function validate(p, slot_id) {
  if (!p.first_name || !p.last_name) return 'Add your first and last name.';
  if (!isEmail(p.email)) return 'That email address does not look right.';
  if (!p.phone || p.phone.replace(/[^0-9]/g, '').length < 10) return 'Add a phone number so Holly can reach you.';
  if (!slot_id) return 'Pick a time first.';
  return null;
}

// Book a seat.
router.post('/api/book', async (req, res) => {
  try {
    const b = req.body || {};
    const p = person(b);
    const seats = Math.max(1, parseInt(b.seats, 10) || 1);
    const bad = validate(p, b.slot_id);
    if (bad) return res.status(400).json({ error: bad });

    const payload = {
      ...p,
      street_address: clean(b.street_address, 200),
      city: clean(b.city, 80),
      state: clean(b.state, 40),
      zip: clean(b.zip, 20),
      headcount: clean(String(b.headcount ?? ''), 10),
    };

    const result = await sb('rpc/book_slot', {
      method: 'POST',
      body: JSON.stringify({ p_slot_id: b.slot_id, p_seats: seats, p_booking: payload }),
    });
    if (!result?.ok) return res.status(409).json({ error: result?.error || 'That time just filled up.' });

    const [slot] = await sb(`slots?select=*&id=eq.${b.slot_id}`);
    upsertStudentFromBooking(payload, slot);

    mail.bookingConfirmed({ ...payload, seats }, slot, result.manage_token);
    if (payload.phone) sms.sendSMS(payload.phone, `You're booked with Tampa Bay Mahj \u2014 ${TYPE_LABEL[slot.slot_type]} on ${fmt(slot.starts_at)}. Manage: ${SITE_URL}/booking/${result.manage_token}`).catch(() => {});
    tellHolly(`New booking — ${TYPE_LABEL[slot.slot_type]} — ${fmt(slot.starts_at)}`, {
      Name: `${payload.first_name} ${payload.last_name}`,
      Email: payload.email,
      Phone: payload.phone || '—',
      When: fmt(slot.starts_at),
      Seats: seats,
      Where: slot.location || payload.street_address || '—',
      Address: [payload.street_address, payload.city, payload.state, payload.zip].filter(Boolean).join(', ') || '—',
      Expecting: payload.headcount || '—',
      Notes: payload.notes || '—',
      Schedule: `${SITE_URL}/schedule`,
    });

    res.json({ ok: true, manage_url: `${SITE_URL}/booking/${result.manage_token}` });
  } catch (e) {
    console.error('[booking] /api/book', e.message);
    res.status(500).json({ error: 'Something went wrong saving that. Please try again.' });
  }
});

/* ------------------------------------------------------------- waitlist */

router.post('/api/waitlist', async (req, res) => {
  try {
    const b = req.body || {};
    const p = person(b);
    const seats = Math.max(1, parseInt(b.seats, 10) || 1);
    const bad = validate(p, b.slot_id);
    if (bad) return res.status(400).json({ error: bad });

    const result = await sb('rpc/join_waitlist', {
      method: 'POST',
      body: JSON.stringify({ p_slot_id: b.slot_id, p_seats: seats, p_person: p }),
    });
    if (!result?.ok) return res.status(409).json({ error: result.error });

    const [slot] = await sb(`slots?select=*&id=eq.${b.slot_id}`);

    if (!result.already) {
      mail.waitlistJoined(p, slot, result.token, result.position);
      tellHolly(`Waitlist — ${p.first_name} ${p.last_name} is #${result.position} for ${fmt(slot.starts_at)}`, {
        Name: `${p.first_name} ${p.last_name}`,
        Email: p.email,
        Phone: p.phone || '—',
        Session: `${TYPE_LABEL[slot.slot_type]} — ${fmt(slot.starts_at)}`,
        Seats: seats,
        Position: `#${result.position}`,
        Notes: p.notes || '—',
      });
    }

    res.json({
      ok: true,
      already: !!result.already,
      position: result.position,
      status_url: `${SITE_URL}/waitlist/${result.token}`,
    });
  } catch (e) {
    console.error('[booking] /api/waitlist', e.message);
    res.status(500).json({ error: 'Could not add you to the list. Please try again.' });
  }
});

router.get('/waitlist/:token', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'waitlist.html'))
);

router.get('/api/waitlist/:token', async (req, res) => {
  try {
    await doSweep(); // this page is exactly where a stale offer must not be shown as live
    const [w] = await sb(
      `waitlist?select=*,slots(*)&token=eq.${encodeURIComponent(req.params.token)}`
    );
    if (!w) return res.status(404).json({ error: 'We could not find that.' });

    let position = null;
    if (w.status === 'waiting' || w.status === 'offered') {
      const line = await sb(
        `waitlist?select=created_at&slot_id=eq.${w.slot_id}&status=in.(waiting,offered)&created_at=lte.${encodeURIComponent(w.created_at)}`
      );
      position = line.length;
    }
    let manage_url = null;
    if (w.status === 'claimed' && w.booking_id) {
      const [bk] = await sb(`bookings?select=manage_token&id=eq.${w.booking_id}`);
      if (bk) manage_url = `${SITE_URL}/booking/${bk.manage_token}`;
    }
    delete w.token;
    delete w.booking_id;
    res.json({ ...w, position, manage_url });
  } catch (e) {
    console.error('[booking] /api/waitlist/:token', e.message);
    res.status(500).json({ error: 'Could not load that.' });
  }
});

router.post('/api/waitlist/:token/claim', async (req, res) => {
  try {
    const result = await sb('rpc/claim_offer', {
      method: 'POST',
      body: JSON.stringify({ p_token: req.params.token }),
    });
    if (!result?.ok) return res.status(409).json({ error: result?.error || 'Could not claim that seat.' });

    const [w] = await sb(`waitlist?select=*,slots(*)&token=eq.${encodeURIComponent(req.params.token)}`);
    if (!result.already && w) {
      upsertStudentFromBooking(w, w.slots);
      mail.offerClaimed({ ...w, starts_at: w.slots.starts_at, location: w.slots.location }, result.manage_token);
      if (w.phone) sms.sendSMS(w.phone, `Your seat is confirmed with Tampa Bay Mahj \u2014 ${TYPE_LABEL[w.slots.slot_type]} on ${fmt(w.slots.starts_at)}. Manage: ${SITE_URL}/booking/${result.manage_token}`).catch(() => {});
      tellHolly(`Waitlist claimed — ${w.first_name} ${w.last_name} — ${fmt(w.slots.starts_at)}`, {
        Name: `${w.first_name} ${w.last_name}`,
        Email: w.email,
        Phone: w.phone || '—',
        Session: `${TYPE_LABEL[w.slots.slot_type]} — ${fmt(w.slots.starts_at)}`,
        Seats: w.seats,
        Schedule: `${SITE_URL}/schedule`,
      });
    }
    res.json({ ok: true, manage_url: `${SITE_URL}/booking/${result.manage_token}` });
  } catch (e) {
    console.error('[booking] claim', e.message);
    res.status(500).json({ error: 'Could not claim that seat. Please text Holly.' });
  }
});

router.post('/api/waitlist/:token/leave', async (req, res) => {
  try {
    const result = await sb('rpc/leave_waitlist', {
      method: 'POST',
      body: JSON.stringify({ p_token: req.params.token }),
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'Could not do that.' });
    doSweep().catch(() => {}); // passing on a held seat should reach the next person now
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not do that.' });
  }
});

/* ------------------------------------------------ client booking pages */

router.get('/booking/:token', async (req, res) => {
  try {
    const [bk] = await sb(`bookings?select=id&manage_token=eq.${encodeURIComponent(req.params.token)}`);
    if (!bk) return res.status(404).send('We could not find that booking.');
    res.sendFile(path.join(__dirname, 'public', 'booking-manage.html'));
  } catch {
    res.status(500).send('Something went wrong loading that booking.');
  }
});

router.get('/api/booking/:token', async (req, res) => {
  try {
    const [bk] = await sb(`bookings?select=*,slots(*)&manage_token=eq.${encodeURIComponent(req.params.token)}`);
    if (!bk) return res.status(404).json({ error: 'We could not find that booking.' });
    delete bk.manage_token;
    res.json(bk);
  } catch {
    res.status(500).json({ error: 'Could not load that booking.' });
  }
});

router.post('/api/booking/:token/cancel', async (req, res) => {
  try {
    const result = await sb('rpc/cancel_booking', {
      method: 'POST',
      body: JSON.stringify({ p_token: req.params.token }),
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'Could not cancel that.' });
    // A cancellation is the whole point of the waitlist — offer the seat immediately.
    doSweep().catch(() => {});
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not cancel that. Please text Holly.' });
  }
});

router.get('/booking/:token/calendar.ics', async (req, res) => {
  try {
    const [bk] = await sb(`bookings?select=*,slots(*)&manage_token=eq.${encodeURIComponent(req.params.token)}`);
    if (!bk) return res.status(404).send('Not found.');
    const s = bk.slots;
    const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tampa Bay Mahj//EN', 'BEGIN:VEVENT',
      `UID:${bk.id}@tampabaymahj`,
      `DTSTAMP:${stamp(bk.created_at)}`,
      `DTSTART:${stamp(s.starts_at)}`,
      `DTEND:${stamp(endsAt(s))}`,
      `SUMMARY:${TYPE_LABEL[s.slot_type]} with Holly — Tampa Bay Mahj`,
      `LOCATION:${(s.location || [bk.street_address, bk.city, bk.state].filter(Boolean).join(', ') || 'TBD').replace(/,/g, '\\,')}`,
      `DESCRIPTION:Manage this booking: ${SITE_URL}/booking/${req.params.token}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    res.set('Content-Type', 'text/calendar');
    res.set('Content-Disposition', 'attachment; filename="mahjong.ics"');
    res.send(ics);
  } catch {
    res.status(500).send('Could not build that calendar file.');
  }
});

/* ------------------------------------------------------- Holly-only API */

router.get('/schedule', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'schedule.html'))
);

router.get('/api/admin/slots', auth.requireAuth, async (req, res) => {
  try {
    await doSweep();
    const rows = await sb('slots?select=*,bookings(*),waitlist(*)&order=starts_at.asc');
    res.json(rows.map((s) => ({ ...s, seats_free: Math.max(0, free(s)) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/slots', auth.requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!TYPE_LABEL[b.slot_type]) return res.status(400).json({ error: 'Pick what kind of session this is.' });
    if (!b.starts_at || isNaN(new Date(b.starts_at))) return res.status(400).json({ error: 'Pick a date and time.' });

    const exclusive = b.slot_type !== 'group_class';
    const [created] = await sb('slots', {
      method: 'POST',
      body: JSON.stringify({
        slot_type: b.slot_type,
        title: clean(b.title, 120) || null,
        starts_at: new Date(b.starts_at).toISOString(),
        duration_minutes: Math.min(600, Math.max(15, parseInt(b.duration_minutes, 10) || 120)),
        location: clean(b.location, 200) || null,
        seats_total: exclusive ? 1 : Math.min(40, Math.max(1, parseInt(b.seats_total, 10) || 8)),
        price_note: clean(b.price_note, 120) || null,
        notes: clean(b.notes, 1000) || null,
        published: b.published !== false,
      }),
    });
    res.json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/api/admin/slots/:id', auth.requireAuth, async (req, res) => {
  try {
    const patch = {};
    if ('published' in req.body) patch.published = !!req.body.published;
    if ('seats_total' in req.body) {
      const [cur] = await sb(`slots?select=seats_taken,seats_held&id=eq.${encodeURIComponent(req.params.id)}`);
      const want = Math.min(40, Math.max(1, parseInt(req.body.seats_total, 10) || 1));
      const floor = cur.seats_taken + (cur.seats_held || 0);
      if (want < floor) {
        return res.status(409).json({ error: `${floor} seat(s) are already spoken for. You cannot go below that.` });
      }
      patch.seats_total = want;
    }
    const [updated] = await sb(`slots?id=eq.${encodeURIComponent(req.params.id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    });
    // Adding seats, or re-publishing, can free something up for the line.
    doSweep().catch(() => {});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/admin/slots/:id', auth.requireAuth, async (req, res) => {
  try {
    const [slot] = await sb(`slots?select=seats_taken,seats_held&id=eq.${encodeURIComponent(req.params.id)}`);
    if (slot?.seats_taken > 0 || slot?.seats_held > 0) {
      return res.status(409).json({ error: 'Someone is booked or holding a seat here. Hide it instead, then call them.' });
    }
    await sb(`slots?id=eq.${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/book', (req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));

module.exports = router;
