// Dashboard data. Passcode in a header (never the URL): it returns caller names and numbers.
import { secretOk } from '../lib/auth.js';
import { leadsSince, countEvents } from '../lib/store.js';
import { calendlyConfigured, calendlyWebhooksEnabled } from '../lib/calendly.js';
import { hubspotUrl, hubspotConfigured } from '../lib/hubspot.js';

const AVG_PROJECT_INR = [8e5, 14e5]; // brief: average project value ₹8–14 lakh
const istParts = iso => {
  const d = new Date(new Date(iso).getTime() + 5.5 * 36e5); // IST has no DST
  return { hour: d.getUTCHours(), day: d.getUTCDay(), date: d.toISOString().slice(0, 10) };
};
// Front desk covers 10am–7pm on working days (case brief + W05 "closed over the weekend").
export const isAfterHours = iso => { const { hour, day } = istParts(iso); return day === 0 || day === 6 || hour < 10 || hour >= 19; };
const count = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const maskPhone = p => (p ? p.slice(0, 3) + '•••••' + p.slice(-4) : null);

export function summarise(rows, days, { unmatchedBookings = 0 } = {}) {
  const qualified = rows.filter(r => r.status === 'QUALIFIED').length;
  const cost = rows.reduce((s, r) => s + Number(r.cost_inr || 0), 0);
  const handoffs = rows.filter(r => r.notified_at)
    .map(r => (Date.parse(r.notified_at) - Date.parse(r.call_started_at)) / 1000 - (r.duration_sec ?? 0));
  const byDay = count(rows.map(r => istParts(r.call_started_at).date));
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
    byDay,
    recent: rows.slice(0, 50).map(r => ({
      at: r.call_started_at, name: r.lead?.name ?? null, phone: maskPhone(r.phone), locality: r.lead?.locality ?? null,
      status: r.status, reasons: r.reasons, crm: r.hubspot_error ? 'failed' : r.hubspot_synced_at ? 'synced' : null, crmError: r.hubspot_error ?? null, crmUrl: r.hubspot_url ?? hubspotUrl(r), consultation: r.consultation_status ?? null, consultationStart: r.consultation_start ?? null, notes: r.notes, flags: r.flags, cost: Number(r.cost_inr || 0), mins: Math.round((r.duration_sec ?? 0) / 6) / 10,
    })),
  };
}

export async function GET(request) {
  if (!secretOk(request.headers.get('x-passcode'), process.env.DASHBOARD_PASSCODE)) return new Response('unauthorised', { status: 401 });
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get('days')) || 30, 1), 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [rows, unmatchedBookings] = await Promise.all([leadsSince(since), countEvents('unmatched', since)]);
  return Response.json(summarise(rows, days, { unmatchedBookings }), { headers: { 'cache-control': 'no-store' } });
}
