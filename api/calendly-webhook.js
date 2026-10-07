// Calendly webhook: invitee.created / invitee.canceled (bookings, reschedules, cancellations).
// Processed inline: if anything fails we return 500 and Calendly retries.
import { calendlySignatureOk, parseWebhook } from '../lib/calendly.js';
import { applyBooking } from '../lib/pipeline.js';
import * as store from '../lib/store.js';

export async function POST(request) {
  const raw = await request.text();
  if (!calendlySignatureOk(raw, request.headers.get('calendly-webhook-signature'), process.env.CALENDLY_WEBHOOK_SIGNING_KEY)) {
    return new Response('bad signature', { status: 401 });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const b = parseWebhook(body);
  if (!b.kind || !b.inviteeUri) return Response.json({ ignored: body.event ?? 'unknown' });

  if (await store.eventExists('calendly', body.event, b.inviteeUri)) return Response.json({ duplicate: true });
  try {
    const lead = await applyBooking(b);
    await store.logEvent('calendly', body.event, { externalId: b.inviteeUri, leadId: lead?.id ?? null, payload: body }); // logged last, so a failure is retried
    return Response.json({ ok: true, lead: lead?.id ?? null, kind: b.kind });
  } catch (err) {
    console.error('calendly webhook failed', err);
    return new Response('processing failed', { status: 500 });
  }
}
