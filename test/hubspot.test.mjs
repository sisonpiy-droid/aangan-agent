import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { syncLead, syncCrm, contactProps, dealProps, e164 } from '../lib/hubspot.js';
import { qualify } from '../lib/rules.js';
import { shouldNotify, formatNote } from '../lib/notify.js';

Object.assign(process.env, { HUBSPOT_SERVICE_KEY: 'test', HUBSPOT_PIPELINE_ID: 'p1', HUBSPOT_STAGE_QUALIFIED: 's-q', HUBSPOT_STAGE_REVIEW: 's-r', HUBSPOT_STAGE_DECLINED: 's-d', HUBSPOT_STAGE_BOOKED: 's-b', CALENDLY_WEBHOOKS_ENABLED: 'true' });
const cases = Object.fromEntries(JSON.parse(readFileSync(new URL('./leads.json', import.meta.url))).map(c => [c.id, c]));
const rowFor = (id, extra = {}) => {
  const c = cases[id], r = qualify(c.lead, new Date(c.at), { final: true });
  return { id: 42, phone: '+919000000001', call_ids: ['call-1'], lead: c.lead, status: r.status, reasons: r.reasons, notes: r.notes, flags: [], ...extra };
};

function stubFetch(fail) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url).replace('https://api.hubapi.com', ''), method: init.method, body: init.body && JSON.parse(init.body) });
    if (fail) return new Response('boom', { status: 500 });
    if (init.method === 'PUT') return new Response(null, { status: 204 });
    return Response.json({ results: [{ id: String(url).includes('contacts') ? 'c-9' : 'd-7' }] });
  };
  return calls;
}

test('phone normalisation to E.164', () => {
  assert.equal(e164('+91 90000 00001'), '+919000000001');
  assert.equal(e164('9000000001'), '+919000000001');
  assert.equal(e164('09000000001'), '+919000000001');
  assert.equal(e164(null), null);
});

test('qualified lead: contact upsert by phone, deal upsert by lead id, then association', async () => {
  const calls = stubFetch();
  const ids = await syncLead(rowFor('T01'));
  assert.deepEqual(ids, { contactId: 'c-9', dealId: 'd-7' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, '/crm/v3/objects/contacts/batch/upsert');
  assert.deepEqual([calls[0].body.inputs[0].idProperty, calls[0].body.inputs[0].id], ['aangan_phone_e164', '+919000000001']);
  assert.equal(calls[1].url, '/crm/v3/objects/deals/batch/upsert');
  assert.deepEqual([calls[1].body.inputs[0].idProperty, calls[1].body.inputs[0].id], ['aangan_lead_id', '42']);
  assert.equal(calls[1].body.inputs[0].properties.dealstage, 's-q');
  assert.deepEqual([calls[2].method, calls[2].url], ['PUT', '/crm/v4/objects/deals/d-7/associations/default/contacts/c-9']);
});

test('sync is idempotent: the same row sends the same upsert keys and properties', async () => {
  const a = stubFetch(); await syncLead(rowFor('T01'));
  const b = stubFetch(); await syncLead(rowFor('T01'));
  assert.deepEqual(a, b);
});

test('escalation updates the contact only, no deal', async () => {
  const calls = stubFetch();
  const ids = await syncLead(rowFor('T09'));
  assert.equal(calls.length, 1);
  assert.deepEqual(ids, { contactId: 'c-9', dealId: null });
});

test('no caller ID: deal without a contact', async () => {
  const calls = stubFetch();
  await syncLead(rowFor('T01', { phone: null }));
  assert.deepEqual(calls.map(c => c.url), ['/crm/v3/objects/deals/batch/upsert']);
});

test('declined lead goes to the declined stage with its reason', () => {
  const p = dealProps(rowFor('T10'));
  assert.equal(p.dealstage, 's-d');
  assert.equal(p.aangan_qualification_status, 'DECLINED');
  assert.match(p.aangan_qualification_reason, /budget clearly below/);
});

test('mapping carries the case fields and the source', () => {
  const c = contactProps(rowFor('F05'));
  assert.equal(c.aangan_source, 'AI Front Desk');
  assert.equal(c.city, 'PCMC');
  const d = dealProps(rowFor('F05'));
  assert.equal(d.aangan_carpet_sqft, 2200);
  assert.equal(d.aangan_budget_max, 8000000);
  assert.equal(d.aangan_deadline, '2027-01-15');
  assert.equal(d.aangan_call_ids, 'call-1');
  assert.equal(d.hs_priority, 'high');
  assert.equal(d.aangan_qualification_reason, 'decision maker unclear'); // HIGH_VALUE is priority, not a reason
});

test('HIGH_VALUE is a priority signal only: it never changes the status', () => {
  for (const id of ['T01', 'F06', 'T18', 'T07']) { // qualified, review, review, declined
    const c = cases[id], at = new Date(c.at);
    const under = qualify({ ...c.lead, budget_max: 2.9e6 }, at, { final: true });
    const over = qualify({ ...c.lead, budget_max: 9e6 }, at, { final: true });
    assert.equal(over.status, under.status, id);
    assert.deepEqual(over.reasons, under.reasons, id);
    assert.ok(over.notes.includes('HIGH_VALUE') && !under.notes.includes('HIGH_VALUE'), id);
  }
});

test('failed sync is recorded, never thrown', async () => {
  stubFetch(true);
  const out = await syncCrm(rowFor('T01'));
  assert.match(out.hubspot_error, /HubSpot POST .* 500/);
});

test('missing pipeline config is a recorded error, not a silent default', async () => {
  stubFetch();
  const saved = process.env.HUBSPOT_STAGE_QUALIFIED; delete process.env.HUBSPOT_STAGE_QUALIFIED;
  const out = await syncCrm(rowFor('T01'));
  process.env.HUBSPOT_STAGE_QUALIFIED = saved;
  assert.match(out.hubspot_error, /hubspot:setup/);
});

test('Telegram routing: qualified + escalate + waiting callers only; note links HubSpot', () => {
  assert.equal(shouldNotify(rowFor('T01')), true);
  assert.equal(shouldNotify(rowFor('T09')), true);
  assert.equal(shouldNotify(rowFor('T10')), false);
  assert.equal(shouldNotify(rowFor('F06')), false);
  assert.equal(shouldNotify({ status: 'NEEDS_REVIEW', reasons: ['CALL_FAILED_CALL_BACK'], phone: '+919000000001' }), true);
  assert.equal(shouldNotify({ status: 'NEEDS_REVIEW', reasons: ['CALL_FAILED_CALL_BACK'], phone: null }), false); // no caller ID → can't call back
  const dropped = { status: 'NEEDS_REVIEW', reasons: ['UNANSWERED_PROJECT_KIND', 'UNANSWERED_CITY', 'UNANSWERED_DEADLINE'], phone: '+919000000017' };
  assert.equal(shouldNotify(dropped), true); // T17a: dropped before anything was captured
  assert.equal(shouldNotify({ ...dropped, reasons: ['UNANSWERED_DEADLINE'] }), false); // ordinary review
  const note = (extra) => formatNote({ ...rowFor('T01'), duration_sec: 60, call_started_at: '2026-09-02T10:23:00+05:30', ...extra });
  assert.match(note({ hubspot_url: 'https://app.hubspot.com/x' }), /Open in HubSpot/);
  assert.match(note({ hubspot_error: 'x' }), /CRM sync failed/);
});

test('a Calendly booking moves the deal to "Consultation booked"; a cancel moves it back', () => {
  const booked = dealProps(rowFor('T01', { consultation_status: 'booked', consultation_start: '2026-10-10T05:00:00Z', consultation_end: '2026-10-10T06:00:00Z',
    calendly_event_id: 'EV-1', calendly_invitee_id: 'INV-1', calendly_booking_url: 'https://calendly.com/x?utm_content=42' }));
  assert.equal(booked.dealstage, 's-b');
  assert.equal(booked.aangan_qualification_status, 'QUALIFIED'); // booking never rewrites the rules' status
  assert.deepEqual([booked.aangan_consultation_start, booked.aangan_calendly_invitee_id, booked.aangan_cancel_reason], ['2026-10-10T05:00:00Z', 'INV-1', '']);
  const canceled = dealProps(rowFor('T01', { consultation_status: 'canceled', calendly_cancel_reason: 'travelling' }));
  assert.equal(canceled.dealstage, 's-q');
  assert.equal(canceled.aangan_cancel_reason, 'travelling');
});
