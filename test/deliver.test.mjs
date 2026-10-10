// A qualified call texts and emails the booking link by itself; anything else, or a missing channel, does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.SUPABASE_URL;
Object.assign(process.env, {
  QUIET: '1', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_DESIGNERS_CHAT_ID: 'designers', TELEGRAM_NIKHIL_CHAT_ID: 'nikhil',
  CALENDLY_EVENT_URL_RESIDENTIAL: 'https://calendly.com/aangan/consultation', CALENDLY_WEBHOOKS_ENABLED: 'false',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111', RESEND_API_KEY: 're_1', MAIL_FROM: 'Aangan <hi@aangan.example>',
});

const { processCall } = await import('../lib/pipeline.js');
const { normalize } = await import('../lib/extract.js');
const { nextTask } = await import('../lib/tasks.js');
const { formatNote } = await import('../lib/notify.js');

const calls = JSON.parse(readFileSync(new URL('./transcripts.json', import.meta.url)));
const fixtures = Object.fromEntries(JSON.parse(readFileSync(new URL('./leads.json', import.meta.url))).map((c) => [c.id, c.lead]));
const as = (id, extra = {}) => ({ extractFn: async () => ({ lead: normalize({ ...fixtures[id], ...extra }), tokens: { in: 0, out: 0 } }) });

let net = [], twilioFails = false, seq = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.twilio.com')) { net.push({ to: 'sms', body: Object.fromEntries(init.body), auth: init.headers.authorization }); return twilioFails ? new Response('blocked', { status: 400 }) : Response.json({ sid: 'SM1' }); }
  if (u.startsWith('https://api.resend.com')) { net.push({ to: 'email', body: JSON.parse(init.body) }); return Response.json({ id: 'em1' }); }
  if (u.startsWith('https://api.telegram.org')) { net.push({ to: 'telegram', text: typeof init.body === 'string' ? JSON.parse(init.body).text : '(file)' }); return Response.json({ ok: true, result: { message_id: ++seq } }); }
  throw new Error(`unexpected fetch ${u}`);
};
const call = (key, n) => ({ ...calls[key], id: `del-${key}-${++seq}`, fromNumber: `+9190000009${String(n).padStart(2, '0')}` });
const sent = (to) => net.filter((n) => n.to === to);

test('qualified: SMS to the caller ID and email to the address given, both with the booking link; the note says so and the task becomes a check', async () => {
  net = [];
  const row = await processCall(call('T01', 1), as('T01', { email: 'priya@example.com' }));
  assert.equal(row.status, 'QUALIFIED');
  const [sms] = sent('sms'), [mail] = sent('email');
  assert.equal(sms.body.To, '+919000000901');
  assert.equal(sms.body.From, '+15550001111');
  assert.match(sms.body.Body, /^Hi Priya, thank you for calling Aangan Studio\..*https:\/\/calendly\.com\/aangan\/consultation\?.*utm_content=/);
  assert.doesNotMatch(sms.body.Body, /₹|lakh|monday|tomorrow|\d{1,2}(am|pm)/i);
  assert.deepEqual(mail.body.to, ['priya@example.com']);
  assert.match(mail.body.text, /calendly\.com\/aangan\/consultation/);
  assert.equal(mail.body.subject, 'Thank you for calling Aangan Studio');
  assert.match(mail.body.html, /Choose a time that suits you/);
  assert.doesNotMatch(mail.body.text + mail.body.html, /test|₹|lakh|monday|tomorrow/i);
  const saved = (await (await import('../lib/store.js')).findLead({ id: row.id }));
  assert.equal(saved.lead.link_delivery.sms, 'sent');
  assert.equal(saved.lead.link_delivery.email, 'sent');
  assert.match(sent('telegram')[0].text, /Link sent to the caller by SMS and by email/);
  assert.match(nextTask(saved).line, /booking link was sent to the caller/);
});

test('no email given: SMS only. A redial or retry never texts twice', async () => {
  net = [];
  const row = await processCall(call('T11', 2), as('T11'));
  assert.equal(sent('sms').length, 1);
  assert.equal(sent('email').length, 0);
  const { sendLink } = await import('../lib/deliver.js');
  const again = await sendLink(await (await import('../lib/store.js')).findLead({ id: row.id }));
  assert.equal(again.sms, 'sent');
  assert.equal(sent('sms').length, 1, 'the ledger stops a second text');
});

test('a provider failure is visible and the designer is told to send it by hand', async () => {
  net = []; twilioFails = true;
  const row = await processCall(call('T14', 3), as('T14'));
  twilioFails = false;
  const saved = await (await import('../lib/store.js')).findLead({ id: row.id });
  assert.match(saved.lead.link_delivery.sms, /^failed: Twilio 400/);
  assert.match(formatNote(saved), /Link could not be sent by sms: send it by hand/);
  assert.match(nextTask(saved).line, /Send the Calendly link/);
});

test('not qualified: nothing is sent', async () => {
  net = [];
  await processCall(call('T03', 4), as('T03'));
  assert.equal(sent('sms').length + sent('email').length, 0);
});

test('owner copy: LINK_COPY_TO gets one email per link; Resend\'s test sender is never used on a caller', async () => {
  net = [];
  Object.assign(process.env, { LINK_COPY_TO: 'owner@aangan.example', MAIL_FROM: 'Aangan <onboarding@resend.dev>' });
  const row = await processCall(call('T01', 5), as('T01', { email: 'caller@example.com' }));
  const mails = sent('email');
  assert.equal(mails.length, 1, 'only the owner copy: the caller is skipped while the sender is the shared test address');
  assert.deepEqual(mails[0].body.to, ['owner@aangan.example']);
  assert.match(mails[0].body.subject, /^Booking link: Priya/);
  assert.match(mails[0].body.text, /calendly\.com\/aangan\/consultation/);
  assert.match(mails[0].body.text, /Email: skipped: sender domain not verified yet/);
  const saved = await (await import('../lib/store.js')).findLead({ id: row.id });
  assert.equal(saved.lead.link_delivery.owner, 'sent');
  assert.equal(saved.lead.link_delivery.email.startsWith('skipped'), true);
  delete process.env.LINK_COPY_TO; process.env.MAIL_FROM = 'Aangan <hi@aangan.example>';
});
