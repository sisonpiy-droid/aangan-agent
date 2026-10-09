// Dashboard data. Open on purpose (no passcode): phones are masked, and transcripts, full numbers and emails stay behind /api/lead.
import { leadsSince, countEvents } from '../lib/store.js';
import { summarise } from '../lib/summary.js';

export async function GET(request) {
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get('days')) || 30, 1), 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [rows, unmatchedBookings] = await Promise.all([leadsSince(since), countEvents('unmatched', since)]);
  return Response.json(summarise(rows, days, { unmatchedBookings }), { headers: { 'cache-control': 'no-store' } });
}
