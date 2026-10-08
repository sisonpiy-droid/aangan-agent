// End to end: Vaani payload → pipeline → (stubbed) HubSpot + Telegram, Supabase in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

delete process.env.SUPABASE_URL;
Object.assign(process.env, {
  QUIET: '1', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_DESIGNERS_CHAT_ID: 'designers', TELEGRAM_NIKHIL_CHAT_ID: 'nikhil',
  HUBSPOT_SERVICE_KEY: 'k', HUBSPOT_PORTAL_ID: '123', HUBSPOT_PIPELINE_ID: 'p1',
  HUBSPOT_STAGE_QUALIFIED: 's-q', HUBSPOT_STAGE_REVIEW: 's-r', HUBSPOT_STAGE_BOOKED: 's-b', HUBSPOT_STAGE_DECLINED: 's-d',
  CALENDLY_EVENT_URL_RESIDENTIAL: 'https://calendly.com/aangan/consultation', CALENDLY_WEBHOOK_SIGNING_KEY: 'sk', CALENDLY_WEBHOOKS_ENABLED: 'false',
});

const { processCall } = await import('../lib/pipeline.js');
const { POST: calendlyWebhook } = await import('../api/calendly-webhook.js');
const { normalize } = await import('../lib/extract.js');
const store = await import('../lib/store.js');

const calls = JSON.parse(readFileSync(new URL('./transcripts.json', import.meta.url)));
const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('./leads.json', import.meta.url))).map(c => [c.id, c.lead]));
const as = id => ({ extractFn: async () => ({ lead: normalize(fixtures[id]), tokens: { in: 0, out: 0 } }) });

// Stubbed network: records every Telegram / HubSpot request; HubSpot can be made to fail.
let net = [], hubspotDown = false, msg = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url), body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  if (u.startsWith('https://api.telegram.org') && init.body instanceof FormData) { net.push({ to: 'telegram-doc' }); return Response.json({ ok: true, result: { message_id: ++msg } }); }
  if (u.startsWith('https://api.telegram.org')) { net.push({ to: 'telegram', chat: body.chat_id, text: body.text }); return Response.json({ ok: true, result: { message_id: ++msg } }); }
  if (u.startsWith('https://api.hubapi.com')) {
    net.push({ to: 'hubspot', path: u.slice(22), body });
    if (hubspotDown) return new Response('HubSpot is down', { status: 503 });
    if (init.method === 'PUT') return new Response(null, { status: 204 });
    if (/\/objects\/(notes|calls|tasks)$/.test(u)) return Response.json({ id: 'act-1' });
    return Response.json({ results: [{ id: u.includes('contacts') ? 'c-1' : 'd-1' }] });
  }
  throw new Error(`unexpected fetch ${u}`);
};
const telegrams = () => net.filter(n => n.to === 'telegram');
const dealUpserts = () => net.filter(n => n.to === 'hubspot' && n.path.includes('deals/batch')).map(n => n.body.inputs[0].properties);
let seq = 0;
const call = (key, extra = {}) => ({ ...calls[key], id: `e2e-${key}-${++seq}`, ...extra });

test('qualified → Calendly link → HubSpot deal → Telegram with the one-tap WhatsApp button (webhooks unavailable)', async () => {
  net = [];
  const row = await processCall(call('T01'), as('T01'));
  assert.equal(row.status, 'QUALIFIED');
  assert.match(row.calendly_booking_url, new RegExp(`^https://calendly\\.com/aangan/consultation\\?.*utm_content=${row.id}`));
  const deal = dealUpserts().at(-1);
  assert.equal(deal.aangan_calendly_booking_url, row.calendly_booking_url);
  assert.equal(deal.aangan_consultation_status, undefined); // manual mode: never overwrite a designer's HubSpot edit
  const [t] = telegrams();
  assert.equal(t.chat, 'designers');
  assert.match(t.text, /Send booking link on WhatsApp/);
  assert.match(t.text, /https:\/\/wa\.me\/919000000001\?text=/);
  assert.match(t.text, /not tracked automatically/);
  assert.match(t.text, /Open in HubSpot/);
  assert.ok(row.notified_at);
});

test('failed call WITH caller ID → designers get a call-back alert', async () => {
  net = [];
  const row = await processCall({ ...call('T01'), transcript: [], fromNumber: '+919000000101' }, { event: 'call.failed' });
  assert.deepEqual([row.status, row.reasons], ['NEEDS_REVIEW', ['CALL_FAILED_CALL_BACK']]);
  const t = telegrams();
  assert.equal(t.length, 1);
  assert.equal(t[0].chat, 'designers');
  assert.match(t[0].text, /CALL BACK/);
  assert.match(t[0].text, /tel:\+919000000101/);
});

test('dropped call (nothing captured) WITH caller ID → call-back alert too (T17a)', async () => {
  net = [];
  await processCall(call('T17a', { fromNumber: '+919000000102' }), { extractFn: async () => ({ lead: normalize({}), tokens: { in: 0, out: 0 } }) });
  assert.match(telegrams()[0]?.text ?? '', /CALL BACK/);
});

test('failed call WITHOUT caller ID → no Telegram; still recorded for the dashboard and HubSpot', async () => {
  net = [];
  const row = await processCall({ ...call('T01'), transcript: [], fromNumber: null }, { event: 'call.failed' });
  assert.equal(telegrams().length, 0);
  assert.equal(row.status, 'NEEDS_REVIEW');
  assert.equal(dealUpserts().at(-1).dealstage, 's-r');
  assert.ok((await store.findLead({ id: row.id })));
});

test('NEEDS_REVIEW stays out of Telegram (F06)', async () => {
  net = [];
  const row = await processCall(call('T11', { fromNumber: '+919000000106' }), as('F06'));
  assert.equal(row.status, 'NEEDS_REVIEW');
  assert.equal(telegrams().length, 0);
});

test('HubSpot failure → Telegram still sends, error saved and retryable', async () => {
  net = []; hubspotDown = true;
  const row = await processCall(call('T14'), as('T14'));
  hubspotDown = false;
  assert.match(row.hubspot_error, /503/);
  const [t] = telegrams();
  assert.match(t.text, /CRM sync failed/);
  assert.ok((await store.failedSyncs()).some(r => r.id === row.id));
});

function signed(body) {
  const raw = JSON.stringify(body), t = Math.floor(Date.now() / 1000);
  return new Request('http://x', { method: 'POST', body: raw, headers: { 'calendly-webhook-signature': `t=${t},v1=${createHmac('sha256', 'sk').update(`${t}.${raw}`).digest('hex')}` } });
}
const invitee = (event, id, leadId, extra = {}) => ({ event, payload: {
  uri: `https://api.calendly.com/scheduled_events/E${id}/invitees/I${id}`, name: 'Ritu', email: 'r@example.com',
  tracking: { utm_source: 'aangan_ai_front_desk', utm_content: String(leadId) },
  scheduled_event: { uri: `https://api.calendly.com/scheduled_events/E${id}`, start_time: '2026-10-14T05:30:00Z', end_time: '2026-10-14T06:30:00Z' }, ...extra } });

test('Calendly webhooks available: booking → Supabase + HubSpot stage + Telegram; duplicate processed once; cancel moves it back', async () => {
  process.env.CALENDLY_WEBHOOKS_ENABLED = 'true';
  const lead = await processCall(call('T17b', { fromNumber: '+919000000117' }), as('T17'));

  net = [];
  const book = invitee('invitee.created', 77, lead.id);
  assert.equal((await calendlyWebhook(signed(book))).status, 200);
  assert.equal((await (await calendlyWebhook(signed(book))).json()).duplicate, true); // Calendly retry
  assert.equal(telegrams().length, 1, 'one confirmation, not two');
  assert.equal(dealUpserts().length, 1, 'one HubSpot update, not two');
  assert.match(telegrams()[0].text, /Consultation booked/);
  assert.equal(dealUpserts()[0].dealstage, 's-b');
  assert.equal(dealUpserts()[0].aangan_consultation_status, 'booked');
  assert.equal((await store.findLead({ id: lead.id })).consultation_status, 'booked');

  net = [];
  await calendlyWebhook(signed(invitee('invitee.canceled', 77, lead.id, { cancellation: { reason: 'out of town' } })));
  const row = await store.findLead({ id: lead.id });
  assert.deepEqual([row.consultation_status, row.calendly_cancel_reason, row.status], ['canceled', 'out of town', 'QUALIFIED']);
  const deal = dealUpserts().at(-1);
  assert.deepEqual([deal.dealstage, deal.aangan_consultation_status, deal.aangan_cancel_reason, deal.aangan_qualification_status],
    ['s-q', 'canceled', 'out of town', 'QUALIFIED']);
  assert.match(telegrams()[0].text, /Consultation canceled/);
  process.env.CALENDLY_WEBHOOKS_ENABLED = 'false';
});

test('the agent never promises a slot: booking line is exact and passes the scanner', async () => {
  const { CLOSINGS } = await import('../lib/rules.js');
  const { scanAgentLines } = await import('../lib/scan.js');
  assert.equal(CLOSINGS.BOOK, "Thank you — I've noted everything. A designer will send you a link where you can choose a convenient consultation time.");
  assert.doesNotMatch(CLOSINGS.BOOK, /\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today/i);
  for (const bad of ['I have booked you for Saturday at 11.', 'We have a slot free at 4pm tomorrow.', 'Thursday at 3 is available.', 'See you on Monday!']) {
    assert.deepEqual(scanAgentLines([{ role: 'AGENT', text: bad }]), ['SLOT_PROMISED'], bad);
  }
  assert.match(readFileSync(new URL('../prompt/agent.md', import.meta.url), 'utf8'), /A designer will send you a link where you can choose a convenient consultation time\./);
});
