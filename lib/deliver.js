// Sends the Calendly booking link to the caller by SMS and email as soon as the call ends (qualified leads only).
// Vaani has no send API, so this runs from our backend. Each channel is optional: SMS through Twilio, email through Resend.
// Returns null when neither is set up (the designer then sends the link from the Telegram note, as before).
import { eventExists, logEvent } from './store.js';
import { e164 } from './hubspot.js';

const env = k => process.env[k];
export const smsConfigured = () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM'));
export const emailConfigured = () => !!(env('RESEND_API_KEY') && env('MAIL_FROM'));

const hello = row => (row.lead?.name ? `Hi ${row.lead.name.split(' ')[0]}` : 'Hi');
// Never a price, never a named slot: the caller picks a real slot from the link.
export const smsText = row => `${hello(row)}, thank you for calling Aangan Studio. Choose a consultation time that suits you here: ${row.calendly_booking_url}`;
export const emailText = row => `${hello(row)},\n\nThank you for calling Aangan Studio. Please choose a consultation time that suits you here:\n${row.calendly_booking_url}\n\nRegards,\nAangan Studio`;

async function once(channel, row, send) {
  const key = String(row.id);
  if (await eventExists('delivery', channel, key)) return 'sent'; // a redial or a retry never texts twice
  try {
    await send();
  } catch (err) {
    return `failed: ${String(err.message).slice(0, 120)}`;
  }
  await logEvent('delivery', channel, { externalId: key, leadId: row.id, payload: { channel } });
  return 'sent';
}

const sms = (row) => {
  const to = e164(row.phone);
  if (!smsConfigured()) return 'skipped: SMS not set up';
  if (!to) return 'skipped: no caller ID';
  return once('sms', row, async () => {
    const sid = env('TWILIO_ACCOUNT_SID');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: env('TWILIO_FROM'), Body: smsText(row) }),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 100)}`);
  });
};

const email = (row) => {
  const to = row.lead?.email;
  if (!emailConfigured()) return 'skipped: email not set up';
  if (!to) return 'skipped: no email given';
  return once('email', row, async () => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env('MAIL_FROM'), to: [to], subject: 'Your Aangan Studio design consultation', text: emailText(row) }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 100)}`);
  });
};

export async function sendLink(row) {
  if (!smsConfigured() && !emailConfigured()) return null;
  if (!row.calendly_booking_url) return null;
  return { sms: await sms(row), email: await email(row), at: new Date().toISOString() };
}
