// Supabase REST via fetch (service-role key, server only). With no env set it
// falls back to memory so `npm run simulate`, `npm run dev` and the tests work offline.

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const memory = { leads: [], events: [] };
let nextId = 1;

async function rest(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json', prefer: 'return=representation', ...init.headers },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const q = encodeURIComponent;
const newestFirst = (a, b) => Date.parse(b.call_started_at) - Date.parse(a.call_started_at);

export const usingMemory = () => !URL_ || !KEY;

export async function hasCall(callId) {
  if (usingMemory()) return memory.leads.some(r => r.call_ids.includes(callId));
  return (await rest(`leads?select=id&call_ids=cs.${q(`{${callId}}`)}&limit=1`)).length > 0;
}

export async function latestForPhone(phone) {
  if (!phone) return null;
  if (usingMemory()) return memory.leads.filter(r => r.phone === phone).sort(newestFirst)[0] ?? null;
  return (await rest(`leads?phone=eq.${q(phone)}&order=call_started_at.desc&limit=1`))[0] ?? null;
}

// Find one lead by a single column (id, calendly_invitee_id, phone + status…). Newest first.
export async function findLead(match) {
  const entries = Object.entries(match).filter(([, v]) => v != null);
  if (!entries.length) return null;
  if (usingMemory()) return memory.leads.filter(r => entries.every(([k, v]) => String(r[k]) === String(v))).sort(newestFirst)[0] ?? null;
  return (await rest(`leads?${entries.map(([k, v]) => `${k}=eq.${q(v)}`).join('&')}&order=call_started_at.desc&limit=1`))[0] ?? null;
}

export async function save(row, id) {
  if (usingMemory()) {
    if (id) return Object.assign(memory.leads.find(r => r.id === id), row);
    const r = { id: nextId++, created_at: new Date().toISOString(), ...row };
    memory.leads.push(r);
    return r;
  }
  const [r] = id
    ? await rest(`leads?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(row) })
    : await rest('leads', { method: 'POST', body: JSON.stringify(row) });
  return r;
}

export async function failedSyncs() {
  if (usingMemory()) return memory.leads.filter(r => r.hubspot_error);
  return rest('leads?hubspot_error=not.is.null&order=call_started_at.desc&limit=50&select=*');
}

// ponytail: pulls raw rows and aggregates in JS — fine at ~200 calls/month; move to a SQL view past ~10k rows.
export async function leadsSince(sinceIso) {
  if (usingMemory()) return memory.leads.filter(r => Date.parse(r.call_started_at) >= Date.parse(sinceIso)).sort(newestFirst);
  return rest(`leads?call_started_at=gte.${q(sinceIso)}&order=call_started_at.desc&select=*`);
}

// ---- events: raw webhooks, Telegram handoffs and the audit trail, in one append-only table ----

export async function eventExists(source, type, externalId) {
  if (usingMemory()) return memory.events.some(e => e.source === source && e.type === type && e.external_id === externalId);
  return (await rest(`events?select=id&source=eq.${q(source)}&type=eq.${q(type)}&external_id=eq.${q(externalId)}&limit=1`)).length > 0;
}

// Never throws: an audit write must not break the call flow.
export async function logEvent(source, type, { externalId = null, leadId = null, payload = {} } = {}) {
  const e = { source, type, external_id: externalId, lead_id: leadId, payload };
  try {
    if (usingMemory()) {
      if (externalId && await eventExists(source, type, externalId)) return;
      memory.events.push({ id: memory.events.length + 1, created_at: new Date().toISOString(), ...e });
      return;
    }
    await rest('events?on_conflict=source,type,external_id', { method: 'POST', body: JSON.stringify(e), headers: { prefer: 'resolution=ignore-duplicates,return=minimal' } });
  } catch (err) {
    console.error('logEvent failed', type, err.message);
  }
}

export async function countEvents(type, sinceIso) {
  if (usingMemory()) return memory.events.filter(e => e.type === type && Date.parse(e.created_at) >= Date.parse(sinceIso)).length;
  return (await rest(`events?select=id&type=eq.${q(type)}&created_at=gte.${q(sinceIso)}`)).length;
}
