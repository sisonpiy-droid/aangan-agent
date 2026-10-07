// Calendly = consultation scheduling. We never compute availability: the caller picks a
// real slot on Calendly's own page, and Calendly's webhook tells us what was booked.
// A lead is matched to its booking by utm_content=<lead id> on the link.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const calendlyConfigured = () => !!process.env.CALENDLY_EVENT_URL_RESIDENTIAL;
// Webhooks need a paid Calendly plan. Without them the booking link still works; booking status is manual
// (designers update the HubSpot deal). `npm run calendly:setup` tells you which mode you're in.
export const calendlyWebhooksEnabled = () => process.env.CALENDLY_WEBHOOKS_ENABLED === 'true';

// "Appropriate" link: a commercial event type if one is set, else the residential one.
export function bookingLink(row) {
  const l = row.lead ?? {};
  const base = (l.segment === 'commercial' && process.env.CALENDLY_EVENT_URL_COMMERCIAL) || process.env.CALENDLY_EVENT_URL_RESIDENTIAL;
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('utm_source', 'aangan_ai_front_desk');
  url.searchParams.set('utm_content', String(row.id));
  if (l.name) url.searchParams.set('name', l.name);
  if (l.email) url.searchParams.set('email', l.email);
  return url.toString();
}

// Calendly-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
export const SIGNATURE_TOLERANCE_SEC = 300; // ponytail: replay window; Calendly signs each delivery fresh
export function calendlySignatureOk(raw, header, key, nowSec = Date.now() / 1000) {
  if (!key || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.trim().split('=')));
  if (!parts.t || !parts.v1 || Math.abs(nowSec - Number(parts.t)) > SIGNATURE_TOLERANCE_SEC) return false;
  const want = Buffer.from(createHmac('sha256', key).update(`${parts.t}.${raw}`).digest('hex'));
  const got = Buffer.from(parts.v1);
  return want.length === got.length && timingSafeEqual(want, got);
}

const lastSegment = uri => (uri ? String(uri).split('/').filter(Boolean).at(-1) : null);

// invitee.created / invitee.canceled → the fields we store. Reschedule = canceled (rescheduled: true)
// on the old invitee, then created (old_invitee set) on the new one.
export function parseWebhook(body) {
  const p = body.payload ?? {};
  const ev = p.scheduled_event ?? {};
  const kind = body.event === 'invitee.created' ? (p.old_invitee ? 'rescheduled' : 'booked')
    : body.event === 'invitee.canceled' ? (p.rescheduled ? 'reschedule_pending' : 'canceled') : null;
  return {
    kind,
    inviteeUri: p.uri ?? null,
    inviteeId: lastSegment(p.uri),
    oldInviteeId: lastSegment(p.old_invitee),
    eventId: lastSegment(ev.uri ?? p.event),
    start: ev.start_time ?? null,
    end: ev.end_time ?? null,
    leadId: p.tracking?.utm_source === 'aangan_ai_front_desk' && /^\d+$/.test(p.tracking?.utm_content ?? '') ? p.tracking.utm_content : null,
    phone: p.text_reminder_number ?? null,
    name: p.name ?? null,
    email: p.email ?? null,
    cancelReason: p.cancellation?.reason ?? null,
  };
}
