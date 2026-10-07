// One-time HubSpot setup: property group, custom properties (two of them unique, for
// idempotent upserts) and the "AI Front Desk" deal pipeline. Safe to re-run.
// npm run hubspot:setup   (needs HUBSPOT_SERVICE_KEY with the scopes listed in the README)

const TOKEN = process.env.HUBSPOT_SERVICE_KEY;
if (!TOKEN) { console.error('Set HUBSPOT_SERVICE_KEY in .env first.'); process.exit(1); }

async function hs(path, method = 'GET', body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const text = (name, label, extra = {}) => ({ name, label, type: 'string', fieldType: 'text', ...extra });
const num = (name, label) => ({ name, label, type: 'number', fieldType: 'number' });
const date = (name, label) => ({ name, label, type: 'date', fieldType: 'date' });
const datetime = (name, label) => ({ name, label, type: 'datetime', fieldType: 'date' });

const PROPS = {
  contacts: [
    text('aangan_phone_e164', 'Phone (E.164, dedupe key)', { hasUniqueValue: true }),
    text('aangan_locality', 'Locality'),
    text('aangan_source', 'Lead source (AI)'),
    text('aangan_last_status', 'Last AI qualification status'),
    text('aangan_consultation_status', 'Consultation status (Calendly)'),
  ],
  deals: [
    text('aangan_lead_id', 'AI lead ID (Supabase)', { hasUniqueValue: true }),
    text('aangan_qualification_status', 'Qualification status'),
    text('aangan_qualification_reason', 'Qualification reason', { fieldType: 'textarea' }),
    text('aangan_project_type', 'Project type'),
    text('aangan_segment', 'Residential / commercial'),
    text('aangan_property_type', 'Property type'),
    text('aangan_service_required', 'Service required'),
    num('aangan_carpet_sqft', 'Carpet area (sq ft)'),
    text('aangan_rooms', 'Rooms in scope'),
    date('aangan_deadline', 'Complete by'),
    date('aangan_site_available', 'Site available from'),
    num('aangan_budget_min', 'Volunteered budget min (₹)'),
    num('aangan_budget_max', 'Volunteered budget max (₹)'),
    text('aangan_decision_maker', 'Decision-maker status'),
    text('aangan_preferred_slot', 'Preferred consultation time'),
    text('aangan_ai_notes', 'AI notes', { fieldType: 'textarea' }),
    text('aangan_agent_flags', 'Agent check flags'),
    text('aangan_call_ids', 'Vaani call IDs'),
    text('aangan_recording_url', 'Call recording URL'),
    text('aangan_calendly_booking_url', 'Calendly booking link'),
    text('aangan_consultation_status', 'Consultation status (Calendly)'),
    datetime('aangan_consultation_start', 'Consultation start'),
    datetime('aangan_consultation_end', 'Consultation end'),
    text('aangan_calendly_event_id', 'Calendly event ID'),
    text('aangan_calendly_invitee_id', 'Calendly invitee ID'),
    text('aangan_cancel_reason', 'Consultation cancel reason'),
    text('aangan_source', 'Lead source (AI)'),
  ],
};

for (const [object, props] of Object.entries(PROPS)) {
  const g = await hs(`/crm/v3/properties/${object}/groups`, 'POST', { name: 'aangan_ai_front_desk', label: 'AI Front Desk' });
  console.log(`${object} group: ${g.status === 201 ? 'created' : g.status === 409 ? 'exists' : `error ${g.status} ${JSON.stringify(g.data)}`}`);
  for (const p of props) {
    const r = await hs(`/crm/v3/properties/${object}`, 'POST', { groupName: 'aangan_ai_front_desk', ...p });
    if (r.status !== 201 && r.status !== 409) console.log(`  ${p.name}: error ${r.status} ${r.data?.message ?? ''}`);
  }
  console.log(`${object} properties: done`);
}

const STAGES = [
  { label: 'Qualified', displayOrder: 0, metadata: { probability: '0.2' } },
  { label: 'Needs review', displayOrder: 1, metadata: { probability: '0.1' } },
  { label: 'Consultation booked', displayOrder: 2, metadata: { probability: '0.4' } },
  { label: 'Declined', displayOrder: 3, metadata: { probability: '0.0', isClosed: 'true' } },
];
let pipe = (await hs('/crm/v3/pipelines/deals')).data?.results?.find(p => p.label === 'AI Front Desk');
if (!pipe) {
  const r = await hs('/crm/v3/pipelines/deals', 'POST', { label: 'AI Front Desk', displayOrder: 99, stages: STAGES });
  if (r.status === 201) pipe = r.data;
  else console.log(`\nCould not create the "AI Front Desk" pipeline (${r.status}: ${r.data?.message ?? ''}).
The free HubSpot CRM allows one deal pipeline. Add four stages (Qualified, Needs review, Consultation booked, Declined)
to your existing pipeline in HubSpot settings and put its IDs in .env by hand.`);
}

// Older setups: add any stage that is missing (e.g. "Consultation booked").
for (const st of pipe ? STAGES.filter(st => !pipe.stages.some(x => x.label === st.label)) : []) {
  const r = await hs(`/crm/v3/pipelines/deals/${pipe.id}/stages`, 'POST', st);
  if (r.status === 201) pipe.stages.push(r.data); else console.log(`stage ${st.label}: error ${r.status} ${r.data?.message ?? ''}`);
}

const portal = (await hs('/account-info/v3/details')).data?.portalId;
if (pipe) {
  const id = label => pipe.stages.find(s => s.label === label)?.id;
  console.log(`\nAdd to .env / Vercel (these are IDs, not secrets):\nHUBSPOT_PIPELINE_ID=${pipe.id}\nHUBSPOT_STAGE_QUALIFIED=${id('Qualified')}\nHUBSPOT_STAGE_REVIEW=${id('Needs review')}\nHUBSPOT_STAGE_BOOKED=${id('Consultation booked')}\nHUBSPOT_STAGE_DECLINED=${id('Declined')}`);
}
if (portal) console.log(`HUBSPOT_PORTAL_ID=${portal}`);
