// Local preview without Vercel: serves public/ and the api/ handlers on :3400.
// With no Supabase env, it first loads the simulated September calls into memory.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { usingMemory } from '../lib/store.js';
import { processCall, applyBooking } from '../lib/pipeline.js';
import { normalize } from '../lib/extract.js';

process.env.DASHBOARD_PASSCODE ||= 'demo';
const routes = {
  '/api/stats': await import('../api/stats.js'),
  '/api/lead': await import('../api/lead.js'),
  '/api/weekly-digest': await import('../api/weekly-digest.js'),
  '/api/check-lead': await import('../api/check-lead.js'),
  '/api/call-ended': await import('../api/call-ended.js'),
  '/api/retry-sync': await import('../api/retry-sync.js'),
  '/api/calendly-webhook': await import('../api/calendly-webhook.js'),
};

if (usingMemory()) {
  process.env.CALENDLY_EVENT_URL_RESIDENTIAL ||= 'https://calendly.com/aangan-demo/consultation';
  process.env.QUIET = '1';
  process.env.CALENDLY_WEBHOOKS_ENABLED ||= 'true';
  const calls = JSON.parse(readFileSync(new URL('../test/transcripts.json', import.meta.url)));
  const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('../test/leads.json', import.meta.url))).map(c => [c.id, c.lead]));
  // Shift September to the last 30 days so the default period shows them.
  // Whole weeks, so each call keeps its time of day and weekday (after-hours stats stay true).
  const WEEK = 7 * 864e5, shift = Math.max(0, Math.floor((Date.now() - Date.parse('2026-09-25T00:00:00+05:30')) / WEEK) * WEEK);
  const leads = {};
  for (const [id, call] of Object.entries(calls)) {
    if (id.startsWith('_')) continue;
    leads[id] = await processCall({ ...call, createdAt: new Date(Date.parse(call.createdAt) + shift).toISOString() },
      { extractFn: async () => ({ lead: normalize(fixtures[id.replace(/b$/, '')] ?? {}), tokens: { in: 0, out: 0 } }) });
  }
  // One demo booking (T01 picks a slot three days out) so the consultation columns have data.
  await applyBooking({ kind: 'booked', leadId: String(leads.T01.id), inviteeUri: 'demo-invitee-1', inviteeId: 'demo-invitee-1', eventId: 'demo-event-1',
    start: new Date(Date.now() + 3 * 864e5).toISOString(), end: new Date(Date.now() + 3 * 864e5 + 3600e3).toISOString() });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const mod = routes[url.pathname];
  if (mod) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const handler = mod[req.method];
    if (!handler) { res.writeHead(405).end(); return; }
    const out = await handler(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(new URL('../public/index.html', import.meta.url)));
}).listen(3400, () => console.log(`http://localhost:3400  (passcode: ${process.env.DASHBOARD_PASSCODE === 'demo' ? 'demo' : 'from .env'}, storage: ${usingMemory() ? 'memory + simulated calls' : 'Supabase'})`));
