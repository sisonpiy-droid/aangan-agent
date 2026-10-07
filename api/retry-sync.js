// Dashboard "Retry failed syncs": re-runs the (idempotent) HubSpot upsert for every row
// with hubspot_error, then sends the Telegram note if it never went out.
import { secretOk } from '../lib/auth.js';
import { failedSyncs } from '../lib/store.js';
import { syncAndNotify } from '../lib/pipeline.js';

export async function POST(request) {
  if (!secretOk(request.headers.get('x-passcode'), process.env.DASHBOARD_PASSCODE)) return new Response('unauthorised', { status: 401 });
  const rows = await failedSyncs();
  let fixed = 0;
  for (const row of rows) {
    const saved = await syncAndNotify(row, { renotify: !row.notified_at });
    if (!saved.hubspot_error) fixed++;
  }
  return Response.json({ retried: rows.length, fixed, stillFailing: rows.length - fixed });
}
