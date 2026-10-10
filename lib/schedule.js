// Books the consultation time the caller asked for, in the studio's Calendly, right after the call.
// The agent only asks for a preferred day and time (it cannot see the calendar). Here we find the free slot closest to it and
// book it through Calendly's scheduling API; Calendly emails the caller the invite with a Google Meet link, and its webhook
// (api/calendly-webhook.js) updates the lead, HubSpot and Telegram. Returns null whenever it cannot (no email, no time asked,
// nothing free nearby): the caller then gets the self-serve link instead.
const API = 'https://api.calendly.com';
const WINDOW_MS = 6.9 * 864e5; // Calendly allows at most 7 days per availability request
const MAX_GAP_MS = 24 * 36e5; // never book more than a day away from what they asked for
const LEAD_MS = 60 * 60e3; // nothing sooner than an hour from now

export const schedulingConfigured = () => !!(process.env.CALENDLY_TOKEN && process.env.CALENDLY_EVENT_URL_RESIDENTIAL);

async function cal(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${process.env.CALENDLY_TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Calendly ${res.status}: ${json.message ?? text.slice(0, 120)}`);
  return json;
}

// The event type behind the booking link the lead was given (commercial or residential).
async function eventTypeFor(url) {
  const base = new URL(url);
  const me = (await cal('/users/me')).resource;
  const types = (await cal(`/event_types?user=${encodeURIComponent(me.uri)}&active=true&count=100`)).collection;
  const t = types.find(x => x.scheduling_url === `${base.origin}${base.pathname}`);
  if (!t) throw new Error('no Calendly event type matches the booking link');
  return t;
}

export async function bookPreferred(row, now = new Date()) {
  const l = row.lead ?? {};
  if (!schedulingConfigured() || !row.calendly_booking_url || !l.email || !l.preferred_start) return null;
  const want = Date.parse(l.preferred_start);
  if (!(want > now.getTime() + LEAD_MS)) return null; // in the past or too soon: let them pick

  const type = await eventTypeFor(row.calendly_booking_url);
  const from = new Date(Math.max(now.getTime() + LEAD_MS, want - 12 * 36e5));
  const slots = (await cal(`/event_type_available_times?event_type=${encodeURIComponent(type.uri)}&start_time=${from.toISOString()}&end_time=${new Date(from.getTime() + WINDOW_MS).toISOString()}`)).collection ?? [];
  const best = slots.map(s => ({ s, gap: Math.abs(Date.parse(s.start_time) - want) })).sort((a, b) => a.gap - b.gap || Date.parse(b.s.start_time) - Date.parse(a.s.start_time))[0];
  if (!best || best.gap > MAX_GAP_MS) return null;

  const made = (await cal('/invitees', {
    method: 'POST',
    body: JSON.stringify({
      event_type: type.uri, start_time: best.s.start_time,
      invitee: { name: l.name ?? l.email.split('@')[0], email: l.email, timezone: 'Asia/Kolkata' },
      location: { kind: type.locations?.[0]?.kind ?? 'google_conference' },
      tracking: { utm_source: 'aangan_ai_front_desk', utm_content: String(row.id) },
    }),
  })).resource;

  // The Meet link is attached a moment after booking.
  let meetUrl = null;
  for (let i = 0; i < 4 && !meetUrl; i++) {
    const ev = (await cal(`/scheduled_events/${made.event.split('/').pop()}`)).resource;
    meetUrl = ev.location?.join_url ?? null;
    if (!meetUrl) await new Promise(r => setTimeout(r, 1000));
  }
  const start = best.s.start_time;
  return {
    start, end: new Date(Date.parse(start) + type.duration * 60e3).toISOString(),
    eventId: made.event.split('/').pop(), inviteeUri: made.uri, inviteeId: made.uri.split('/').pop(),
    meetUrl, rescheduleUrl: made.reschedule_url ?? null, requested: l.preferred_start, exact: best.gap === 0,
  };
}
