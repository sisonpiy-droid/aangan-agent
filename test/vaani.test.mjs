// Vaani Voice adapter, using the payload shapes from docs.vaanivoice.ai/guides/webhook-setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const k of ['SUPABASE_URL', 'HUBSPOT_SERVICE_KEY', 'TELEGRAM_BOT_TOKEN', 'CALENDLY_EVENT_URL_RESIDENTIAL']) delete process.env[k];
Object.assign(process.env, { QUIET: '1', VAANI_WEBHOOK_SECRET: 'vaani-test-secret' });

const { parseTranscript, toCall, isOutbound } = await import('../lib/vaani.js');
const { handleVaaniEvent, POST } = await import('../api/call-ended.js');
const { normalize } = await import('../lib/extract.js');
const store = await import('../lib/store.js');

const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('./leads.json', import.meta.url))).map(c => [c.id, c.lead]));
const as = id => ({ extractFn: async () => ({ lead: normalize(fixtures[id]), tokens: { in: 0, out: 0 } }) });

// The T01 call as Vaani Voice would send it.
const T01_TEXT = `[10:23:02] AGENT: Hello, Aangan Studio. How can I help you today?

[10:23:09] USER: Hi, I'm Priya. We have a 3BHK in Kothrud — Dahanukar Colony. We want to redo the whole thing — kitchen, living room, both bedrooms.

[10:23:20] AGENT: That sounds like a complete redesign. How big is the apartment?
[10:23:24] USER: About 1,400 sq ft carpet.

[10:23:30] AGENT: When would you need the project complete?

[10:23:34] USER: We'd like to be done by March. We're in no rush.`;
const started = (room, phone) => ({ event: 'call_started', room_name: room, status: 'dialing', phone_number: phone });
const post = (room, text, extra = {}) => ({
  event: 'call_postprocessing', call_id: room, timestamp: '2026-09-02T04:57:30+00:00',
  data: { room_name: room, call_id: room, call_duration: 252000.4, end_reason: 'Call ended', summary: 'Enquiry.', transcript: text,
    entities: { name: 'Priya', preferred_time: 'weekday evenings' }, recording_url: `https://api.vaanivoice.ai/api/stream/${room}`, ...extra },
});
const req = (body, key) => new Request(`http://x/api/call-ended${key ? `?key=${key}` : ''}`, { method: 'POST', body: JSON.stringify(body) });

test('transcript text → AGENT/CALLER lines (USER → CALLER, timestamps dropped, wrapped lines joined)', () => {
  const t = parseTranscript(T01_TEXT);
  assert.equal(t.length, 6);
  assert.deepEqual(t[0], { role: 'AGENT', text: 'Hello, Aangan Studio. How can I help you today?' });
  assert.equal(t[1].role, 'CALLER');
  assert.equal(t[3].text, 'About 1,400 sq ft carpet.');
  assert.deepEqual(parseTranscript('AGENT: Hi\n USER: Hello there\ncontinued'), [{ role: 'AGENT', text: 'Hi' }, { role: 'CALLER', text: 'Hello there continued' }]);
  assert.deepEqual(parseTranscript(''), []);
});

test('toCall: ms → seconds, entities → collectedData, caller ID from call_started, start time from call_started', () => {
  const c = toCall(post('inbound-1', T01_TEXT), { payload: started('inbound-1', '+919000000001'), created_at: '2026-09-02T04:53:00Z' });
  assert.deepEqual([c.id, c.fromNumber, c.durationSec, c.createdAt], ['inbound-1', '+919000000001', 252, '2026-09-02T04:53:00Z']);
  assert.equal(c.collectedData.preferred_time, 'weekday evenings');
  assert.match(c.recordingUrl, /inbound-1$/);
  // No call_started saved: start time = postprocessing timestamp − duration.
  assert.equal(toCall(post('inbound-2', T01_TEXT)).createdAt, new Date(Date.parse('2026-09-02T04:57:30Z') - 252000.4).toISOString());
  // Agent-only transcript = a failed/dropped call.
  assert.deepEqual(toCall(post('inbound-3', '[10:00:00] AGENT: Hello, Aangan Studio. How can I help you today?')).transcript, []);
});

test('webhook URL key: missing or wrong → 401; right → accepted', async () => {
  assert.equal((await POST(req(started('inbound-k', '+919000000555')))).status, 401);
  assert.equal((await POST(req(started('inbound-k', '+919000000555'), 'wrong'))).status, 401);
  const ok = await POST(req(started('inbound-k', '+919000000555'), 'vaani-test-secret'));
  assert.equal(ok.status, 200);
  assert.equal((await store.findEvent('vaani', 'call_started', 'inbound-k')).payload.phone_number, '+919000000555');
});

test('call_started then call_postprocessing → qualified lead with the caller ID and Vaani entities', async () => {
  await handleVaaniEvent(started('inbound-100', '+919000000100'));
  const r = await handleVaaniEvent(post('inbound-100', T01_TEXT), as('T01'));
  assert.equal(r.status, 'QUALIFIED');
  const row = await store.findLead({ id: r.lead });
  assert.deepEqual([row.phone, row.duration_sec, row.call_ids[0]], ['+919000000100', 252, 'inbound-100']);
  assert.equal(row.lead.preferred_slot, 'weekday evenings'); // from Vaani's entities when Gemini found none
  assert.equal(row.transcript[1].role, 'CALLER');
});

test('duplicate call_postprocessing → processed once', async () => {
  await handleVaaniEvent(started('inbound-101', '+919000000101'));
  const a = await handleVaaniEvent(post('inbound-101', T01_TEXT), as('T01'));
  const b = await handleVaaniEvent(post('inbound-101', T01_TEXT), as('T01'));
  assert.ok(a.lead);
  assert.deepEqual(b, { lead: null, status: 'duplicate' });
});

test('dropped inbound call (caller said nothing) with caller ID → call-back review', async () => {
  await handleVaaniEvent(started('inbound-102', '+919000000102'));
  const r = await handleVaaniEvent(post('inbound-102', '[22:47:01] AGENT: Hello, Aangan Studio. How can I help you today?', { call_duration: 4000 }));
  const row = await store.findLead({ id: r.lead });
  assert.deepEqual([row.status, row.reasons, row.phone], ['NEEDS_REVIEW', ['CALL_FAILED_CALL_BACK'], '+919000000102']);
});

test('outbound calls and other events are not treated as enquiries', async () => {
  assert.equal(isOutbound(post('outbound-1784899978-36cec598', T01_TEXT)), true);
  assert.deepEqual(await handleVaaniEvent(post('outbound-1784899978-36cec598', T01_TEXT)), { ignored: 'outbound' });
  assert.deepEqual(await handleVaaniEvent({ event: 'call_ended', room_name: 'inbound-103', call_duration: 42.5 }), { logged: 'call_ended' });
  assert.equal(await store.findLead({ phone: 'none' }), null);
});
