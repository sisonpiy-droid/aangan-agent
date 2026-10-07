// Run case transcripts through the real pipeline: npm run simulate -- T01 T17a T17b
// No GEMINI_API_KEY → uses the hand-written leads in test/leads.json instead of the LLM.
// No Supabase / Telegram env → stores in memory and prints the Telegram note.
import { readFileSync } from 'node:fs';
import { processCall } from '../lib/pipeline.js';
import { normalize } from '../lib/extract.js';
import { usingMemory } from '../lib/store.js';

const calls = JSON.parse(readFileSync(new URL('../test/transcripts.json', import.meta.url)));
const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('../test/leads.json', import.meta.url))).map(c => [c.id, c.lead]));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(calls).filter(k => !k.startsWith('_'));
const offline = !process.env.GEMINI_API_KEY;

console.log(`extraction: ${offline ? 'OFFLINE (fixtures)' : 'Gemini'} · storage: ${usingMemory() ? 'memory' : 'Supabase'}`);
for (const id of ids) {
  const call = calls[id];
  if (!call) { console.error(`unknown case ${id}`); continue; }
  const extractFn = offline ? async () => ({ lead: normalize(fixtures[id.replace(/b$/, '')] ?? {}), tokens: { in: 0, out: 0 } }) : undefined;
  const r = await processCall({ ...call, id: `${call.id}-${Date.now()}` }, { extractFn });
  console.log(`${id.padEnd(5)} → ${r.status.padEnd(12)} ${r.merged ? '[merged with earlier call] ' : ''}reasons=${JSON.stringify(r.reasons)} notes=${JSON.stringify(r.notes)} flags=${JSON.stringify(r.flags)} cost=₹${r.cost_inr}`);
}
