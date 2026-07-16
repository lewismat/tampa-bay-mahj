/**
 * email.js — client emails via Resend.
 *
 * Env:
 *   RESEND_API_KEY   from resend.com → API Keys
 *   FROM_EMAIL       e.g. "Holly at Tampa Bay Mahj <holly@tampabaymahj.com>"
 *                    MUST use a domain verified in Resend, or Resend refuses
 *                    to send to anyone but your own account address.
 *   REPLY_TO         optional, defaults to NOTIFY_EMAIL
 *
 * If RESEND_API_KEY is missing, send() returns {skipped:true} instead of throwing.
 * Callers fall back to notifying Holly so nothing is silently lost.
 */

const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.FROM_EMAIL;
const REPLY_TO = process.env.REPLY_TO || process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com';
const SITE_URL = (process.env.SITE_URL || 'https://tampa-bay-mahj.onrender.com').replace(/\/$/, '');
const TZ = 'America/New_York';

const configured = () => Boolean(API_KEY && FROM);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LABEL = {
  private_lesson: 'private lesson',
  group_class: 'group class',
  private_party: 'private party',
};

const when = (d) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(d));

const deadline = (d) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', hour: 'numeric', minute: '2-digit',
  }).format(new Date(d));

async function send({ to, subject, html }) {
  if (!configured()) return { skipped: true, reason: 'RESEND_API_KEY or FROM_EMAIL not set' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 403 here almost always means the domain in FROM_EMAIL is not verified yet.
      console.error('[email] Resend refused:', res.status, body?.message || body?.name || '');
      return { ok: false, status: res.status, error: body?.message || `Resend ${res.status}` };
    }
    return { ok: true, id: body.id };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------- template */

function shell(inner) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#EFE7D2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFE7D2;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FBF8EF;border:1px solid #DED3B4;border-bottom:5px solid #C6A248;border-radius:14px;">
<tr><td style="padding:32px 30px;font-family:Georgia,'Times New Roman',serif;color:#2C3327;">
${inner}
<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #DED3B4;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#5D6656;">
Tampa Bay Mahj · Tampa, Florida<br>
Questions? Just reply to this email.
</p>
</td></tr></table>
</td></tr></table></body></html>`;
}

const h1 = (t) => `<h1 style="margin:0 0 6px;font-size:26px;font-weight:normal;color:#2C3327;">${t}</h1>`;
const big = (t) => `<p style="margin:16px 0 4px;font-size:19px;font-weight:bold;color:#5A6B4C;">${t}</p>`;
const p = (t) => `<p style="margin:8px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#5D6656;">${t}</p>`;
const btn = (href, label, solid = true) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 6px 0 0;display:inline-block;"><tr><td style="border-radius:8px;background:${solid ? '#7B8C6A' : 'transparent'};border:1.5px solid #7B8C6A;">
<a href="${href}" style="display:inline-block;padding:11px 20px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:bold;color:${solid ? '#F7F2E4' : '#5A6B4C'};text-decoration:none;">${label}</a>
</td></tr></table>`;

const where = (slot) => (slot.location ? p(esc(slot.location)) : '');

/* ------------------------------------------------------------ messages */

// Sent the moment someone books.
function bookingConfirmed(booking, slot, manageToken) {
  const url = `${SITE_URL}/booking/${manageToken}`;
  return send({
    to: booking.email,
    subject: `You're booked — ${when(slot.starts_at)}`,
    html: shell(
      h1('You’re booked.') +
      p(`Hi ${esc(booking.first_name)} — Holly has you down for a ${LABEL[slot.slot_type]}.`) +
      big(when(slot.starts_at)) +
      p(`${slot.duration_minutes} minutes${booking.seats > 1 ? ` · ${booking.seats} seats` : ''}`) +
      where(slot) +
      btn(`${url}/calendar.ics`, 'Add to calendar') +
      btn(url, 'View or cancel', false) +
      p('Nothing to bring — Holly provides the tiles and the cards.')
    ),
  });
}

// Sent when a session is full and they get in line.
function waitlistJoined(person, slot, token, position) {
  return send({
    to: person.email,
    subject: `You're #${position} on the list — ${when(slot.starts_at)}`,
    html: shell(
      h1(`You’re #${position} in line.`) +
      p(`Hi ${esc(person.first_name)} — that ${LABEL[slot.slot_type]} is full, but you’re on the list.`) +
      big(when(slot.starts_at)) +
      where(slot) +
      p(`If a seat opens up, we’ll email you and hold it for 24 hours — first come, first served down the list.`) +
      btn(`${SITE_URL}/waitlist/${token}`, 'Check your place in line') +
      p('Changed your mind? You can leave the list from that same link.')
    ),
  });
}

// The one that matters: a seat opened and it is being held for them.
function waitlistOffer(offer) {
  const url = `${SITE_URL}/waitlist/${offer.token}`;
  return send({
    to: offer.email,
    subject: `A seat opened up — ${when(offer.starts_at)}`,
    html: shell(
      h1('A seat opened up.') +
      p(`Hi ${esc(offer.first_name)} — someone cancelled, and the seat is yours if you want it.`) +
      big(when(offer.starts_at)) +
      p(`${LABEL[offer.slot_type]} · ${offer.duration_minutes} minutes${offer.seats > 1 ? ` · ${offer.seats} seats` : ''}`) +
      where(offer) +
      p(`<strong style="color:#8A6D14;">It’s held for you until ${deadline(offer.expires_at)}.</strong> After that it goes to the next person in line.`) +
      btn(url, 'Claim my seat') +
      p('Can’t make it? Use the same link to pass — it goes to the next person straight away.')
    ),
  });
}

// Sent when they claim a held seat.
function offerClaimed(offer, manageToken) {
  const url = `${SITE_URL}/booking/${manageToken}`;
  return send({
    to: offer.email,
    subject: `Seat claimed — ${when(offer.starts_at)}`,
    html: shell(
      h1('The seat is yours.') +
      p(`Hi ${esc(offer.first_name)} — you’re off the list and on the table.`) +
      big(when(offer.starts_at)) +
      where(offer) +
      btn(`${url}/calendar.ics`, 'Add to calendar') +
      btn(url, 'View or cancel', false)
    ),
  });
}

module.exports = { send, configured, bookingConfirmed, waitlistJoined, waitlistOffer, offerClaimed };
