import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise } from '../lib/summary.js';

const row = (id, status, lead, extra = {}) => ({ id, status, reasons: [], notes: [], flags: [], call_started_at: '2026-09-10T10:00:00+05:30', duration_sec: 0, cost_inr: 0, lead: { segment: 'residential', ...lead }, ...extra });

test('revenue: generated = signed deal values; pipeline = open leads valued by budget, then size, then the average; declined and lost are left out', () => {
  const rows = [
    row(1, 'QUALIFIED', { budget_min: 1e6, budget_max: 2e6 }),                       // budget midpoint: 15 lakh
    row(2, 'QUALIFIED', { carpet_sqft: 1000 }, { consultation_status: 'booked' }),    // 1,000 sq ft × ₹1,800 = 18 lakh, booked
    row(3, 'NEEDS_REVIEW', {}),                                                        // no budget, no size: ₹11 lakh average
    row(4, 'DECLINED', { budget_max: 9e6 }),                                           // not revenue
    row(5, 'QUALIFIED', { stage: 'lost', budget_max: 9e6 }),                           // lost
    row(6, 'QUALIFIED', { stage: 'converted', deal_value: 2400000 }),                  // signed: generated, not pipeline
  ];
  const r = summarise(rows, 30).revenue;
  assert.deepEqual(r.generated, { value: 2400000, count: 1 });
  assert.equal(r.pipeline.count, 3);
  assert.equal(r.pipeline.value, 1500000 + 1800000 + 1100000);
  assert.deepEqual(r.pipeline.basis, { budget: 1, size: 1, average: 1 });
  assert.equal(r.pipeline.stages.find(s => s.key === 'booked').count, 1);
  assert.equal(r.top[0].id, 2);
});
