import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { qualify, CLOSINGS, QUESTIONS, PRICING_DEFLECTION } from '../lib/rules.js';
import { scanAgentLines } from '../lib/scan.js';
import { isSameEnquiry } from '../lib/pipeline.js';

const cases = JSON.parse(readFileSync(new URL('./leads.json', import.meta.url)));
const byId = Object.fromEntries(cases.map(c => [c.id, c]));

for (const c of cases) {
  test(`${c.id} → ${c.expect.status}`, () => {
    const r = qualify(c.lead, new Date(c.at), { final: true });
    assert.equal(r.status, c.expect.status);
    assert.deepEqual(r.reasons, c.expect.reasons);
    if (c.expect.notes) assert.deepEqual(r.notes, c.expect.notes);
  });
}

const base = byId.T01.lead, now = new Date(byId.T01.at);

test('T07 closing offers a later start', () => {
  assert.match(qualify(byId.T07.lead, new Date(byId.T07.at)).say, /later finish/);
});

test('T09 escalation skips qualification entirely', () => {
  const r = qualify({ ...byId.T09.lead, city: 'other' }, new Date(byId.T09.at));
  assert.equal(r.status, 'ESCALATE');
});

test('T11 without a timeline: live asks the one rubric question, final goes to review', () => {
  const lead = { ...byId.T11.lead, deadline_date: null }, at = new Date(byId.T11.at);
  const live = qualify(lead, at);
  assert.equal(live.status, 'NEEDS_INFO');
  assert.equal(live.say, 'When would you need the project complete?');
  assert.deepEqual(qualify(lead, at, { final: true }).reasons, ['UNANSWERED_DEADLINE']);
});

test('unknown city → NEEDS_INFO asking the area, never declined', () => {
  const r = qualify({ ...base, city: null, locality: null }, now);
  assert.equal(r.status, 'NEEDS_INFO');
  assert.equal(r.ask, 'city');
  assert.equal(qualify({ ...base, city: null, locality: null }, now, { final: true }).status, 'NEEDS_REVIEW');
});

test('hard disqualifier beats unknown fields (T04 has no city, still declined)', () => {
  assert.equal(qualify(byId.T04.lead, new Date(byId.T04.at)).status, 'DECLINED');
});

test('"research for in-laws" alone is one soft failure → review, not decline', () => {
  const r = qualify({ ...base, decision_maker: 'no' }, now);
  assert.equal(r.status, 'NEEDS_REVIEW');
  assert.deepEqual(r.reasons, ['NOT_DECISION_MAKER']);
});

test('two soft failures → DECLINED with the rubric line', () => {
  const r = qualify({ ...base, decision_maker: 'no', site_available_date: '2027-06-01' }, now);
  assert.equal(r.status, 'DECLINED');
  assert.equal(r.say, CLOSINGS.NOT_RIGHT_FIT);
});

test('T18-style commercial under 500 sq ft is never auto-declined', () => {
  for (const sqft of [50, 180, 499]) assert.notEqual(qualify({ ...byId.T18.lead, carpet_sqft: sqft }, now).status, 'DECLINED');
});

test('budget between 50% and 100% of the estimate passes with a note', () => {
  const r = qualify({ ...base, budget_max: 2000000 }, now); // vs 25.2L estimate
  assert.equal(r.status, 'QUALIFIED');
  assert.ok(r.notes.includes('BUDGET_MAY_BE_TIGHT'));
});

test('caller-facing text never contains a price', () => {
  const lines = [...Object.values(CLOSINGS), ...Object.values(QUESTIONS), PRICING_DEFLECTION];
  assert.deepEqual(scanAgentLines(lines.map(text => ({ role: 'AGENT', text }))), []);
  for (const c of cases) {
    const say = qualify(c.lead, new Date(c.at)).say ?? '';
    assert.doesNotMatch(say, /\d/, `${c.id} say contains a digit`);
  }
});

test('price scanner: catches agent prices, ignores areas and the caller', () => {
  const t = (role, text) => [{ role, text }];
  assert.deepEqual(scanAgentLines(t('AGENT', 'It would be around 18 lakh for that.')), ['PRICING_LEAK']);
  assert.deepEqual(scanAgentLines(t('AGENT', 'Our rates start at a reasonable level.')), ['PRICING_LEAK']);
  assert.deepEqual(scanAgentLines(t('AGENT', 'Roughly ₹2,000 per sq ft.')), ['PRICING_LEAK']);
  assert.deepEqual(scanAgentLines(t('AGENT', 'So that is about 1,400 sq ft carpet — lovely.')), []);
  assert.deepEqual(scanAgentLines(t('CALLER', 'My budget is 1 to 1.5 lakh.')), []);
});

test('slot scanner: catches a promised slot, allows "designer will confirm"', () => {
  assert.deepEqual(scanAgentLines([{ role: 'AGENT', text: "Great, I've booked you for Saturday at 10." }]), ['SLOT_PROMISED']);
  assert.deepEqual(scanAgentLines([{ role: 'AGENT', text: CLOSINGS.BOOK }]), []);
});

test('T17: redial from the same number within 30 min is the same enquiry', () => {
  const prev = { phone: '+919000000017', call_started_at: '2026-09-22T14:14:00+05:30' };
  assert.equal(isSameEnquiry(prev, { fromNumber: '+919000000017', createdAt: '2026-09-22T14:16:00+05:30' }), true);
  assert.equal(isSameEnquiry(prev, { fromNumber: '+919000000017', createdAt: '2026-09-22T15:30:00+05:30' }), false);
  assert.equal(isSameEnquiry(prev, { fromNumber: '+919000000099', createdAt: '2026-09-22T14:16:00+05:30' }), false);
});
