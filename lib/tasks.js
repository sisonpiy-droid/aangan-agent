// "What should a human do next?" One source for the Telegram "Next task" line and the HubSpot task.
// Pure: no I/O. Timings are named constants so Nikhil can tune them.

export const LINK_DUE_MIN = 60; // Nikhil: an enquiry answered within an hour converts 4× better
export const CALLBACK_DUE_MIN = 15; // T09: "someone senior call you back within 15 minutes"
export const REVIEW_DUE_MIN = 240; // NEEDS_REVIEW is not on Telegram, so its HubSpot task is how it gets seen
export const RECONTACT_WEEKS = 5; // ponytail: Nikhil's notes say re-engage in 4–6 weeks; tune after real data
// "Not now" declines worth a second look later. Out of area, budget and business type are permanent.
const RECONTACT_REASONS = ['TIMELINE_TOO_SHORT', 'NOT_A_FULL_PROJECT'];

const CALL_BACK = ['CALL_FAILED_CALL_BACK', 'PIPELINE_FAILED', 'EXTRACTION_FAILED'];
const NOTHING_CAPTURED = ['UNANSWERED_PROJECT_KIND', 'UNANSWERED_CITY', 'UNANSWERED_DEADLINE'];
export const isCallBack = row => row.status === 'NEEDS_REVIEW' && !!row.phone &&
  (row.reasons?.some(r => CALL_BACK.includes(r)) || NOTHING_CAPTURED.every(r => row.reasons?.includes(r)));

// → { key, subject, line, dueMin, type, priority } or null. `line` is the sentence shown on Telegram.
export function nextTask(row) {
  const name = row.lead?.name ?? 'caller';
  const priority = row.notes?.includes('HIGH_VALUE') ? 'HIGH' : 'MEDIUM';
  if (row.status === 'ESCALATE') {
    return { key: 'escalation', subject: `Call back existing client — ${name}`, line: 'Call the client back within 15 minutes (a senior person)', dueMin: CALLBACK_DUE_MIN, type: 'CALL', priority: 'HIGH' };
  }
  if (isCallBack(row)) {
    return { key: 'callback', subject: 'Call back caller — call dropped', line: 'Call back now: the call dropped before anything was captured', dueMin: CALLBACK_DUE_MIN, type: 'CALL', priority: 'HIGH' };
  }
  if (row.status === 'QUALIFIED') {
    const link = !!row.calendly_booking_url;
    return {
      key: 'link',
      subject: link ? `Send consultation link — ${name}` : `Book a consultation — ${name}`,
      line: link ? 'Send the Calendly link and confirm a visit within 1 hour' : 'Call the caller and book a consultation within 1 hour',
      dueMin: LINK_DUE_MIN, type: link ? 'TODO' : 'CALL', priority,
    };
  }
  if (row.status === 'NEEDS_REVIEW') {
    return { key: 'review', subject: `Review AI lead — ${name}`, line: 'Review the reasons in HubSpot and decide whether to follow up', dueMin: REVIEW_DUE_MIN, type: 'TODO', priority };
  }
  if (row.status === 'DECLINED' && row.reasons?.some(r => RECONTACT_REASONS.includes(r))) {
    return { key: 'recontact', subject: `Re-contact ${name} — asked about a later start`, line: 'Re-contact in a few weeks: they may be ready then', dueMin: RECONTACT_WEEKS * 7 * 24 * 60, type: 'CALL', priority: 'LOW' };
  }
  return null;
}

export const dueAt = (task, now = new Date()) => new Date(now.getTime() + task.dueMin * 60e3).toISOString();
