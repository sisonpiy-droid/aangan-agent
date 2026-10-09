// One lead's page: transcript, extracted fields, links and the audit timeline. Open (no passcode), by the owner's choice.
import { findLead, eventsForLead } from '../lib/store.js';
import { hubspotUrl } from '../lib/hubspot.js';
import { nextTask } from '../lib/tasks.js';

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!/^\d+$/.test(id ?? '')) return new Response('bad id', { status: 400 });
  const row = await findLead({ id });
  if (!row) return new Response('not found', { status: 404 });
  const { transcript, ...rest } = row;
  return Response.json({
    ...rest, transcript, hubspot_url: row.hubspot_url ?? hubspotUrl(row), next_task: nextTask(row)?.line ?? null,
    events: await eventsForLead(row.id),
  }, { headers: { 'cache-control': 'no-store' } });
}
