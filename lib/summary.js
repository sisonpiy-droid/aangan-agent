// Numbers for the dashboard and the weekly digest, from lead rows.
import { calendlyConfigured, calendlyWebhooksEnabled } from './calendly.js';
import { hubspotUrl, hubspotConfigured } from './hubspot.js';
import { nextTask, dueAt } from './tasks.js';

export const AVG_PROJECT_INR = [8e5, 14e5]; // brief: average project value ₹8–14 lakh
const istParts = iso => {
  const d = new Date(new Date(iso).getTime() + 5.5 * 36e5); // IST has no DST
  return { hour: d.getUTCHours(), day: d.getUTCDay(), date: d.toISOString().slice(0, 10) };
};
// Front desk covers 10am–7pm on working days (case brief + W05 "closed over the weekend").
export const isAfterHours = iso => { const { hour, day } = istParts(iso); return day === 0 || day === 6 || hour < 10 || hour >= 19; };
const count = arr => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const maskPhone = p => (p ? p.slice(0, 3) + '•••••' + p.slice(-4) : null);

// What a human should do next, and by when. A lead may carry its own dated task (the imported September history does);
// otherwise it is the rules' default, due from the time of the enquiry.
function work(r) {
  const t = r.lead?.todo;
  if (t?.none || r.lead?.stage === 'lost') return { task: null, next: null, due: null };
  const base = nextTask(r);
  const line = t?.line ?? base?.line ?? null;
  const dueMin = t?.dueMin ?? base?.dueMin;
  return { task: t?.key ?? base?.key ?? null, next: line, due: t?.due ?? (line && dueMin != null ? dueAt({ dueMin }, new Date(r.call_started_at)) : null) };
}

// Minutes to the first human reply. Live AI calls are answered at once; undefined = not recorded (web forms), null = never answered.
const replyMin = r => (r.lead?.channel ? r.lead.first_reply_min : 0);
function responseTimes(rows) {
  const known = rows.map(replyMin).filter(m => typeof m === 'number').sort((a, b) => a - b);
  const waited = known.filter(m => m > 0);
  return {
    within1h: known.filter(m => m <= 60).length, later: known.filter(m => m > 60 && m <= 2880).length, over2d: known.filter(m => m > 2880).length,
    never: rows.filter(r => replyMin(r) === null).length, notRecorded: rows.filter(r => replyMin(r) === undefined).length,
    // of those not answered at once (live calls would drag the median to zero)
    medianMin: waited.length ? waited[waited.length >> 1] : null,
  };
}

export function summarise(rows, days, { unmatchedBookings = 0 } = {}) {
  const qualified = rows.filter(r => r.status === 'QUALIFIED').length;
  const cost = rows.reduce((s, r) => s + Number(r.cost_inr || 0), 0);
  const handoffs = rows.filter(r => r.notified_at)
    .map(r => (Date.parse(r.notified_at) - Date.parse(r.call_started_at)) / 1000 - (r.duration_sec ?? 0));
  return {
    days,
    calls: rows.length,
    afterHours: rows.filter(r => isAfterHours(r.call_started_at)).length,
    minutes: Math.round(rows.reduce((s, r) => s + (r.duration_sec ?? 0), 0) / 60),
    byStatus: count(rows.map(r => r.status)),
    declineReasons: count(rows.filter(r => r.status === 'DECLINED').flatMap(r => r.reasons ?? [])),
    reviewReasons: count(rows.filter(r => r.status === 'NEEDS_REVIEW').flatMap(r => r.reasons ?? [])),
    flags: count(rows.flatMap(r => r.flags ?? [])),
    medianHandoffSec: handoffs.length ? Math.round(handoffs.sort((a, b) => a - b)[handoffs.length >> 1]) : null,
    cost: { total: Math.round(cost), perCall: rows.length ? +(cost / rows.length).toFixed(2) : 0, perQualified: qualified ? Math.round(cost / qualified) : null,
      ratesSet: Number(process.env.VAANI_INR_PER_MIN) > 0 },
    pipelineInr: AVG_PROJECT_INR.map(v => v * qualified),
    consultations: {
      connected: calendlyConfigured(),
      tracking: calendlyWebhooksEnabled() ? 'automatic' : 'manual',
      booked: rows.filter(r => ['booked', 'rescheduled'].includes(r.consultation_status)).length,
      canceled: rows.filter(r => r.consultation_status === 'canceled').length,
      awaiting: rows.filter(r => r.consultation_status === 'link_ready').length,
      unmatched: unmatchedBookings,
    },
    crm: { connected: hubspotConfigured(), synced: rows.filter(r => r.hubspot_synced_at && !r.hubspot_error).length, failed: rows.filter(r => r.hubspot_error).length },
    byDay: count(rows.map(r => istParts(r.call_started_at).date)),
    channels: count(rows.map(r => r.lead?.channel ?? 'phone')),
    response: responseTimes(rows),
    recent: rows.slice(0, 100).map(r => ({
      id: r.id,
      at: r.call_started_at, name: r.lead?.name ?? null, phone: maskPhone(r.phone), locality: r.lead?.locality ?? null,
      summary: r.lead?.call_summary ?? null, ...work(r), channel: r.lead?.channel ?? 'phone', ref: r.lead?.enquiry_ref ?? null, progress: r.lead?.progress ?? null, stage: r.lead?.stage ?? null,
      status: r.status, reasons: r.reasons, crm: r.hubspot_error ? 'failed' : r.hubspot_synced_at ? 'synced' : null, crmError: r.hubspot_error ?? null,
      crmUrl: r.hubspot_url ?? hubspotUrl(r), consultation: r.consultation_status ?? null, consultationStart: r.consultation_start ?? null,
      notes: r.notes, flags: r.flags, cost: Number(r.cost_inr || 0), mins: Math.round((r.duration_sec ?? 0) / 6) / 10,
    })),
  };
}
