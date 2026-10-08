// Vaani Voice webhook adapter (docs.vaanivoice.ai/guides/webhook-setup). Turns Vaani's payloads into the
// pipeline's call shape: { id, fromNumber, createdAt, durationSec, transcript[{role,text}], collectedData, recordingUrl }.
//   call_started        → { room_name, phone_number }       saved so we know the caller ID later
//   call_postprocessing → { call_id, timestamp, data: { room_name, call_id, call_duration (ms), transcript (text),
//                           entities, summary, recording_url } }

const ROLE = { AGENT: 'AGENT', ASSISTANT: 'AGENT', BOT: 'AGENT', USER: 'CALLER', CUSTOMER: 'CALLER', CALLER: 'CALLER', HUMAN: 'CALLER' };
const LINE = /^\s*(?:\[(\d{1,2}):(\d{2}):(\d{2})\]\s*)?(AGENT|ASSISTANT|BOT|USER|CUSTOMER|CALLER|HUMAN)\s*:\s*(.*)$/i;

// "[13:33:14] AGENT: Hi!\n\n[13:33:19] USER: Hello" → [{ role: 'AGENT', text: 'Hi!' }, { role: 'CALLER', text: 'Hello' }]
export function parseTranscript(text) {
  if (Array.isArray(text)) return text; // already structured
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (m) out.push({ role: ROLE[m[4].toUpperCase()], text: m[5].trim() });
    else if (raw.trim() && out.length) out.at(-1).text += ` ${raw.trim()}`; // wrapped line
  }
  return out.filter(t => t.text);
}

export const callKey = body => {
  const d = body?.data ?? body ?? {};
  return d.room_name ?? d.call_id ?? body?.call_id ?? null;
};
export const isOutbound = body => String(callKey(body) ?? '').startsWith('outbound-');

// started = the saved call_started event ({ payload, created_at }) or null.
export function toCall(body, started = null) {
  const d = body.data ?? body;
  const durationMs = Number(d.call_duration ?? 0) || 0;
  const transcript = parseTranscript(d.transcript);
  const startedAt = started?.created_at
    ?? new Date((Date.parse(body.timestamp ?? d.timestamp) || Date.now()) - durationMs).toISOString();
  return {
    id: d.call_id ?? body.call_id ?? d.room_name,
    // Docs only show phone_number on call_started; take it from the postprocessing payload too if Vaani sends it.
    fromNumber: d.phone_number ?? d.from_number ?? d.caller_number ?? body.phone_number ?? started?.payload?.phone_number ?? started?.payload?.data?.phone_number ?? null,
    createdAt: startedAt,
    durationSec: Math.round(durationMs / 1000),
    // Nothing said by the caller = a failed or dropped call → the call-back path.
    transcript: transcript.some(t => t.role === 'CALLER') ? transcript : [],
    collectedData: d.entities && typeof d.entities === 'object' ? d.entities : {},
    recordingUrl: d.recording_url ?? null,
    summary: typeof d.summary === 'string' && d.summary.trim() ? d.summary.trim() : null,
  };
}
