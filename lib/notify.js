// Telegram = human handoff. Sent after the HubSpot sync so notes can link the record.
//   QUALIFIED → designers · ESCALATE → Nikhil · failed/dropped call WITH caller ID → designers (call back)
//   NEEDS_REVIEW, DECLINED → no Telegram (HubSpot + dashboard)
//   Calendly booked / rescheduled / canceled / unmatched → designers
//   Every handoff note carries a "Next task" line and the full transcript as an attached .txt file.
import { calendlyWebhooksEnabled } from './calendly.js';
import { nextTask, isCallBack } from './tasks.js';

export { isCallBack };
export const shouldNotify = row => row.status === 'QUALIFIED' || row.status === 'ESCALATE' || isCallBack(row);

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const humanize = code => code.replace(/^UNANSWERED_/, 'not answered: ').replace(/_/g, ' ').toLowerCase();
const fmtDate = d => (d === 'none' ? 'no fixed deadline' : d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtIst = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The lead's page on our dashboard (passcode-protected): summary, transcript, timeline.
export function dashboardUrl(row) {
  const base = process.env.PUBLIC_BASE_URL;
  return base && row.id != null ? `${base.replace(/\/$/, '')}/?lead=${row.id}` : null;
}

export function transcriptText(row) {
  const mins = `${Math.floor(row.duration_sec / 60)}m ${row.duration_sec % 60}s`;
  return [
    'Aangan Studio — call transcript',
    `Caller: ${row.lead?.name ?? 'not given'} · ${row.phone ?? 'no caller ID'}`,
    `When: ${fmtIst(row.call_started_at)} IST · ${mins}`,
    `Status: ${row.status}`,
    '',
    ...(row.transcript ?? []).map(t => `${t.role === 'AGENT' ? 'AGENT ' : 'CALLER'}: ${t.text}`),
  ].join('\n');
}

// Vaani can't text callers, so the designer sends the Calendly link from their own phone in one tap.
export function whatsappLink(row) {
  if (!row.phone || !row.calendly_booking_url) return null;
  const hi = row.lead?.name ? `Hi ${row.lead.name.split(' ')[0]}` : 'Hi';
  const text = `${hi}, this is Aangan Studio — thank you for calling us. Please pick a consultation time that suits you here: ${row.calendly_booking_url}`;
  return `https://wa.me/${row.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

// Same idea by email, when the caller gave an address.
export function emailLink(row) {
  const to = row.lead?.email;
  if (!to || !row.calendly_booking_url) return null;
  const hi = row.lead?.name ? `Hi ${row.lead.name.split(' ')[0]}` : 'Hi';
  const body = `${hi},\n\nThank you for calling Aangan Studio. Please choose a consultation time that suits you here:\n${row.calendly_booking_url}\n\nRegards,\nAangan Studio`;
  return `mailto:${to}?subject=${encodeURIComponent('Your Aangan Studio design consultation')}&body=${encodeURIComponent(body)}`;
}

export function formatNote(row) {
  const l = row.lead ?? {};
  const place = [l.locality, l.city?.toUpperCase()].filter(Boolean).join(', ') || '—';
  const mins = `${Math.floor(row.duration_sec / 60)}m ${row.duration_sec % 60}s`;
  const head = isCallBack(row) ? '📞 <b>CALL BACK</b> — call dropped or failed before anything was captured'
    : `${{ QUALIFIED: '🟢', ESCALATE: '🚨' }[row.status] ?? '🟡'} <b>${row.status.replace('_', ' ')}</b>`;
  const task = nextTask(row);
  const lines = [
    `${head}${row.notes?.includes('HIGH_VALUE') ? '  ⭐ high value' : ''}${row.merged ? '  (updated: caller redialled)' : ''}`,
    `<b>${esc(l.name ?? 'Name not given')}</b> · <a href="tel:${esc(row.phone)}">${esc(row.phone ?? 'no caller ID')}</a>`,
  ];
  if (task?.line) lines.push(`🎯 <b>Next task:</b> ${esc(task.line)}`);
  if (l.call_summary) lines.push(`Summary: ${esc(clip(l.call_summary, 350))}`);
  if (row.status === 'ESCALATE') {
    lines.push(`Existing client. ${esc(l.caller_notes ?? '')}`);
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
    const wa = whatsappLink(row), mail = emailLink(row);
    if (wa) lines.push(`📅 <a href="${esc(wa)}"><b>Send booking link on WhatsApp</b></a>${mail ? ` · <a href="${esc(mail)}">Email it</a>` : ''} · <a href="${esc(row.calendly_booking_url)}">Calendly link</a>`);
    if (row.calendly_booking_url && !calendlyWebhooksEnabled()) lines.push('Booking status is not tracked automatically: update the HubSpot deal once they book.');
    else if (row.status === 'QUALIFIED') lines.push(row.calendly_booking_url ? `📅 Booking link: ${esc(row.calendly_booking_url)}` : '📅 Calendly not configured — book by phone');
  }
  if (row.reasons?.length && !isCallBack(row)) lines.push(`Needs a human: ${row.reasons.map(humanize).join('; ')}`);
  const notes = row.notes?.filter(n => n !== 'HIGH_VALUE') ?? [];
  if (notes.length) lines.push(`Heads-up: ${notes.map(humanize).join('; ')}`);
  if (row.flags?.length) lines.push(`⚠️ Agent check: ${row.flags.map(humanize).join('; ')}`);
  const links = [row.hubspot_url && `<a href="${esc(row.hubspot_url)}">Open in HubSpot</a>`, dashboardUrl(row) && `<a href="${esc(dashboardUrl(row))}">Lead page</a>`].filter(Boolean);
  if (links.length) lines.push(links.join(' · '));
  if (!row.hubspot_url && row.hubspot_error) lines.push('⚠️ CRM sync failed — retry from the dashboard');
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

const CHAT = { nikhil: () => process.env.TELEGRAM_NIKHIL_CHAT_ID, designers: () => process.env.TELEGRAM_DESIGNERS_CHAT_ID };
const API = m => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${m}`;
const plain = t => t.replace(/<a href="([^"]*)">(.*?)<\/a>/g, (_, url, label) => `${label.replace(/<[^>]+>/g, '')} (${url})`).replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Returns { chat, messageId } when sent, null when skipped or not configured.
export async function send(to, text) {
  const chat = CHAT[to]?.();
  if (!process.env.TELEGRAM_BOT_TOKEN || !chat) {
    if (!process.env.QUIET) console.log(`\n--- Telegram (not configured, would send to ${to}) ---\n${text}\n`);
    return null;
  }
  const post = body => fetch(API('sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, disable_web_page_preview: true, ...body }) });
  let res = await post({ text, parse_mode: 'HTML' });
  // A link Telegram can't parse must never cost us the handoff: resend as plain text.
  if (res.status === 400 && /parse|entit/i.test(await res.clone().text())) res = await post({ text: plain(text) });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { chat: to, messageId: (await res.json()).result?.message_id ?? null };
}

export async function sendDocument(to, filename, text, { caption, replyTo } = {}) {
  const chat = CHAT[to]?.();
  if (!process.env.TELEGRAM_BOT_TOKEN || !chat) return null;
  const form = new FormData();
  form.set('chat_id', chat);
  if (caption) form.set('caption', caption);
  if (replyTo) form.set('reply_to_message_id', String(replyTo));
  form.set('document', new Blob([text], { type: 'text/plain' }), filename);
  const res = await fetch(API('sendDocument'), { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Telegram sendDocument ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

export async function notify(row) {
  if (!shouldNotify(row)) return null;
  const to = row.status === 'ESCALATE' ? 'nikhil' : 'designers';
  const sent = await send(to, formatNote(row));
  // The full transcript rides along as a file (Telegram caps a message at 4,096 characters).
  if (sent && row.transcript?.length) {
    await sendDocument(to, `aangan-call-${row.id}.txt`, transcriptText(row), { caption: 'Full call transcript', replyTo: sent.messageId })
      .catch(err => console.error('transcript attach failed:', err.message));
  }
  return sent;
}
