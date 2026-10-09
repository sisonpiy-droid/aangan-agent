// Loads the 40 anonymised September 2026 enquiries (20 calls, 10 WhatsApp threads, 10 web forms) into the
// leads table so they show on the dashboard. The status of each one comes from lib/rules.js, never typed in.
//   npm run import:enquiries              dry run: prints what would be saved
//   npm run import:enquiries -- --apply   saves them (safe to re-run: existing ones are skipped)
//   npm run import:enquiries -- --delete  removes every row this script created
// Nothing here touches HubSpot or Telegram: these are history, not live calls.
import { readFileSync } from 'node:fs';
import * as store from '../lib/store.js';
import { qualify } from '../lib/rules.js';
import { nextTask } from '../lib/tasks.js';
import { bookingLink } from '../lib/calendly.js';

const here = (p) => new URL(p, import.meta.url);
const data = JSON.parse(readFileSync(here('../data/sep-2026-enquiries.json')));
const fixtures = Object.fromEntries(JSON.parse(readFileSync(here('../test/leads.json'))).map((c) => [c.id, c.lead]));
const text = readFileSync(here('../data/sep-2026-enquiries.txt'), 'utf8').replace(/\r\n/g, '\n').replace(/\n===== PAGE \d+ =====\n/g, '\n');
const apply = process.argv.includes('--apply');

if (process.argv.includes('--delete')) {
  if (store.usingMemory()) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leads?lead->>source=eq.sep-2026`, {
    method: 'DELETE', headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { authorization: `Bearer ${key}` }), prefer: 'return=representation' },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  console.log(`deleted ${(await res.json()).length} imported rows`);
  process.exit(0);
}

// ---- transcripts: cut each enquiry's block out of the PDF text ----
const blocks = {};
for (const part of text.split(/^(?=[TWF]\d{2} · )/m)) {
  const m = part.match(/^([TWF]\d{2}) · /);
  if (m) blocks[m[1]] = part.replace(/^.*\n/, '').replace(/\n(SECTION \d.*|Messages received.*|Submitted through.*|Front desk handles.*)[\s\S]*$/, '');
}
function transcript(id) {
  const body = (blocks[id] ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (id[0] === 'F') return [{ role: 'CALLER', text: body }];
  if (id[0] === 'W') {
    return body.split(/(?=\d{1,2}(?:[–-]\d{1,2})? Sept, \d{1,2}:\d{2}[ap]m(?: \([A-Za-z]+\))? — )/).map((s) => {
      const m = s.match(/^\d{1,2}(?:[–-]\d{1,2})? Sept, \d{1,2}:\d{2}[ap]m(?: \([A-Za-z]+\))? — (.+?): (.*)$/);
      return m && { role: m[1] === 'Front Desk' ? 'AGENT' : 'CALLER', text: m[2].replace(/\s*\[[^\]]*\].*$/, '').replace(/\s*Status:.*$/, '').trim() };
    }).filter((t) => t?.text);
  }
  return body.split(/(?=(?:Front Desk|Caller): )/).map((s) => {
    const m = s.match(/^(Front Desk|Caller): (.*)$/);
    return m && { role: m[1] === 'Front Desk' ? 'AGENT' : 'CALLER', text: m[2].replace(/\s*Note:.*$/, '').trim() };
  }).filter((t) => t?.text);
}

let made = 0, skipped = 0;
const rows = [];
for (const e of data) {
  const lead = { ...(e.lead ?? fixtures[e.id]) };
  if (!lead.intent) throw new Error(`${e.id}: no lead fields (add them to the data file)`);
  const result = e.force ? { notes: [], ...e.force } : qualify(lead, new Date(e.at), { final: true });
  Object.assign(lead, { source: 'sep-2026', channel: e.ch, enquiry_ref: e.id, call_summary: e.summary, progress: e.progress, first_reply_min: e.reply, todo: e.todo, stage: e.stage });
  const row = {
    call_ids: [`sep26-${e.id}`], phone: null, call_started_at: e.at, duration_sec: e.dur, transcript: transcript(e.id), lead,
    status: result.status, reasons: result.reasons, notes: result.notes ?? [], flags: [], cost_inr: 0, llm_tokens_in: 0, llm_tokens_out: 0,
    ...(e.consult?.status === 'booked' ? { consultation_status: 'booked', consultation_start: e.consult.start, consultation_end: new Date(Date.parse(e.consult.start) + 30 * 60e3).toISOString() } : {}),
  };
  rows.push({ e, row });
  const t = nextTask({ ...row, calendly_booking_url: 'x' });
  console.log(`${e.id.padEnd(4)} ${e.ch.padEnd(9)} ${result.status.padEnd(12)} ${(result.reasons.join(',') || '-').padEnd(40)} ${(e.todo?.key ?? t?.key ?? '-').padEnd(10)} ${row.transcript.length} msgs`);
}
if (!apply) { console.log('\nDry run. Add --apply to save.'); process.exit(0); }

for (const { e, row } of rows) {
  if (await store.hasCall(row.call_ids[0])) { skipped++; continue; }
  let saved = await store.save(row);
  const wantsLink = ['QUALIFIED', 'NEEDS_REVIEW'].includes(saved.status) && !e.stage && !e.force && !e.todo?.none && !saved.consultation_status;
  const url = bookingLink(saved);
  if (wantsLink && url) saved = await store.save({ calendly_booking_url: url, consultation_status: 'link_ready' }, saved.id);
  else if (saved.consultation_status === 'booked' && url) await store.save({ calendly_booking_url: url }, saved.id);
  await store.logEvent('import', 'sep_2026_enquiry', { externalId: e.id, leadId: saved.id, payload: { channel: e.ch, status: saved.status } });
  made++;
}
console.log(`\nsaved ${made}, skipped ${skipped} already there`);
