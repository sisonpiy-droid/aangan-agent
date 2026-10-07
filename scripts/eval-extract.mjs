// Live check of the LLM step (costs a little): extract() on the real transcripts,
// compared with the hand-written leads, then qualify() on what the LLM produced.
import { readFileSync } from 'node:fs';
import { extract, normalize } from '../lib/extract.js';
import { qualify } from '../lib/rules.js';

const calls = JSON.parse(readFileSync(new URL('../test/transcripts.json', import.meta.url)));
const cases = JSON.parse(readFileSync(new URL('../test/leads.json', import.meta.url)));
const FIELDS = ['intent', 'project_kind', 'segment', 'business_type', 'city', 'carpet_sqft', 'rented', 'deadline_date', 'budget_max', 'decision_maker'];

let statusMisses = 0;
for (const c of cases) {
  const transcript = c.id === 'T17' ? [...calls.T17a.transcript, ...calls.T17b.transcript] : calls[c.id]?.transcript;
  if (!transcript) continue; // web-form cases have no call transcript
  const { lead } = await extract(transcript, c.at);
  const want = normalize(c.lead);
  const diffs = FIELDS.filter(f => JSON.stringify(lead[f]) !== JSON.stringify(want[f])).map(f => `${f}: got ${JSON.stringify(lead[f])}, want ${JSON.stringify(want[f])}`);
  const got = qualify(lead, new Date(c.at), { final: true }).status;
  const ok = got === c.expect.status;
  if (!ok) statusMisses++;
  console.log(`${ok ? 'ok  ' : 'MISS'} ${c.id} status ${got} (want ${c.expect.status})${c._note ? ' [fixture assumes: ' + c._note + ']' : ''}`);
  for (const d of diffs) console.log(`       ${d}`);
}
console.log(statusMisses ? `\n${statusMisses} status mismatch(es)` : '\nall statuses match');
process.exitCode = statusMisses ? 1 : 0;
