// The workflow extras: next task, transcript file, HubSpot Note/Call/Task, lead page, digest, fallbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.SUPABASE_URL;
Object.assign(process.env, {
  QUIET: '1', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_DESIGNERS_CHAT_ID: 'designers', TELEGRAM_NIKHIL_CHAT_ID: 'nikhil',
  HUBSPOT_SERVICE_KEY: 'k', HUBSPOT_PORTAL_ID: '123', HUBSPOT_PIPELINE_ID: 'p1',
  HUBSPOT_STAGE_QUALIFIED: 's-q', HUBSPOT_STAGE_REVIEW: 's-r', HUBSPOT_STAGE_BOOKED: 's-b', HUBSPOT_STAGE_DECLINED: 's-d',
  CALENDLY_EVENT_URL_RESIDENTIAL: 'https://calendly.com/aangan/consultation', CALENDLY_WEBHOOKS_ENABLED: 'false',
  PUBLIC_BASE_URL: 'https://aangan.example', DASHBOARD_PASSCODE: 'pw', CRON_SECRET: 'cron-secret', VAANI_INR_PER_MIN: '5.58',
});

const { processCall, syncAndNotify } = await import('../lib/pipeline.js');
const { normalize } = await import('../lib/extract.js');
const { nextTask, RECONTACT_WEEKS } = await import('../lib/tasks.js');
const { formatNote, emailLink, transcriptText } = await import('../lib/notify.js');
const { GET: leadPage } = await import('../api/lead.js');
const { GET: digest } = await import('../api/weekly-digest.js');
const { digestText } = await import('../lib/digest.js');
const { summarise } = await import('../lib/summary.js');
const store = await import('../lib/store.js');

const calls = JSON.parse(readFileSync(new URL('./transcripts.json', import.meta.url)));
const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('./leads.json', import.meta.url))).map(c => [c.id, c.lead]));
const as = (id, patch = {}) => ({ extractFn: async () => ({ lead: normalize({ ...fixtures[id], ...patch }), tokens: { in: 1000, out: 200 } }) });
let seq = 0;
// A unique caller per call, so tests don't merge into each other the way a real redial would.
const call = (key, extra = {}) => ({ ...calls[key], id: `wf-${key}-${++seq}`, fromNumber: `+9195${String(seq).padStart(8, '0')}`, ...extra });

// Stubbed network. `failPath` makes matching HubSpot requests fail; `plainOnly` makes HTML messages "unparseable".
let net = [], msg = 0, failPath = null, htmlRejected = false;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org')) {
    if (init.body instanceof FormData) {
      const f = init.body, doc = f.get('document');
      net.push({ to: 'doc', chat: f.get('chat_id'), caption: f.get('caption'), replyTo: f.get('reply_to_message_id'), filename: doc.name, text: await doc.text() });
      return Response.json({ ok: true, result: { message_id: ++msg } });
    }
    const b = JSON.parse(init.body);
    if (htmlRejected && b.parse_mode === 'HTML') return new Response('{"ok":false,"description":"Bad Request: can\'t parse entities"}', { status: 400 });
    net.push({ to: 'telegram', chat: b.chat_id, text: b.text, mode: b.parse_mode });
    return Response.json({ ok: true, result: { message_id: ++msg } });
  }
  const body = init.body ? JSON.parse(init.body) : null, path = u.replace('https://api.hubapi.com', '');
  net.push({ to: 'hubspot', method: init.method, path, body });
  if (failPath && path.includes(failPath)) return new Response('MISSING_SCOPES', { status: 403 });
  if (init.method === 'PUT') return new Response(null, { status: 204 });
  if (/\/objects\/(notes|calls|tasks)$/.test(path)) return Response.json({ id: `act-${net.length}` });
  return Response.json({ results: [{ id: path.includes('contacts') ? 'c-1' : 'd-1' }] });
};
const tg = () => net.filter(n => n.to === 'telegram');
const docs = () => net.filter(n => n.to === 'doc');
const created = type => net.filter(n => n.to === 'hubspot' && n.method === 'POST' && n.path === `/crm/v3/objects/${type}`).map(n => n.body);

const SUMMARY = 'Priya wants a full redesign of her 3BHK in Kothrud (1,400 sq ft) by March; her husband agrees.';

test('next task: qualified, escalation, call-back, review, re-contact, and none for permanent declines', () => {
  const base = { reasons: [], notes: [], lead: { name: 'Priya' }, calendly_booking_url: 'https://c/x' };
  assert.equal(nextTask({ ...base, status: 'QUALIFIED' }).line, 'Send the Calendly link and confirm a visit within 1 hour');
  assert.equal(nextTask({ ...base, status: 'QUALIFIED' }).dueMin, 60);
  assert.equal(nextTask({ ...base, status: 'QUALIFIED', calendly_booking_url: null }).line, 'Call the caller and book a consultation within 1 hour');
  assert.equal(nextTask({ ...base, status: 'QUALIFIED', notes: ['HIGH_VALUE'] }).priority, 'HIGH');
  assert.equal(nextTask({ ...base, status: 'ESCALATE' }).dueMin, 15);
  assert.equal(nextTask({ ...base, status: 'NEEDS_REVIEW', phone: '+91900', reasons: ['CALL_FAILED_CALL_BACK'] }).key, 'callback');
  assert.equal(nextTask({ ...base, status: 'NEEDS_REVIEW', reasons: ['SITE_AVAILABLE_LATE'] }).key, 'review');
  const later = nextTask({ ...base, status: 'DECLINED', reasons: ['TIMELINE_TOO_SHORT'] });
  assert.deepEqual([later.key, later.dueMin], ['recontact', RECONTACT_WEEKS * 7 * 24 * 60]);
  assert.equal(nextTask({ ...base, status: 'DECLINED', reasons: ['NOT_A_FULL_PROJECT'] }).key, 'recontact');
  for (const r of ['OUT_OF_AREA', 'BUDGET_CLEARLY_BELOW', 'BUSINESS_TYPE_OUT_OF_SCOPE']) assert.equal(nextTask({ ...base, status: 'DECLINED', reasons: [r] }), null, r);
});

test('qualified call: Telegram note has Next task, summary, lead page, HubSpot link; transcript arrives as a .txt reply', async () => {
  net = [];
  const row = await processCall(call('T01', { summary: SUMMARY }), as('T01'));
  assert.equal(row.lead.call_summary, SUMMARY);
  const [note] = tg();
  assert.equal(note.chat, 'designers');
  assert.match(note.text, /Next task:<\/b> Send the Calendly link and confirm a visit within 1 hour/);
  assert.match(note.text, /Summary: Priya wants a full redesign/);
  assert.match(note.text, new RegExp(`https://aangan\\.example/\\?lead=${row.id}`));
  assert.match(note.text, /Open in HubSpot/);
  const [doc] = docs();
  assert.deepEqual([doc.chat, doc.filename, doc.caption], ['designers', `aangan-call-${row.id}.txt`, 'Full call transcript']);
  assert.ok(doc.replyTo, 'attached as a reply to the note');
  assert.match(doc.text, /AGENT : Good morning, Aangan Studio/);
  assert.match(doc.text, /CALLER: Hi, I'm Priya/);
  assert.match(doc.text, /Status: QUALIFIED/);
});

test('no transcript file when the caller said nothing; the call-back note says so', async () => {
  net = [];
  await processCall({ ...call('T01'), transcript: [], fromNumber: '+919000000201' });
  assert.equal(docs().length, 0);
  assert.match(tg()[0].text, /Next task:<\/b> Call back now/);
});

test('HubSpot: one Note, one Call (with transcript) and one Task on the deal and contact', async () => {
  net = [];
  const before = Date.now();
  await processCall(call('T01', { summary: SUMMARY }), as('T01'));
  const [note] = created('notes'), [callRec] = created('calls'), [task] = created('tasks');
  assert.match(note.properties.hs_note_body, /AI front desk — QUALIFIED/);
  assert.match(note.properties.hs_note_body, /Priya wants a full redesign/);
  assert.deepEqual(note.associations.map(a => a.types[0].associationTypeId).sort(), [202, 214]);
  assert.equal(callRec.properties.hs_call_direction, 'INBOUND');
  assert.equal(callRec.properties.hs_call_status, 'COMPLETED');
  assert.equal(callRec.properties.hs_call_duration, '252000');
  assert.match(callRec.properties.hs_call_body, /<b>Caller:<\/b> Hi, I&#39;m Priya|<b>Caller:<\/b> Hi, I'm Priya/);
  assert.equal(callRec.properties.hs_call_recording_url, undefined, 'recording goes in the body, not the audio-only field');
  assert.deepEqual(callRec.associations.map(a => a.types[0].associationTypeId).sort(), [194, 206]);
  assert.equal(task.properties.hs_task_subject, 'Send consultation link — Priya');
  assert.equal(task.properties.hs_task_status, 'NOT_STARTED');
  const due = Date.parse(task.properties.hs_timestamp) - before;
  assert.ok(due > 59 * 60e3 && due < 61 * 60e3, `due in about 1 hour, got ${due / 60e3} min`);
  assert.deepEqual(task.associations.map(a => a.types[0].associationTypeId).sort(), [204, 216]);
});

test('a retry or booking update never duplicates the Note, Call or Task', async () => {
  net = [];
  const row = await processCall(call('T01', { fromNumber: '+919000000202' }), as('T01'));
  const n = () => created('notes').length + created('calls').length + created('tasks').length;
  assert.equal(n(), 3);
  await syncAndNotify(row, { renotify: false });
  await syncAndNotify({ ...row, consultation_status: 'booked' }, { renotify: false });
  assert.equal(n(), 3);
});

test('declined for a later start → re-contact task about 5 weeks out on the deal; out of area → none', async () => {
  net = [];
  const before = Date.now();
  await processCall(call('T07'), as('T07'));
  const [t] = created('tasks');
  assert.match(t.properties.hs_task_subject, /Re-contact/);
  const weeks = (Date.parse(t.properties.hs_timestamp) - before) / (7 * 864e5);
  assert.ok(weeks > RECONTACT_WEEKS - 0.01 && weeks < RECONTACT_WEEKS + 0.01);
  assert.match(t.properties.hs_task_body, /timeline too short/);
  assert.equal(tg().length, 0, 'declined leads still send no Telegram');
  net = [];
  await processCall(call('T03'), as('T03'));
  assert.equal(created('tasks').length, 0);
});

test('escalation: task on the contact only, no deal', async () => {
  net = [];
  await processCall(call('T09'), as('T09'));
  const [t] = created('tasks');
  assert.deepEqual(t.associations.map(a => a.types[0].associationTypeId), [204]);
  assert.equal(net.filter(n => n.path?.includes('deals/batch')).length, 0);
  assert.equal(tg()[0].chat, 'nikhil');
});

test('NEEDS_REVIEW gets a HubSpot task and stays off Telegram', async () => {
  net = [];
  await processCall(call('T11', { fromNumber: '+919000000203' }), as('F06'));
  assert.match(created('tasks')[0].properties.hs_task_subject, /Review AI lead/);
  assert.equal(tg().length, 0);
});

test('activity failure (missing HubSpot scope) is visible, Telegram still goes, and a retry creates it once', async () => {
  net = []; failPath = '/objects/notes';
  const row = await processCall(call('T01', { fromNumber: '+919000000204' }), as('T01'));
  failPath = null;
  assert.match(row.hubspot_error, /^activity: .*403/);
  assert.equal(tg().length, 1);
  assert.ok((await store.failedSyncs()).some(r => r.id === row.id));
  const healed = await syncAndNotify(row, { renotify: false });
  assert.equal(healed.hubspot_error, null);
  assert.equal(created('notes').length, 2, 'the failed attempt + the retry');
  assert.equal(created('calls').length, 1, 'the call and task were not duplicated');
  assert.equal(created('tasks').length, 1);
});

test('email link appears only when the caller gave an address', async () => {
  const row = { id: 1, phone: '+919000000001', calendly_booking_url: 'https://c/x', lead: { name: 'Priya', email: 'priya@example.com' }, status: 'QUALIFIED',
    reasons: [], notes: [], duration_sec: 60, call_started_at: '2026-09-02T04:53:00Z' };
  assert.match(emailLink(row), /^mailto:priya@example\.com\?subject=/);
  assert.match(decodeURIComponent(emailLink(row)), /https:\/\/c\/x/);
  assert.match(formatNote(row), /Email it/);
  assert.equal(emailLink({ ...row, lead: { name: 'Priya' } }), null);
  assert.doesNotMatch(formatNote({ ...row, lead: { name: 'Priya' } }), /Email it/);
});

test('a link Telegram cannot parse → the handoff is resent as plain text, never lost', async () => {
  net = []; htmlRejected = true;
  const row = await processCall(call('T01', { fromNumber: '+919000000205', summary: SUMMARY }), as('T01'));
  htmlRejected = false;
  assert.ok(row.notified_at);
  const [note] = tg();
  assert.equal(note.mode, undefined);
  assert.doesNotMatch(note.text, /<b>|<a href/);
  assert.match(note.text, /Next task: Send the Calendly link/);
  assert.ok(note.text.includes(`Send booking link on WhatsApp (https://wa.me/${row.phone.replace('+', '')}?text=`), 'the WhatsApp link survives the plain-text resend');
});

test('lead page API: passcode, transcript, next task and timeline', async () => {
  const row = await processCall(call('T01', { fromNumber: '+919000000206', summary: SUMMARY }), as('T01'));
  const req = (id, pw) => new Request(`http://x/api/lead?id=${id}`, { headers: pw ? { 'x-passcode': pw } : {} });
  assert.equal((await leadPage(req(row.id))).status, 401);
  assert.equal((await leadPage(req('abc', 'pw'))).status, 400);
  assert.equal((await leadPage(req(999999, 'pw'))).status, 404);
  const d = await (await leadPage(req(row.id, 'pw'))).json();
  assert.equal(d.transcript.length, calls.T01.transcript.length);
  assert.equal(d.next_task, 'Send the Calendly link and confirm a visit within 1 hour');
  assert.equal(d.lead.call_summary, SUMMARY);
  assert.ok(d.events.some(e => e.source === 'rules' && e.type === 'decided'));
  assert.ok(d.events.some(e => e.source === 'hubspot' && e.type === 'activity'));
});

test('weekly digest: cron secret required; one message to Nikhil with the numbers, cost and decline reasons', async () => {
  const get = bearer => digest(new Request('http://x/api/weekly-digest', { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));
  assert.equal((await get()).status, 401);
  assert.equal((await get('wrong')).status, 401);
  // Fresh calls from "this week", plus declines for the reasons list.
  const now = Date.now();
  for (const [k, id] of [['T01', 'T01'], ['T03', 'T03'], ['T04', 'T04'], ['T10', 'T10']]) {
    await processCall({ ...call(k, { fromNumber: `+9190000003${id.slice(1)}` }), createdAt: new Date(now - 2 * 864e5).toISOString() }, as(id));
  }
  net = [];
  const r = await (await get('cron-secret')).json();
  assert.equal(r.sent, true);
  const msgs = tg().filter(m => m.chat === 'nikhil');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /last 7 days/);
  assert.match(msgs[0].text, /Calls answered: <b>\d+<\/b>/);
  assert.match(msgs[0].text, /Top decline reasons: .*(out of area|not a full project|budget clearly below)/);
  assert.match(msgs[0].text, /Cost to run: <b>₹[\d,.]+<\/b>/);
  assert.match(msgs[0].text, /Booking links ready/);
});

test('digest text: empty week, week-on-week change and warnings', () => {
  assert.match(digestText(summarise([], 7), 0), /No calls this week/);
  const rows = [{ id: 1, status: 'QUALIFIED', reasons: [], notes: [], flags: ['PRICING_LEAK'], call_started_at: '2026-10-05T05:00:00Z', duration_sec: 120, cost_inr: 11.16, hubspot_error: 'x', lead: {} }];
  const t = digestText(summarise(rows, 7), 3, { now: new Date('2026-10-12T05:00:00Z') });
  assert.match(t, /Calls answered: <b>1<\/b> \(-2 vs the week before\)/);
  assert.match(t, /1 price\/slot flag\(s\)/);
  assert.match(t, /1 HubSpot sync\(s\) failed/);
});

test('transcript file contains every line, in order', () => {
  const t = transcriptText({ lead: { name: 'Priya' }, phone: '+91', status: 'QUALIFIED', duration_sec: 90, call_started_at: '2026-09-02T04:53:00Z',
    transcript: [{ role: 'AGENT', text: 'Hello' }, { role: 'CALLER', text: 'Hi there' }] });
  assert.ok(t.indexOf('AGENT : Hello') < t.indexOf('CALLER: Hi there') || t.indexOf('AGENT: Hello') < t.indexOf('CALLER: Hi there'));
});
