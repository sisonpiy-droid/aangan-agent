// HubSpot = CRM / sales pipeline. One-way sync from Supabase; no qualification logic here.
// Auth: a HubSpot service key (HUBSPOT_SERVICE_KEY), sent as a Bearer token.
// Idempotent by design: contacts upsert on aangan_phone_e164, deals upsert on aangan_lead_id
// (both unique custom properties created by scripts/hubspot-setup.mjs).
import { humanize } from './notify.js';
import { calendlyWebhooksEnabled } from './calendly.js';

const BASE = 'https://api.hubapi.com';
export const hubspotConfigured = () => !!process.env.HUBSPOT_SERVICE_KEY;

async function hs(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${process.env.HUBSPOT_SERVICE_KEY}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

// ponytail: India-only normalisation (10 digits → +91); widen if Aangan ever gets foreign callers.
export function e164(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.length > 8 ? d : null;
  if (/^\d{10}$/.test(d)) return `+91${d}`;
  if (/^91\d{10}$/.test(d)) return `+${d}`;
  if (/^0\d{10}$/.test(d)) return `+91${d.slice(1)}`;
  return null;
}

const CITY = { pune: 'Pune', pcmc: 'PCMC', other: 'Outside service area' };
const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)); // '' is kept on purpose: it clears stale values

export function contactProps(row) {
  const l = row.lead ?? {};
  const [first, ...rest] = (l.name ?? '').trim().split(/\s+/);
  return drop({
    aangan_phone_e164: e164(row.phone),
    phone: e164(row.phone),
    email: l.email,
    firstname: first || null,
    lastname: rest.join(' ') || null,
    city: CITY[l.city],
    aangan_locality: l.locality,
    aangan_source: 'AI Front Desk',
    aangan_last_status: row.status,
    // Manual booking mode: never overwrite what a designer typed into HubSpot.
    aangan_consultation_status: calendlyWebhooksEnabled() ? row.consultation_status ?? 'none' : null,
  });
}

const STAGE_ENV = { QUALIFIED: 'HUBSPOT_STAGE_QUALIFIED', NEEDS_REVIEW: 'HUBSPOT_STAGE_REVIEW', DECLINED: 'HUBSPOT_STAGE_DECLINED', BOOKED: 'HUBSPOT_STAGE_BOOKED' };
const isBooked = row => row.consultation_status === 'booked' || row.consultation_status === 'rescheduled';
const words = s => s?.replace(/_/g, ' ');

export function dealProps(row) {
  const l = row.lead ?? {};
  const stageKey = isBooked(row) ? 'BOOKED' : row.status;
  const dealstage = process.env[STAGE_ENV[stageKey]];
  if (!process.env.HUBSPOT_PIPELINE_ID || !dealstage) throw new Error(`HubSpot pipeline/stage for ${stageKey} not set — run npm run hubspot:setup`);
  const notes = (row.notes ?? []).filter(n => n !== 'HIGH_VALUE');
  return drop({
    dealname: [l.locality ?? 'Area unknown', words(l.scope ?? l.segment) ?? 'enquiry', l.name ?? e164(row.phone) ?? 'caller'].join(' · '),
    pipeline: process.env.HUBSPOT_PIPELINE_ID,
    dealstage,
    amount: l.budget_max,
    hs_priority: row.notes?.includes('HIGH_VALUE') ? 'high' : 'medium', // prioritisation only — status comes from rules.js
    aangan_lead_id: String(row.id),
    aangan_qualification_status: row.status,
    aangan_qualification_reason: [...(row.reasons ?? []), ...notes].map(humanize).join('; '),
    aangan_project_type: words(l.scope),
    aangan_segment: l.segment,
    aangan_property_type: words(l.property_type ?? l.business_type),
    aangan_service_required: words(l.project_kind),
    aangan_carpet_sqft: l.carpet_sqft,
    aangan_rooms: l.rooms_in_scope?.join(', ') || null,
    aangan_deadline: l.deadline_date && l.deadline_date !== 'none' ? l.deadline_date : null,
    aangan_site_available: l.site_available_date,
    aangan_budget_min: l.budget_min,
    aangan_budget_max: l.budget_max,
    aangan_decision_maker: words(l.decision_maker) ?? 'not confirmed',
    aangan_preferred_slot: l.preferred_slot,
    aangan_ai_notes: [l.deadline_date === 'none' && 'No fixed deadline.', l.caller_notes, l.referral && `Referral: ${l.referral}`].filter(Boolean).join(' ') || null,
    aangan_agent_flags: (row.flags ?? []).map(humanize).join('; '),
    aangan_call_ids: (row.call_ids ?? []).join(', '),
    aangan_recording_url: row.recording_url,
    aangan_source: 'AI Front Desk',
    aangan_calendly_booking_url: row.calendly_booking_url,
    ...(calendlyWebhooksEnabled() ? {
      aangan_consultation_status: row.consultation_status ?? 'none',
      aangan_consultation_start: row.consultation_start,
      aangan_consultation_end: row.consultation_end,
      aangan_calendly_event_id: row.calendly_event_id,
      aangan_calendly_invitee_id: row.calendly_invitee_id,
      aangan_cancel_reason: row.consultation_status === 'canceled' ? row.calendly_cancel_reason ?? 'not given' : '',
    } : {}),
  });
}

export async function syncLead(row) {
  const phone = e164(row.phone);
  let contactId = null, dealId = null;
  if (phone) {
    const r = await hs('/crm/v3/objects/contacts/batch/upsert', 'POST',
      { inputs: [{ idProperty: 'aangan_phone_e164', id: phone, properties: contactProps(row) }] });
    contactId = r.results[0].id;
  }
  if (row.status !== 'ESCALATE') { // an existing client's complaint is not a sale
    const r = await hs('/crm/v3/objects/deals/batch/upsert', 'POST',
      { inputs: [{ idProperty: 'aangan_lead_id', id: String(row.id), properties: dealProps(row) }] });
    dealId = r.results[0].id;
    if (contactId) await hs(`/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`, 'PUT');
  }
  return { contactId, dealId };
}

// Returns the Supabase columns to save. Never throws: a failed sync is recorded and retried.
export async function syncCrm(row) {
  if (!hubspotConfigured()) return {};
  try {
    const { contactId, dealId } = await syncLead(row);
    return { hubspot_contact_id: contactId, hubspot_deal_id: dealId, hubspot_synced_at: new Date().toISOString(), hubspot_error: null };
  } catch (err) {
    return { hubspot_error: err.message.slice(0, 500) };
  }
}

export function hubspotUrl(row) {
  const portal = process.env.HUBSPOT_PORTAL_ID;
  if (!portal) return null;
  if (row.hubspot_deal_id) return `https://app.hubspot.com/contacts/${portal}/record/0-3/${row.hubspot_deal_id}`;
  if (row.hubspot_contact_id) return `https://app.hubspot.com/contacts/${portal}/record/0-1/${row.hubspot_contact_id}`;
  return null;
}
