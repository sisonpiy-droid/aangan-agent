// Every finished call (Vaani webhook and the simulator):
//   extract → merge redials → qualify → scan → Supabase → Calendly link → HubSpot → Telegram
// Every Calendly booking webhook:
//   match lead → Supabase → HubSpot → Telegram confirmation

import { extract } from './extract.js';
import { qualify } from './rules.js';
import { scanAgentLines } from './scan.js';
import { notify, send, formatBooking } from './notify.js';
import { syncCrm, syncActivity, hubspotUrl, e164 } from './hubspot.js';
import { bookingLink } from './calendly.js';
import { sendLink } from './deliver.js';
import { bookPreferred } from './schedule.js';
import * as store from './store.js';

export const MERGE_WINDOW_MIN = 30; // ponytail: T17 redialled after 2 min; widen if real redials come later

export function isSameEnquiry(prev, call) {
  return !!prev && prev.phone === call.fromNumber &&
    Math.abs(Date.parse(call.createdAt) - Date.parse(prev.call_started_at)) <= MERGE_WINDOW_MIN * 60e3;
}

const rate = name => Number(process.env[name] ?? 0) || 0;

// call: { id, fromNumber, createdAt, durationSec, transcript[{role,text}], collectedData, recordingUrl } (lib/vaani.js builds it)
export async function processCall(call, { extractFn = extract, event = 'call_postprocessing' } = {}) {
  if (await store.hasCall(call.id)) return null; // Vaani retried a webhook we already handled

  const prev = await store.latestForPhone(call.fromNumber);
  const merged = isSameEnquiry(prev, call);
  const transcript = merged ? [...prev.transcript, ...call.transcript] : call.transcript;
  const started = merged ? prev.call_started_at : call.createdAt;
  const duration = (merged ? prev.duration_sec : 0) + (call.durationSec ?? 0);

  let lead, result, tokens = { in: 0, out: 0 };
  if (!transcript?.length) {
    // A failed or dropped call (the caller said nothing): they still need a call back.
    lead = { name: null };
    result = { status: 'NEEDS_REVIEW', reasons: ['CALL_FAILED_CALL_BACK'], notes: [] };
  } else try {
    ({ lead, tokens } = await extractFn(transcript, started));
    if (!lead.preferred_slot && call.collectedData?.preferred_time) lead.preferred_slot = String(call.collectedData.preferred_time);
    result = qualify(lead, new Date(started), { final: true });
  } catch (err) {
    // Never lose a call: if extraction fails, a human gets the raw call.
    console.error('extract failed:', err.message);
    lead = { name: call.collectedData?.name ?? null, caller_notes: transcript.filter(t => t.role === 'CALLER').map(t => t.text).join(' ').slice(0, 400) };
    result = { status: 'NEEDS_REVIEW', reasons: ['EXTRACTION_FAILED'], notes: [] };
  }

  lead.call_summary = call.summary ?? prev?.lead?.call_summary ?? null; // Vaani's own one-paragraph summary

  const cost =
    (call.durationSec ?? 0) / 60 * rate('VAANI_INR_PER_MIN') +
    tokens.in / 1e6 * rate('LLM_INR_PER_MTOK_IN') + tokens.out / 1e6 * rate('LLM_INR_PER_MTOK_OUT');

  const row = {
    call_ids: [...(merged ? prev.call_ids : []), call.id],
    phone: call.fromNumber ?? null,
    call_started_at: started,
    duration_sec: duration,
    transcript,
    lead,
    status: result.status,
    reasons: result.reasons,
    notes: result.notes,
    flags: scanAgentLines(transcript),
    cost_inr: Math.round(((merged ? Number(prev.cost_inr) : 0) + cost) * 100) / 100,
    llm_tokens_in: (merged ? prev.llm_tokens_in ?? 0 : 0) + tokens.in,
    llm_tokens_out: (merged ? prev.llm_tokens_out ?? 0 : 0) + tokens.out,
    recording_url: call.recordingUrl ?? null,
  };
  let saved = await store.save(row, merged ? prev.id : undefined); // system of record first
  await store.logEvent('vaani', event, { externalId: call.id, leadId: saved.id, payload: call });
  await store.logEvent('rules', 'decided', { leadId: saved.id, payload: { status: result.status, reasons: result.reasons, notes: result.notes, merged } });

  // Calendly link for anyone a designer may book (the link needs the lead id, so it comes after the first save).
  if (['QUALIFIED', 'NEEDS_REVIEW'].includes(saved.status) && !saved.consultation_status) {
    const url = bookingLink(saved);
    if (url) saved = await store.save({ calendly_booking_url: url, consultation_status: 'link_ready' }, saved.id);
  }
  // Qualified callers who gave an email and a preferred time get that time booked (closest free slot). The booking comes back
  // through Calendly's webhook too, which is what updates HubSpot and tells the designers.
  if (saved.status === 'QUALIFIED' && saved.calendly_booking_url && !['booked', 'rescheduled'].includes(saved.consultation_status)) {
    try {
      const b = await bookPreferred(saved);
      if (b) {
        saved = await store.save({ consultation_status: 'booked', consultation_start: b.start, consultation_end: b.end, calendly_event_id: b.eventId, calendly_invitee_id: b.inviteeId, lead: { ...saved.lead, booking: b } }, saved.id);
        await store.logEvent('schedule', 'booked', { externalId: String(saved.id), leadId: saved.id, payload: b });
      }
    } catch (err) {
      console.error('booking the preferred time failed', err.message);
      saved = await store.save({ lead: { ...saved.lead, booking_error: err.message } }, saved.id);
    }
  }
  // Qualified callers get the link by SMS and email at once; the result shows on the lead and in the Telegram note.
  if (saved.status === 'QUALIFIED' && saved.calendly_booking_url) {
    const link_delivery = await sendLink(saved);
    if (link_delivery) saved = await store.save({ lead: { ...saved.lead, link_delivery } }, saved.id);
  }
  return { ...(await syncAndNotify(saved, { merged })), merged };
}

// HubSpot first (so Telegram can link the record), then Telegram. Also used by /api/retry-sync.
// A failed CRM sync does not hold back Telegram: speed matters more than the link.
export async function syncCrmAndSave(row) {
  const crm = await syncCrm(row);
  if (!Object.keys(crm).length) return row;
  if (!crm.hubspot_error) {
    // Note + Call + Task on the record, each created once (the events table remembers what exists).
    const done = new Set((await store.eventsForLead(row.id, 'hubspot')).filter(e => e.type === 'activity').map(e => e.external_id));
    const act = await syncActivity({ ...row, ...crm }, done);
    for (const c of act.created) await store.logEvent('hubspot', 'activity', { externalId: c.key, leadId: row.id, payload: { hubspotId: c.id } });
    if (act.errors.length) crm.hubspot_error = `activity: ${act.errors.join(' | ')}`.slice(0, 500);
  }
  if (crm.hubspot_error) await store.logEvent('hubspot', 'sync_failed', { leadId: row.id, payload: { error: crm.hubspot_error } });
  return store.save({ ...crm, ...(crm.hubspot_synced_at ? { hubspot_url: hubspotUrl(crm) } : {}) }, row.id);
}

export async function syncAndNotify(row, { merged = false, renotify = true } = {}) {
  let saved = await syncCrmAndSave(row);
  const sent = renotify ? await notify({ ...saved, merged }) : null;
  if (sent) {
    saved = await store.save({ notified_at: new Date().toISOString() }, saved.id);
    await store.logEvent('telegram', 'sent', { externalId: `${sent.chat}:${sent.messageId}`, leadId: saved.id, payload: { kind: 'handoff', to: sent.chat, status: saved.status } });
  }
  return saved;
}

// b = parseWebhook(body). Returns the updated lead, or null when the booking matches no lead.
export async function applyBooking(b) {
  let lead = b.leadId ? await store.findLead({ id: b.leadId }) : null;
  lead ??= await store.findLead({ calendly_invitee_id: b.oldInviteeId ?? b.inviteeId });
  if (!lead && b.phone) lead = await store.findLead({ phone: e164(b.phone) });

  if (!lead) {
    if (b.kind === 'booked') {
      const sent = await send('designers', formatBooking(null, b));
      await store.logEvent('calendly', 'unmatched', { externalId: b.inviteeUri, payload: b });
      if (sent) await store.logEvent('telegram', 'sent', { externalId: `${sent.chat}:${sent.messageId}`, payload: { kind: 'booking_unmatched' } });
    }
    return null;
  }
  // The cancel half of a reschedule: the invitee.created that follows carries the new time.
  if (b.kind === 'reschedule_pending') return lead;
  // A cancel for an invitee that is no longer the current booking changes nothing.
  if (b.kind === 'canceled' && lead.calendly_invitee_id && lead.calendly_invitee_id !== b.inviteeId) return lead;

  const update = b.kind === 'canceled'
    ? { consultation_status: 'canceled', calendly_cancel_reason: b.cancelReason }
    : { consultation_status: b.kind, consultation_start: b.start, consultation_end: b.end,
        calendly_event_id: b.eventId, calendly_invitee_id: b.inviteeId, calendly_cancel_reason: null };
  let saved = await store.save(update, lead.id);
  saved = await syncCrmAndSave(saved);
  const sent = await send('designers', formatBooking(saved, b));
  if (sent) await store.logEvent('telegram', 'sent', { externalId: `${sent.chat}:${sent.messageId}`, leadId: saved.id, payload: { kind: `booking_${b.kind}` } });
  return saved;
}
