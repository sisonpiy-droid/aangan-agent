// Vaani mid-call custom function. The agent sends what it has heard so far;
// the rules (not the model) say what to do next. Returns only caller-safe text.
import { secretOk } from '../lib/auth.js';
import { normalize } from '../lib/extract.js';
import { qualify } from '../lib/rules.js';

export async function POST(request) {
  if (!secretOk(request.headers.get('x-aangan-secret'), process.env.CHECK_LEAD_SECRET)) {
    return new Response('unauthorised', { status: 401 });
  }
  let body;
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  const lead = normalize(body.arguments ?? body.parameters ?? body); // tool-call envelope not documented
  const { status, ask, say } = qualify(lead, new Date());
  const next = { QUALIFIED: 'collect_preferred_time', NEEDS_REVIEW: 'collect_preferred_time', NEEDS_INFO: 'ask', DECLINED: 'close', ESCALATE: 'escalate' }[status];
  return Response.json({ status, next, ask: ask ?? null, say });
}
