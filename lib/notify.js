import { calendlyWebhooksEnabled } from './calendly.js';
// Telegram = human handoff. Sent after the HubSpot sync so notes can link the record.
//   QUALIFIED → designers · ESCALATE → Nikhil · failed/dropped call WITH caller ID → designers (call back)
//   NEEDS_REVIEW, DECLINED → no Telegram (HubSpot + dashboard)
//   Calendly booked / rescheduled / canceled / unmatched → designers
const CALL_BACK = ['CALL_FAILED_CALL_BACK', 'PIPELINE_FAILED', 'EXTRACTION_FAILED'];
const NOTHING_CAPTURED = ['UNANSWERED_PROJECT_KIND', 'UNANSWERED_CITY', 'UNANSWERED_DEADLINE'];
export const isCallBack = row => row.status === 'NEEDS_REVIEW' && !!row.phone &&
  (row.reasons?.some(r => CALL_BACK.includes(r)) || NOTHING_CAPTURED.every(r => row.reasons?.includes(r)));
export const shouldNotify = row => row.status === 'QUALIFIED' || row.status === 'ESCALATE' || isCallBack(row);

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const humanize = code => code.replace(/^UNANSWERED_/, 'not answered: ').replace(/_/g, ' ').toLowerCase();
const fmtDate = d => (d === 'none' ? 'no fixed deadline' : d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtIst = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

// Vaani can't text callers, so the designer sends the Calendly link from their own WhatsApp in one tap.
export function whatsappLink(row) {
  if (!row.phone || !row.calendly_booking_url) return null;
  const hi = row.lead?.name ? `Hi ${row.lead.name.split(' ')[0]}` : 'Hi';
  const text = `${hi}, this is Aangan Studio — thank you for calling us. Please pick a consultation time that suits you here: ${row.calendly_booking_url}`;
  return `https://wa.me/${row.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

export function formatNote(row) {
  const l = row.lead ?? {};
  const place = [l.locality, l.city?.toUpperCase()].filter(Boolean).join(', ') || '—';
  const mins = `${Math.floor(row.duration_sec / 60)}m ${row.duration_sec % 60}s`;
  const head = isCallBack(row) ? '📞 <b>CALL BACK</b> — call dropped or failed before anything was captured'
    : `${{ QUALIFIED: '🟢', ESCALATE: '🚨' }[row.status] ?? '🟡'} <b>${row.status.replace('_', ' ')}</b>`;
  const lines = [
    `${head}${row.notes?.includes('HIGH_VALUE') ? '  ⭐ high value' : ''}${row.merged ? '  (updated: caller redialled)' : ''}`,
    `<b>${esc(l.name ?? 'Name not given')}</b> · <a href="tel:${esc(row.phone)}">${esc(row.phone ?? 'no caller ID')}</a>`,
  ];
  if (row.status === 'ESCALATE') {
    lines.push(`Existing client. ${esc(l.caller_notes ?? '')}`, 'Call back from a senior person as soon as possible.');
  } else if (!isCallBack(row)) {
    lines.push(
      `${esc(l.segment ?? '—')}${l.property_type ? ` · ${esc(l.property_type.replace('_', ' '))}` : ''}${l.business_type ? ` (${esc(l.business_type)})` : ''} · ${esc(place)}${l.carpet_sqft ? ` · ${l.carpet_sqft.toLocaleString('en-IN')} sq ft` : ''}${l.rented ? ' · rented' : ''}`,
      `Scope: ${esc(l.rooms_in_scope?.join(', ') || '—')}`,
      `Complete by: ${fmtDate(l.deadline_date)}${l.site_available_date ? ` · site from ${fmtDate(l.site_available_date)}` : ''}`,
      `Decision-maker: ${esc(l.decision_maker ?? 'not confirmed')}`,
      `Caller's preferred time: ${esc(l.preferred_slot ?? 'not given')} (nothing was booked on the call)`,
    );
    if (l.referral) lines.push(`Referral: ${esc(l.referral)}`);
    if (l.caller_notes) lines.push(`Notes: ${esc(l.caller_notes)}`);
    const wa = whatsappLink(row);
    if (wa) lines.push(`📅 <a href="${esc(wa)}"><b>Send booking link on WhatsApp</b></a> · <a href="${esc(row.calendly_booking_url)}">Calendly link</a>`);
    if (row.calendly_booking_url && !calendlyWebhooksEnabled()) lines.push('Booking status is not tracked automatically: update the HubSpot deal once they book.');
    else if (row.status === 'QUALIFIED') lines.push(row.calendly_booking_url ? `📅 Booking link: ${esc(row.calendly_booking_url)}` : '📅 Calendly not configured — book by phone');
  }
  if (row.reasons?.length && !isCallBack(row)) lines.push(`Needs a human: ${row.reasons.map(humanize).join('; ')}`);
  const notes = row.notes?.filter(n => n !== 'HIGH_VALUE') ?? [];
  if (notes.length) lines.push(`Heads-up: ${notes.map(humanize).join('; ')}`);
  if (row.flags?.length) lines.push(`⚠️ Agent check: ${row.flags.map(humanize).join('; ')}`);
  if (row.hubspot_url) lines.push(`<a href="${esc(row.hubspot_url)}">Open in HubSpot</a>`);
  else if (row.hubspot_error) lines.push('⚠️ CRM sync failed — retry from the dashboard');
  lines.push(`Call: ${mins} · ${fmtIst(row.call_started_at)}${row.recording_url ? ` · <a href="${esc(row.recording_url)}">recording</a>` : ''}`);
  return lines.join('\n');
}

export function formatBooking(row, b) {
  if (!row) {
    return [`📅 <b>Calendly booking not linked to any call</b>`, `${esc(b.name ?? '')} ${esc(b.email ?? '')} ${esc(b.phone ?? '')}`.trim(),
      b.start ? `When: ${fmtIst(b.start)}` : null, 'Check Calendly and link it to the right lead by hand.'].filter(Boolean).join('\n');
  }
  const l = row.lead ?? {};
  const head = { booked: '✅ <b>Consultation booked</b>', rescheduled: '🔁 <b>Consultation rescheduled</b>', canceled: '❌ <b>Consultation canceled</b>' }[b.kind];
  return [
    head,
    `<b>${esc(l.name ?? b.name ?? 'Caller')}</b> · <a href="tel:${esc(row.phone)}">${esc(row.phone ?? 'no caller ID')}</a> · ${esc(l.locality ?? '')}`,
    b.kind === 'canceled' ? `Reason: ${esc(b.cancelReason ?? 'not given')}` : `When: <b>${fmtIst(b.start)}</b> (IST)`,
    row.hubspot_url ? `<a href="${esc(row.hubspot_url)}">Open in HubSpot</a>` : row.hubspot_error ? '⚠️ CRM sync failed — retry from the dashboard' : null,
  ].filter(Boolean).join('\n');
}

// Returns { chat, messageId } when sent, null when skipped or not configured.
export async function send(to, text) {
  const chat = to === 'nikhil' ? process.env.TELEGRAM_NIKHIL_CHAT_ID : process.env.TELEGRAM_DESIGNERS_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chat) {
    if (!process.env.QUIET) console.log(`\n--- Telegram (not configured, would send to ${to}) ---\n${text}\n`);
    return null;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { chat: to, messageId: (await res.json()).result?.message_id ?? null };
}

export const notify = row => (shouldNotify(row) ? send(row.status === 'ESCALATE' ? 'nikhil' : 'designers', formatNote(row)) : null);
