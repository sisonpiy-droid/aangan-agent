// Weekly Telegram digest for Nikhil: the numbers he used to pull by hand, including what the tool costs.
import { humanize } from './notify.js';

const lakh = v => `₹${(v / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })}L`;
const inr = v => `₹${Number(v).toLocaleString('en-IN')}`;
const day = d => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

// s = summarise(last 7 days); prevCalls = calls in the 7 days before that.
export function digestText(s, prevCalls, { now = new Date(), dashboardUrl = null } = {}) {
  const head = `📊 <b>Aangan front desk — last 7 days</b> (${day(new Date(now.getTime() - 7 * 864e5))} – ${day(now)})`;
  if (!s.calls) return `${head}\nNo calls this week.`;
  const by = s.byStatus, n = k => by[k] ?? 0;
  const diff = s.calls - prevCalls;
  const lines = [
    head,
    `Calls answered: <b>${s.calls}</b> (${diff >= 0 ? '+' : ''}${diff} vs the week before) · ${s.afterHours} (${pct(s.afterHours, s.calls)}) outside 10am–7pm or weekends`,
    `Sent to designers: <b>${n('QUALIFIED')}</b> · Needs review: ${n('NEEDS_REVIEW')} · Declined: ${n('DECLINED')} · Escalations: ${n('ESCALATE')}`,
  ];
  const c = s.consultations;
  if (c.connected) {
    lines.push(c.tracking === 'automatic'
      ? `Consultations: <b>${c.booked}</b> booked · ${c.awaiting} link sent, not booked · ${c.canceled} canceled`
      : `Booking links ready: ${c.awaiting} (booking status is tracked by hand in HubSpot)`);
  }
  const top = Object.entries(s.declineReasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) lines.push(`Top decline reasons: ${top.map(([k, v]) => `${humanize(k)} (${v})`).join(', ')}`);
  if (s.medianHandoffSec != null) lines.push(`Call → Telegram handoff: ${s.medianHandoffSec}s (median)`);
  lines.push(s.cost.ratesSet
    ? `Cost to run: <b>${inr(s.cost.total)}</b> · ${inr(s.cost.perCall)} per call · ${s.cost.perQualified == null ? '—' : inr(s.cost.perQualified)} per qualified lead · ${s.minutes} min`
    : 'Cost to run: rates not set (VAANI_INR_PER_MIN)');
  if (n('QUALIFIED')) lines.push(`Qualified pipeline: ${lakh(s.pipelineInr[0])}–${lakh(s.pipelineInr[1])} (qualified × ₹8–14L average)`);
  const warn = [Object.keys(s.flags).length && `${Object.values(s.flags).reduce((a, b) => a + b, 0)} price/slot flag(s)`,
    s.crm.failed && `${s.crm.failed} HubSpot sync(s) failed`, c.unmatched && `${c.unmatched} unmatched booking(s)`].filter(Boolean);
  if (warn.length) lines.push(`⚠️ ${warn.join(' · ')}`);
  if (dashboardUrl) lines.push(`<a href="${dashboardUrl}">Open the dashboard</a>`);
  return lines.join('\n');
}
