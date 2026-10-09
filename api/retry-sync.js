// Dashboard "Retry failed syncs": re-runs the (idempotent) HubSpot upsert for every row
// with hubspot_error, then sends the Telegram note if it never went out.
import { failedSyncs } from '../lib/store.js';
import { syncAndNotify } from '../lib/pipeline.js';

export async function POST(request) {
  const rows = await failedSyncs();
  let fixed = 0;
  for (const row of rows) {
    const saved = await syncAndNotify(row, { renotify: !row.notified_at });
    if (!saved.hubspot_error) fixed++;
  }
  return Response.json({ retried: rows.length, fixed, stillFailing: rows.length - fixed });
}
