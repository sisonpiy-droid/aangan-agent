// Deterministic qualification. The AI only fills in the lead; this file decides.
// Sources: qualified.md (the decision authority), services.md, pricing.md.
// Unknown fields are null. Dates are ISO strings; deadline_date may also be 'none'
// (caller said there is no deadline).

export const SERVICE_CITIES = ['pune', 'pcmc']; // services.md "Service area"
export const EXCLUDED_LOCALITIES = ['talegaon', 'lonavala', 'nashik', 'mumbai']; // services.md + qualified.md §2
export const OUT_OF_SCOPE_BUSINESS = ['restaurant', 'hotel', 'retail', 'gym']; // services.md "What we don't do"
export const NOT_A_PROJECT = ['advice_only', 'decor_only', 'vastu_only', 'sourcing_only']; // qualified.md §1, services.md

// qualified.md §3 says 8–10 weeks; services.md says a 6-week minimum lead time.
// qualified.md wins (user decision) — see README "Source-policy ambiguities".
// ponytail: calibration knobs, tune with Nikhil after the first month of real calls.
export const MIN_DEADLINE_WEEKS = 8;
export const MAX_SITE_WAIT_WEEKS = 10;
export const BUDGET_CLEARLY_BELOW = 0.5; // volunteered max < 50% of the lowest estimate = "clearly below" (qualified.md §4)
export const HIGH_VALUE_INR = 30e5; // ~2× the top of the ₹8–14L average project value (brief); most full homes clear 14L at pricing.md rates
export const COMMERCIAL_MIN_SQFT = 500; // front desk used this in T18; NOT in services.md → review only
export const COMMERCIAL_MAX_SQFT = 3000; // services.md "up to approximately 3,000 sq ft"

// pricing.md lowest indicative rates. Internal only: never sent to a caller.
const RATE_FLOOR = { residential: 1800, commercial: 1200 };
const ROOM_FLOOR = 3.5e5;

const WEEK_MS = 7 * 864e5;
const weeksUntil = (date, now) => (Date.parse(date) - now.getTime()) / WEEK_MS;

export function lowestEstimate(lead) {
  const rooms = lead.rooms_in_scope?.length ?? 0;
  if (lead.segment !== 'commercial' && rooms >= 1 && rooms <= 2) return rooms * ROOM_FLOOR;
  const rate = RATE_FLOOR[lead.segment ?? 'residential'];
  return lead.carpet_sqft && rate ? lead.carpet_sqft * rate : null;
}

// The only text the agent may say about price (pricing.md, verbatim).
export const PRICING_DEFLECTION =
  "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

// One direct question per unclear criterion (qualified.md "At the boundary").
export const QUESTIONS = {
  project_kind: 'Are you looking for full design and execution, or design advice only?',
  city: 'Which area is the property in?',
  deadline: 'When would you need the project complete?',
};

// Caller-facing lines. No numbers, no slot promises.
export const CLOSINGS = {
  OUT_OF_AREA: "We only work in Pune and PCMC — we don't have the vendor network outside Pune to do the project justice. I'm sorry we can't help this time.",
  NOT_A_FULL_PROJECT: "We're a full-service studio — our minimum engagement is a room redesign with execution, so we don't do advice-only visits. Please do call back when you're ready for a full project.",
  BUSINESS_TYPE_OUT_OF_SCOPE: "That's outside what we design — we focus on homes and offices, and a specialist studio would serve you better.",
  TIMELINE_TOO_SHORT: "Honestly, that timeline is too short for us to do a proper job — design and execution together take at least eight to ten weeks. If a later finish works for you, I'd be glad to note your details for that.",
  BUDGET_CLEARLY_BELOW: "Thank you for sharing that. For the scope you've described, that budget would be significantly below what a project with full execution costs with us — I'd rather tell you now than at a consultation.",
  NOT_RIGHT_FIT: 'This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.', // qualified.md
  // No slot is ever offered on the call: the caller picks a real Calendly slot from the link we text or email them, or the studio books the time they asked for.
  BOOK: "Thank you — I've noted everything. If it's a fit, we'll confirm a consultation time close to the one you asked for, by text and email shortly.",
  ESCALATE: "I'm very sorry about this. I'm passing it to a senior person right now, and they will call you back as soon as possible.",
};

const SOFT = ['NOT_DECISION_MAKER', 'SITE_AVAILABLE_LATE'];

// final=false: during the call (unknowns → NEEDS_INFO + one question).
// final=true: after the call (unknowns → NEEDS_REVIEW; never silently declined).
export function qualify(lead, now = new Date(), { final = false } = {}) {
  const out = (status, reasons, extra = {}) => ({ status, reasons, notes, ...extra });
  const notes = [];

  if (lead.intent === 'existing_client') return out('ESCALATE', ['EXISTING_CLIENT'], { say: CLOSINGS.ESCALATE });
  if (lead.intent === 'not_a_lead') return out('NEEDS_REVIEW', ['NOT_A_LEAD']);

  const hard = [], review = [], unknown = [];

  // 1. Real project
  if (NOT_A_PROJECT.includes(lead.project_kind)) hard.push('NOT_A_FULL_PROJECT');
  else if (!lead.project_kind) unknown.push('project_kind');
  if (OUT_OF_SCOPE_BUSINESS.includes(lead.business_type)) hard.push('BUSINESS_TYPE_OUT_OF_SCOPE');

  // 2. Service area
  const locality = (lead.locality ?? '').toLowerCase();
  if (EXCLUDED_LOCALITIES.some(x => locality.includes(x)) || (lead.city && !SERVICE_CITIES.includes(lead.city))) hard.push('OUT_OF_AREA');
  else if (!lead.city) unknown.push('city');

  // 3. Timeline
  if (lead.deadline_date == null) unknown.push('deadline');
  else if (lead.deadline_date !== 'none' && weeksUntil(lead.deadline_date, now) < MIN_DEADLINE_WEEKS) hard.push('TIMELINE_TOO_SHORT');
  if (lead.site_available_date && weeksUntil(lead.site_available_date, now) > MAX_SITE_WAIT_WEEKS) review.push('SITE_AVAILABLE_LATE');

  // Scope size (commercial)
  if (lead.segment === 'commercial' && lead.carpet_sqft) {
    if (lead.carpet_sqft < COMMERCIAL_MIN_SQFT) review.push('COMMERCIAL_UNDER_500_UNDOCUMENTED');
    if (lead.carpet_sqft > COMMERCIAL_MAX_SQFT) review.push('COMMERCIAL_OVER_3000');
  }
  if (lead.structural_changes === 'yes') review.push('STRUCTURAL_WORK_REQUESTED');

  // 4. Budget — only if volunteered. Don't probe.
  const floor = lowestEstimate(lead);
  if (lead.budget_max && floor) {
    const ratio = lead.budget_max / floor;
    if (ratio < BUDGET_CLEARLY_BELOW) hard.push('BUDGET_CLEARLY_BELOW');
    else if (ratio < 1) notes.push('BUDGET_MAY_BE_TIGHT');
  } else if (lead.budget_max) notes.push('BUDGET_NOT_ASSESSED');

  // 5. Decision-maker — don't push; note uncertainty.
  if (lead.decision_maker === 'no') review.push('NOT_DECISION_MAKER');
  else if (lead.decision_maker === 'authorised_rep') notes.push('DECISION_MAKER_REP');
  else if (lead.decision_maker !== 'yes') notes.push('DECISION_MAKER_UNCLEAR');

  if (lead.rented) notes.push('RENTED');
  if ((lead.budget_max ?? floor) >= HIGH_VALUE_INR) notes.push('HIGH_VALUE');

  const soft = review.filter(r => SOFT.includes(r));
  if (hard.length) return out('DECLINED', [...hard, ...review], { say: CLOSINGS[hard[0]] });
  if (soft.length >= 2) return out('DECLINED', review, { say: CLOSINGS.NOT_RIGHT_FIT });
  if (unknown.length) {
    if (!final) return out('NEEDS_INFO', review, { ask: unknown[0], say: QUESTIONS[unknown[0]] });
    review.push(...unknown.map(u => `UNANSWERED_${u.toUpperCase()}`));
  }
  if (review.length) return out('NEEDS_REVIEW', review, { say: CLOSINGS.BOOK });
  return out('QUALIFIED', [], { say: CLOSINGS.BOOK });
}
