// Vercel Cron (vercel.json): Monday 09:00 IST → last week's numbers to Nikhil on Telegram.
// Vercel sends `Authorization: Bearer <CRON_SECRET>` when that env var is set; anything else is rejected.
import { secretOk } from '../lib/auth.js';
import { leadsSince, countEvents, logEvent } from '../lib/store.js';
import { summarise } from '../lib/summary.js';
import { digestText } from '../lib/digest.js';
import { send } from '../lib/notify.js';

export async function GET(request) {
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  if (!secretOk(bearer, process.env.CRON_SECRET)) return new Response('unauthorised', { status: 401 });

  const now = new Date(), weekAgo = new Date(now.getTime() - 7 * 864e5);
  const rows = await leadsSince(new Date(now.getTime() - 14 * 864e5).toISOString());
  const current = rows.filter(r => Date.parse(r.call_started_at) >= weekAgo.getTime());
  const s = summarise(current, 7, { unmatchedBookings: await countEvents('unmatched', weekAgo.toISOString()) });
  const base = process.env.PUBLIC_BASE_URL;
  const text = digestText(s, rows.length - current.length, { now, dashboardUrl: base ? `${base.replace(/\/$/, '')}/` : null });

  const sent = await send('nikhil', text);
  if (sent) await logEvent('telegram', 'sent', { externalId: `${sent.chat}:${sent.messageId}`, payload: { kind: 'weekly_digest' } });
  return Response.json({ sent: !!sent, calls: s.calls });
}
