// Vaani Voice webhook (Settings → Webhooks): https://<app>/api/call-ended?key=<VAANI_WEBHOOK_SECRET>
// Vaani documents no signature, so the secret rides in the URL and every request without it is rejected.
//   call_started        → remember the caller ID (events table)
//   call_postprocessing → the pipeline (transcript, entities and summary are ready)
//   anything else       → logged only
import { waitUntil } from '@vercel/functions';
import { secretOk } from '../lib/auth.js';
import { callKey, isOutbound, toCall } from '../lib/vaani.js';
import { processCall } from '../lib/pipeline.js';
import { notify } from '../lib/notify.js';
import * as store from '../lib/store.js';

export async function handleVaaniEvent(body, opts = {}) {
  const key = callKey(body);
  if (isOutbound(body)) return { ignored: 'outbound' };
  if (body.event !== 'call_postprocessing') {
    await store.logEvent('vaani', body.event ?? 'unknown', { externalId: key, payload: body });
    return { logged: body.event ?? 'unknown' };
  }
  const started = key ? await store.findEvent('vaani', 'call_started', key) : null;
  const call = toCall(body, started);
  try {
    const row = await processCall(call, { event: 'call_postprocessing', ...opts });
    return { lead: row?.id ?? null, status: row?.status ?? 'duplicate' };
  } catch (err) {
    // Last line of defence against losing a caller: log the payload and ping the designers.
    console.error('processCall failed', err, JSON.stringify(body).slice(0, 4000));
    await notify({ status: 'NEEDS_REVIEW', reasons: ['PIPELINE_FAILED'], notes: [], flags: [], lead: {},
      phone: call.fromNumber, duration_sec: call.durationSec, call_started_at: call.createdAt }).catch(() => {});
    throw err;
  }
}

export async function POST(request) {
  const given = new URL(request.url).searchParams.get('key') ?? request.headers.get('x-vaani-secret');
  if (!secretOk(given, process.env.VAANI_WEBHOOK_SECRET)) return new Response('unauthorised', { status: 401 });
  let body;
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }

  if (body.event === 'call_postprocessing' && !isOutbound(body)) {
    waitUntil(handleVaaniEvent(body).catch(() => {})); // reply at once; the work finishes in the background
    return Response.json({ ok: true, queued: true });
  }
  return Response.json(await handleVaaniEvent(body));
}
