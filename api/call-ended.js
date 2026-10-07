// Vaani webhook: call.completed / call.failed → pipeline.
// Vaani times out after 6 s, so reply at once and finish the work in waitUntil.
import { waitUntil } from '@vercel/functions';
import { vaaniSignatureOk } from '../lib/auth.js';
import { processCall } from '../lib/pipeline.js';
import { notify } from '../lib/notify.js';

export async function POST(request) {
  const raw = await request.text();
  if (!vaaniSignatureOk(raw, request.headers.get('x-vaaniyantra-signature'), process.env.VAANI_WEBHOOK_SECRET)) {
    return new Response('bad signature', { status: 401 });
  }
  const event = request.headers.get('x-vaaniyantra-event');
  if (event && event !== 'call.completed' && event !== 'call.failed') return Response.json({ ignored: event });

  let body;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const call = body.data ?? body; // envelope not fully documented; accept both shapes
  if (call.direction && call.direction !== 'INBOUND') return Response.json({ ignored: 'outbound' });
  if (event === 'call.failed') call.transcript = [];

  waitUntil(processCall(call, { event: event ?? 'call.completed' }).catch(async err => {
    // Last line of defence against losing a caller: log the payload and ping the designers.
    console.error('processCall failed', err, JSON.stringify(call).slice(0, 4000));
    await notify({ status: 'NEEDS_REVIEW', reasons: ['PIPELINE_FAILED'], notes: [], flags: [], lead: {},
      phone: call.fromNumber, duration_sec: call.durationSec ?? 0, call_started_at: call.createdAt ?? new Date().toISOString() }).catch(() => {});
  }));
  return Response.json({ ok: true });
}
