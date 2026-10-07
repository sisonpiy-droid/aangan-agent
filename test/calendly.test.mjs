// Calendly end to end on the in-memory store: call → link → booked → rescheduled → canceled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

for (const k of ['SUPABASE_URL', 'HUBSPOT_SERVICE_KEY', 'TELEGRAM_BOT_TOKEN']) delete process.env[k];
Object.assign(process.env, { QUIET: '1', CALENDLY_WEBHOOKS_ENABLED: 'true', CALENDLY_WEBHOOK_SIGNING_KEY: 'test-signing-key',
  CALENDLY_EVENT_URL_RESIDENTIAL: 'https://calendly.com/aangan/consultation', CALENDLY_EVENT_URL_COMMERCIAL: 'https://calendly.com/aangan/office-consultation' });

const { bookingLink, calendlySignatureOk, parseWebhook } = await import('../lib/calendly.js');
const { processCall } = await import('../lib/pipeline.js');
const { POST } = await import('../api/calendly-webhook.js');
const { normalize } = await import('../lib/extract.js');
const { scanAgentLines } = await import('../lib/scan.js');
const store = await import('../lib/store.js');

const calls = JSON.parse(readFileSync(new URL('./transcripts.json', import.meta.url)));
const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('./leads.json', import.meta.url))).map(c => [c.id, c.lead]));
const offline = id => ({ extractFn: async () => ({ lead: normalize(fixtures[id]), tokens: { in: 0, out: 0 } }) });

function signed(body, key = 'test-signing-key', t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const sig = `t=${t},v1=${createHmac('sha256', key).update(`${t}.${raw}`).digest('hex')}`;
  return new Request('http://x/api/calendly-webhook', { method: 'POST', body: raw, headers: { 'calendly-webhook-signature': sig } });
}
const invitee = (event, { id, leadId, start, old, rescheduled, reason, phone } = {}) => ({
  event,
  payload: {
    uri: `https://api.calendly.com/scheduled_events/EV-${id}/invitees/INV-${id}`, name: 'Priya', email: 'priya@example.com',
    tracking: leadId ? { utm_source: 'aangan_ai_front_desk', utm_content: String(leadId) } : {},
    scheduled_event: { uri: `https://api.calendly.com/scheduled_events/EV-${id}`, start_time: start, end_time: start && new Date(Date.parse(start) + 3600e3).toISOString() },
    old_invitee: old ? `https://api.calendly.com/scheduled_events/EV-${old}/invitees/INV-${old}` : null,
    rescheduled: !!rescheduled, cancellation: reason ? { reason } : null, text_reminder_number: phone ?? null,
  },
});

test('booking link: right event type, lead id in utm_content, name prefilled', () => {
  const res = new URL(bookingLink({ id: 7, lead: { segment: 'residential', name: 'Priya' } }));
  assert.equal(res.origin + res.pathname, 'https://calendly.com/aangan/consultation');
  assert.equal(res.searchParams.get('utm_content'), '7');
  assert.equal(res.searchParams.get('name'), 'Priya');
  assert.match(bookingLink({ id: 8, lead: { segment: 'commercial' } }), /office-consultation/);
});

test('signature: valid, tampered, stale, missing key', () => {
  const raw = '{"a":1}', t = 1_800_000_000, h = `t=${t},v1=${createHmac('sha256', 'k').update(`${t}.${raw}`).digest('hex')}`;
  assert.equal(calendlySignatureOk(raw, h, 'k', t + 10), true);
  assert.equal(calendlySignatureOk(raw + ' ', h, 'k', t + 10), false);
  assert.equal(calendlySignatureOk(raw, h, 'k', t + 3600), false);
  assert.equal(calendlySignatureOk(raw, h, undefined, t), false);
});

test('parseWebhook: booked / rescheduled / reschedule-cancel / canceled', () => {
  assert.equal(parseWebhook(invitee('invitee.created', { id: 1 })).kind, 'booked');
  assert.equal(parseWebhook(invitee('invitee.created', { id: 2, old: 1 })).kind, 'rescheduled');
  assert.equal(parseWebhook(invitee('invitee.canceled', { id: 1, rescheduled: true })).kind, 'reschedule_pending');
  assert.equal(parseWebhook(invitee('invitee.canceled', { id: 2, reason: 'travel' })).kind, 'canceled');
  assert.equal(parseWebhook({ event: 'invitee.created', payload: { tracking: { utm_source: 'aangan_ai_front_desk', utm_content: '5; drop' } } }).leadId, null);
});

test('qualified call → link; booked → rescheduled → canceled; duplicates and bad signatures ignored', async () => {
  const lead = await processCall({ ...calls.T01, id: 'cal-T01' }, offline('T01'));
  assert.equal(lead.status, 'QUALIFIED');
  assert.equal(lead.consultation_status, 'link_ready');
  assert.match(lead.calendly_booking_url, new RegExp(`utm_content=${lead.id}`));

  assert.equal((await POST(signed(invitee('invitee.created', { id: 1, leadId: lead.id }), 'wrong-key'))).status, 401);

  const book = invitee('invitee.created', { id: 1, leadId: lead.id, start: '2026-10-10T05:00:00Z' });
  assert.equal((await (await POST(signed(book))).json()).kind, 'booked');
  let row = await store.findLead({ id: lead.id });
  assert.deepEqual([row.consultation_status, row.consultation_start, row.calendly_invitee_id, row.calendly_event_id], ['booked', '2026-10-10T05:00:00Z', 'INV-1', 'EV-1']);
  assert.equal((await (await POST(signed(book))).json()).duplicate, true); // Calendly retry

  // Reschedule = cancel(rescheduled) on the old invitee, then created(old_invitee) on the new one.
  await POST(signed(invitee('invitee.canceled', { id: 1, leadId: lead.id, rescheduled: true })));
  assert.equal((await store.findLead({ id: lead.id })).consultation_status, 'booked');
  await POST(signed(invitee('invitee.created', { id: 2, old: 1, leadId: lead.id, start: '2026-10-12T06:30:00Z' })));
  row = await store.findLead({ id: lead.id });
  assert.deepEqual([row.consultation_status, row.consultation_start, row.calendly_invitee_id], ['rescheduled', '2026-10-12T06:30:00Z', 'INV-2']);

  // A late cancel for the old invitee changes nothing; a cancel for the current one does.
  await POST(signed(invitee('invitee.canceled', { id: 1, leadId: lead.id, reason: 'late duplicate' })));
  assert.equal((await store.findLead({ id: lead.id })).consultation_status, 'rescheduled');
  await POST(signed(invitee('invitee.canceled', { id: 2, leadId: lead.id, reason: 'travelling' })));
  row = await store.findLead({ id: lead.id });
  assert.deepEqual([row.consultation_status, row.calendly_cancel_reason], ['canceled', 'travelling']);
});

test('booking without utm is matched by phone, else logged as unmatched', async () => {
  const lead = await processCall({ ...calls.T11, id: 'cal-T11' }, offline('T11'));
  await POST(signed(invitee('invitee.created', { id: 3, start: '2026-10-11T05:00:00Z', phone: '+91 90000 00011' })));
  assert.equal((await store.findLead({ id: lead.id })).consultation_status, 'booked');

  const before = await store.countEvents('unmatched', '2000-01-01T00:00:00Z');
  const r = await (await POST(signed(invitee('invitee.created', { id: 4, start: '2026-10-11T05:00:00Z', phone: '+919999999999' })))).json();
  assert.equal(r.lead, null);
  assert.equal(await store.countEvents('unmatched', '2000-01-01T00:00:00Z'), before + 1);
});

test('declined callers get no booking link; escalations neither', async () => {
  const d = await processCall({ ...calls.T03, id: 'cal-T03' }, offline('T03'));
  assert.equal(d.calendly_booking_url ?? null, null);
  const e = await processCall({ ...calls.T09, id: 'cal-T09' }, offline('T09'));
  assert.equal(e.calendly_booking_url ?? null, null);
});

test('the agent never states availability: booking line passes the slot scanner', async () => {
  const { CLOSINGS } = await import('../lib/rules.js');
  assert.deepEqual(scanAgentLines([{ role: 'AGENT', text: CLOSINGS.BOOK }]), []);
  assert.deepEqual(scanAgentLines([{ role: 'AGENT', text: 'We have Saturday at 11 available — I have booked you for that.' }]), ['SLOT_PROMISED']);
});
