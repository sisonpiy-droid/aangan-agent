// Record revenue: marks a lead as a signed project with its value, so it moves to "Revenue generated".
//   npm run mark:signed -- <lead id> <amount in rupees>      e.g. npm run mark:signed -- 12 2400000
//   npm run mark:signed -- <lead id> --undo                  takes the signature back off
import * as store from '../lib/store.js';

const [id, amount] = process.argv.slice(2);
if (!/^\d+$/.test(id ?? '') || (amount !== '--undo' && !(Number(amount) > 0))) { console.error('Usage: npm run mark:signed -- <lead id> <amount in rupees> | --undo'); process.exit(1); }
const row = await store.findLead({ id });
if (!row) { console.error('No lead with id ' + id); process.exit(1); }
const lead = { ...row.lead };
if (amount === '--undo') { delete lead.deal_value; delete lead.signed_at; if (lead.stage === 'converted') delete lead.stage; }
else Object.assign(lead, { stage: 'converted', deal_value: Number(amount), signed_at: new Date().toISOString() });
await store.save({ lead }, row.id);
console.log(amount === '--undo' ? `lead ${id}: signature removed` : `lead ${id} (${lead.name ?? lead.enquiry_ref ?? 'no name'}): signed for ₹${Number(amount).toLocaleString('en-IN')}`);
