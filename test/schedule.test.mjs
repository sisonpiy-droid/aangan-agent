// The caller names a time on the call; after it, the closest free Calendly slot is booked and everyone is told.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.SUPABASE_URL;
Object.assign(process.env, {
  QUIET: '1', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_DESIGNERS_CHAT_ID: 'designers', TELEGRAM_NIKHIL_CHAT_ID: 'nikhil',
  CALENDLY_TOKEN: 'cal-token', CALENDLY_EVENT_URL_RESIDENTIAL: 'https://calendly.com/aangan/consultation', CALENDLY_WEBHOOKS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111', RESEND_API_KEY: 're_1', MAIL_FROM: 'Aangan <hi@aangan.example>',
});

const { processCall } = await import('../lib/pipeline.js');
const { normalize } = await import('../lib/extract.js');
const { nextTask } = await import('../lib/tasks.js');
const store = await import('../lib/store.js');

const calls = JSON.parse(readFileSync(new URL('./transcripts.json', import.meta.url)));
const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('./leads.json', import.meta.url))).map((c) => [c.id, c.lead]));
const WANT = new Date(Date.now() + 3 * 864e5); WANT.setUTCMinutes(0, 0, 0); // 3 days out, on the hour
const at = (mins) => new Date(WANT.getTime() + mins * 60e3).toISOString();
const as = (extra) => ({ extractFn: async () => ({ lead: normalize({ ...fixtures.T01, preferred_start: WANT.toISOString(), preferred_slot: 'in three days, around then', ...extra }), tokens: { in: 0, out: 0 } }) });

let net = [], slots = [], inviteeFails = false, seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  if (u.startsWith('https://api.calendly.com')) {
    const p = u.slice(24);
    if (p.startsWith('/users/me')) return Response.json({ resource: { uri: 'https://api.calendly.com/users/U1' } });
    if (p.startsWith('/event_types')) return Response.json({ collection: [{ uri: 'https://api.calendly.com/event_types/E1', scheduling_url: 'https://calendly.com/aangan/consultation', duration: 30, locations: [{ kind: 'google_conference' }] }] });
    if (p.startsWith('/event_type_available_times')) return Response.json({ collection: slots.map((start_time) => ({ status: 'available', start_time })) });
    if (p.startsWith('/invitees')) { net.push({ to: 'invitees', body }); return inviteeFails ? Response.json({ message: 'Upgrade your plan' }, { status: 403 }) : Response.json({ resource: { uri: 'https://api.calendly.com/scheduled_events/EV1/invitees/I1', event: 'https://api.calendly.com/scheduled_events/EV1', reschedule_url: 'https://calendly.com/reschedule/I1' } }, { status: 201 }); }
    if (p.startsWith('/scheduled_events/EV1')) return Response.json({ resource: { location: { type: 'google_conference', join_url: 'https://meet.google.com/abc-defg-hij' } } });
  }
  if (u.startsWith('https://api.twilio.com')) { net.push({ to: 'sms', body: Object.fromEntries(init.body) }); return Response.json({ sid: 'SM1' }); }
  if (u.startsWith('https://api.resend.com')) { net.push({ to: 'email', body }); return Response.json({ id: 'em1' }); }
  if (u.startsWith('https://api.telegram.org')) { net.push({ to: 'telegram', text: body?.text ?? '(file)' }); return Response.json({ ok: true, result: { message_id: ++seq } }); }
  throw new Error(`unexpected fetch ${u}`);
};
const sent = (to) => net.filter((n) => n.to === to);
const call = (n) => ({ ...calls.T01, id: `sch-${n}-${++seq}`, fromNumber: `+9190000008${String(n).padStart(2, '0')}` });

test('books the free slot closest to the time asked for, and tells the caller, the designers and the dashboard', async () => {
  net = []; slots = [at(-90), at(30), at(120)];
  const row = await processCall(call(1), as({ email: 'priya@example.com' }));
  const [inv] = sent('invitees');
  assert.equal(inv.body.start_time, at(30), 'nearest free slot, not the earliest');
  assert.equal(inv.body.invitee.email, 'priya@example.com');
  assert.equal(inv.body.tracking.utm_content, String(row.id));
  const saved = await store.findLead({ id: row.id });
  assert.equal(saved.consultation_status, 'booked');
  assert.equal(Date.parse(saved.consultation_start), Date.parse(at(30)));
  assert.equal(saved.lead.booking.meetUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(saved.lead.booking.exact, false);
  const [sms] = sent('sms'), [mail] = sent('email');
  assert.match(sms.body.Body, /your consultation with Aangan Studio is booked for .* IST\. This is the closest free time to the one you asked for\. Join on Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.equal(mail.body.subject, 'Your consultation with Aangan Studio is confirmed');
  assert.match(mail.body.html, /Join on Google Meet/);
  assert.match(sent('telegram')[0].text, /Consultation booked: .* IST<\/b> \(closest free time to what they asked: in three days, around then\) · <a href="https:\/\/meet\.google\.com/);
  const task = nextTask(saved);
  assert.equal(task.key, 'consult');
  assert.equal(task.due, saved.consultation_start);
});

test('an exact match is booked as asked, without the "closest" note', async () => {
  net = []; slots = [at(0), at(60)];
  const row = await processCall(call(2), as({ email: 'a@example.com' }));
  const saved = await store.findLead({ id: row.id });
  assert.equal(saved.lead.booking.exact, true);
  assert.doesNotMatch(sent('sms')[0].body.Body, /closest/);
});

test('no email, no booking: the caller gets the self-serve link instead', async () => {
  net = []; slots = [at(0)];
  await processCall(call(3), as({ email: null }));
  assert.equal(sent('invitees').length, 0);
  assert.match(sent('sms')[0].body.Body, /Choose a consultation time that suits you here: https:\/\/calendly\.com/);
});

test('nothing free within a day of the request: no booking, self-serve link', async () => {
  net = []; slots = [at(60 * 40)];
  await processCall(call(4), as({ email: 'b@example.com' }));
  assert.equal(sent('invitees').length, 0);
  assert.match(sent('sms')[0].body.Body, /Choose a consultation time/);
});

test('Calendly refuses the booking: it is recorded for the team and the caller still gets the link', async () => {
  net = []; slots = [at(0)]; inviteeFails = true;
  const row = await processCall(call(5), as({ email: 'c@example.com' }));
  inviteeFails = false;
  const saved = await store.findLead({ id: row.id });
  assert.match(saved.lead.booking_error, /Calendly 403: Upgrade your plan/);
  assert.equal(saved.consultation_status, 'link_ready');
  assert.match(sent('sms')[0].body.Body, /Choose a consultation time/);
  assert.match(sent('telegram')[0].text, /could not be booked automatically/);
});
