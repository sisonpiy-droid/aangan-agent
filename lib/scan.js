// Post-call guardrail: scan what the AGENT said (never the caller) for
// a price or a promised slot. Flags go to the dashboard for a human to check.

const NUM = String.raw`(\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|hundred|thousand)\b)`;
const MONEY = String.raw`(₹|\brs\.?|\brupees?\b|\blakhs?\b|\blacs?\b|\bcrores?\b|\bper\s*(sq|square)|/\s*sq)`;
const PRICE = [
  new RegExp(`${NUM}.{0,25}${MONEY}|${MONEY}.{0,10}${NUM}`, 'i'),
  /\b(rates?|prices?) (start|begin)|\b(it'?ll|it will|would) cost (around|about|roughly)|\btypically (costs?|around)\b/i,
];
// Availability only ever comes from Calendly, so the agent claiming a free slot is flagged too.
const WHEN = String.raw`(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|\d{1,2}(:\d\d)?\s*(am|pm|o'?clock)?)`;
const SLOT = new RegExp([
  String.raw`\b(booked|confirmed|scheduled|fixed) (you |it )?(for|on|at)\b`,
  String.raw`\bsee you (on|at)\b`,
  String.raw`\b(slots?|times?) (is |are )?(open|available|free)\b`,
  String.raw`\bavailable (at|on)\b`,
  String.raw`\bwe have .{0,30}\b(available|free|open)\b`,
  String.raw`\b${WHEN}\b.{0,25}\b(is|are) (available|free|open)\b`,
].join('|'), 'i');

export function scanAgentLines(transcript) {
  const flags = new Set();
  for (const t of transcript) {
    if (t.role !== 'AGENT') continue;
    if (PRICE.some(re => re.test(t.text))) flags.add('PRICING_LEAK');
    if (SLOT.test(t.text)) flags.add('SLOT_PROMISED');
  }
  return [...flags];
}
