// Dashboard data. Passcode in a header (never the URL): it returns caller names and numbers.
import { secretOk } from '../lib/auth.js';
import { leadsSince, countEvents } from '../lib/store.js';
import { summarise } from '../lib/summary.js';

export async function GET(request) {
  if (!secretOk(request.headers.get('x-passcode'), process.env.DASHBOARD_PASSCODE)) return new Response('unauthorised', { status: 401 });
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get('days')) || 30, 1), 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [rows, unmatchedBookings] = await Promise.all([leadsSince(since), countEvents('unmatched', since)]);
  return Response.json(summarise(rows, days, { unmatchedBookings }), { headers: { 'cache-control': 'no-store' } });
}
