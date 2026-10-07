// Transcript → lead fields. The LLM only extracts; normalize() is the trust
// boundary that forces every value into the shape rules.js expects.
// ponytail: Gemini only (free tier). Add a second provider when one is needed.

const ENUMS = {
  intent: ['new_enquiry', 'existing_client', 'not_a_lead'],
  project_kind: ['design_and_execution', 'advice_only', 'decor_only', 'vastu_only', 'sourcing_only'],
  segment: ['residential', 'commercial'],
  scope: ['full_home', 'partial_home', 'single_room', 'office_fitout', 'other'],
  property_type: ['apartment', 'independent_house', 'villa', 'office', 'clinic', 'studio', 'other'],
  business_type: ['office', 'clinic', 'studio', 'restaurant', 'hotel', 'retail', 'gym', 'other'],
  city: ['pune', 'pcmc', 'other'],
  structural_changes: ['yes', 'no'],
  decision_maker: ['yes', 'authorised_rep', 'no'],
};
const TEXT = ['name', 'email', 'locality', 'preferred_slot', 'referral', 'caller_notes'];
const NUMS = ['carpet_sqft', 'budget_min', 'budget_max'];

const PROMPT = `You extract an interior-design enquiry from a phone call transcript for Aangan Studio, Pune.
Return ONE JSON object with exactly these keys. Use null for anything the caller did not clearly say. Never guess.

intent: "new_enquiry" | "existing_client" (already has a project with Aangan, e.g. a complaint) | "not_a_lead" (vendor, job seeker, wrong number, spam)
email: only if the caller said it
project_kind: "design_and_execution" (wants the space designed AND built) | "advice_only" | "decor_only" | "vastu_only" | "sourcing_only"
segment: "residential" | "commercial"
scope: "full_home" | "partial_home" (2+ rooms or a floor) | "single_room" | "office_fitout" | "other"
property_type: "apartment" | "independent_house" | "villa" | "office" | "clinic" | "studio" | "other"
business_type: for commercial only — "office" | "clinic" | "studio" | "restaurant" | "hotel" | "retail" | "gym" | "other"; null for homes
city: "pune" (Pune city incl. Kothrud, Baner, Aundh, Wakad, Koregaon Park, Kalyani Nagar, Viman Nagar, Hadapsar, Magarpatta, NIBM, Kondhwa, Undri, Kharadi, Nanded City and adjoining areas) | "pcmc" (Pimpri, Chinchwad, Pimple Saudagar, Pimple Nilakh, Ravet, Hinjewadi) | "other" (Talegaon, Lonavala, Nashik, Mumbai, any other city)
locality: the area as the caller said it
carpet_sqft: number
rooms_in_scope: array of rooms/areas to be designed (e.g. ["kitchen","living room"]); [] if not said
structural_changes: "yes" if they want walls moved or structure changed, "no" if they said no structural work
rented: true if the property is rented, else false
deadline_date: "YYYY-MM-DD" by which the project must be COMPLETE ("by March" = last day of the next March after the call date), or "none" if the caller said there is no fixed deadline
site_available_date: "YYYY-MM-DD" when the site becomes available for work, only if later than now (e.g. possession date, "execution from February")
budget_min, budget_max: rupees as numbers, ONLY if the caller volunteered a budget ("1.5 lakh" = 150000)
decision_maker: "yes" (caller decides, or says spouse/partner agrees) | "authorised_rep" (calling for owners who will decide and attend) | "no" (only researching for someone else)
preferred_slot: preferred consultation day/time as said
referral: how they heard of Aangan / who referred them
caller_notes: one or two sentences a designer should know (preferences, frustration, urgency)`;

export async function extract(transcript, callDate) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const text = transcript.map(t => `${t.role}: ${t.text}`).join('\n');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${PROMPT}\n\nCall date: ${callDate}\n\nTranscript:\n${text}` }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  const u = data.usageMetadata ?? {};
  return {
    lead: normalize(JSON.parse(raw)),
    tokens: { in: u.promptTokenCount ?? 0, out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalize(x = {}) {
  const lead = {};
  for (const [k, allowed] of Object.entries(ENUMS)) lead[k] = allowed.includes(x[k]) ? x[k] : null;
  for (const k of TEXT) lead[k] = typeof x[k] === 'string' && x[k].trim() ? x[k].trim().slice(0, 500) : null;
  for (const k of NUMS) lead[k] = Number.isFinite(Number(x[k])) && x[k] !== null && x[k] !== '' && Number(x[k]) > 0 ? Number(x[k]) : null;
  lead.rooms_in_scope = Array.isArray(x.rooms_in_scope) ? x.rooms_in_scope.filter(r => typeof r === 'string').slice(0, 20) : [];
  if (lead.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) lead.email = null;
  lead.rented = x.rented === true;
  lead.deadline_date = x.deadline_date === 'none' || DATE.test(x.deadline_date) ? x.deadline_date : null;
  lead.site_available_date = DATE.test(x.site_available_date) ? x.site_available_date : null;
  return lead;
}
