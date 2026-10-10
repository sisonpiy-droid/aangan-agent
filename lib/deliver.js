// Sends the Calendly booking link to the caller by SMS and email as soon as the call ends (qualified leads only).
// Vaani has no send API, so this runs from our backend. Each channel is optional: SMS through Twilio, email through Resend.
// LINK_COPY_TO (the owner's own address) also gets a copy of every link sent, so the studio sees what went out.
// Returns null when neither is set up (the designer then sends the link from the Telegram note, as before).
import { eventExists, logEvent } from './store.js';
import { e164 } from './hubspot.js';

const env = k => process.env[k];
export const smsConfigured = () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM'));
export const emailConfigured = () => !!(env('RESEND_API_KEY') && env('MAIL_FROM'));

const when = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + ' IST';
export const isBooked = row => ['booked', 'rescheduled'].includes(row.consultation_status) && !!row.lead?.booking?.start;
const closest = row => (row.lead.booking.exact ? '' : ' This is the closest free time to the one you asked for.');
const hello = row => (row.lead?.name ? `Hi ${row.lead.name.split(' ')[0]}` : 'Hi');
// Never a price, never a named slot: the caller picks a real slot from the link.
export const smsText = row => (isBooked(row)
  ? `${hello(row)}, your consultation with Aangan Studio is booked for ${when(row.lead.booking.start)}.${closest(row)}${row.lead.booking.meetUrl ? ` Join on Google Meet: ${row.lead.booking.meetUrl}` : ''}${row.lead.booking.rescheduleUrl ? ` Need another time? ${row.lead.booking.rescheduleUrl}` : ''}`
  : `${hello(row)}, thank you for calling Aangan Studio. Choose a consultation time that suits you here: ${row.calendly_booking_url}`);
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const where = row => (row.lead?.locality ? ` about your project in ${row.lead.locality}` : ' about your project');
export const EMAIL_SUBJECT = 'Thank you for calling Aangan Studio';
export const subjectFor = row => (isBooked(row) ? 'Your consultation with Aangan Studio is confirmed' : EMAIL_SUBJECT);
export const emailText = row => (isBooked(row) ? bookedText(row) : askText(row));
const bookedText = row => `${hello(row)},

Thank you for calling Aangan Studio. Your free consultation is booked for ${when(row.lead.booking.start)}.${closest(row)}

${row.lead.booking.meetUrl ? `Join on Google Meet: ${row.lead.booking.meetUrl}\n\n` : ''}Your designer will go through the scope, the materials and the pricing with you in detail, with no obligation.${row.lead.booking.rescheduleUrl ? `\n\nNeed a different time? ${row.lead.booking.rescheduleUrl}` : ''}

We look forward to meeting you.

Warm regards,
The team at Aangan Studio, Pune`;
const askText = row => `${hello(row)},

Thank you for calling Aangan Studio. It was a pleasure speaking with you${where(row)}, and we have noted everything you told us.

The next step is a free consultation with one of our designers. They will go through the scope, the materials and the pricing with you in detail, with no obligation.

Please choose a time that suits you here. The calendar shows our real availability, so you can pick whichever slot works best:
${row.calendly_booking_url}

We look forward to meeting you.

Warm regards,
The team at Aangan Studio, Pune`;
export const emailHtml = row => (isBooked(row) ? bookedHtml(row) : askHtml(row));
const btn = (href, label) => `<p style="margin:0 0 22px"><a href="${esc(href)}" style="display:inline-block;background:#b5532f;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 26px;border-radius:999px">${label}</a></p>`;
const bookedHtml = row => { const b = row.lead.booking; return `<!doctype html><html><body style="margin:0;background:#faf6f0;padding:24px 12px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#2a2118"><div style="max-width:560px;margin:0 auto;background:#fffdf9;border:1px solid #eadfd0;border-radius:16px;padding:32px 30px"><div style="font:600 22px Georgia,serif;color:#b5532f;margin-bottom:18px">Aangan Studio</div><p style="font-size:16px;line-height:1.55;margin:0 0 14px">${esc(hello(row))},</p><p style="font-size:16px;line-height:1.55;margin:0 0 14px">Thank you for calling Aangan Studio. Your <b>free consultation</b> is booked for</p><p style="font:600 24px Georgia,serif;margin:0 0 14px">${esc(when(b.start))}</p>${b.exact ? '' : `<p style="font-size:14px;color:#7a6e60;margin:0 0 18px">This is the closest free time to the one you asked for.</p>`}${b.meetUrl ? btn(b.meetUrl, 'Join on Google Meet') : ''}<p style="font-size:16px;line-height:1.55;margin:0 0 18px">Your designer will go through the scope, the materials and the pricing with you in detail, with no obligation.</p>${b.rescheduleUrl ? `<p style="font-size:14px;color:#7a6e60;margin:0 0 22px">Need a different time? <a href="${esc(b.rescheduleUrl)}" style="color:#b5532f">Change it here</a>.</p>` : ''}<p style="font-size:16px;line-height:1.55;margin:0">We look forward to meeting you.<br><br>Warm regards,<br><b>The team at Aangan Studio, Pune</b></p></div></body></html>`; };
const askHtml = row => `<!doctype html><html><body style="margin:0;background:#faf6f0;padding:24px 12px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#2a2118">
<div style="max-width:560px;margin:0 auto;background:#fffdf9;border:1px solid #eadfd0;border-radius:16px;padding:32px 30px">
<div style="font:600 22px Georgia,serif;color:#b5532f;margin-bottom:18px">Aangan Studio</div>
<p style="font-size:16px;line-height:1.55;margin:0 0 14px">${esc(hello(row))},</p>
<p style="font-size:16px;line-height:1.55;margin:0 0 14px">Thank you for calling Aangan Studio. It was a pleasure speaking with you${esc(where(row))}, and we have noted everything you told us.</p>
<p style="font-size:16px;line-height:1.55;margin:0 0 22px">The next step is a <b>free consultation</b> with one of our designers. They will go through the scope, the materials and the pricing with you in detail, with no obligation.</p>
<p style="margin:0 0 22px"><a href="${esc(row.calendly_booking_url)}" style="display:inline-block;background:#b5532f;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 26px;border-radius:999px">Choose a time that suits you</a></p>
<p style="font-size:14px;line-height:1.5;color:#7a6e60;margin:0 0 22px">The calendar shows our real availability, so you can pick whichever slot works best. If the button does not open, copy this link:<br><a href="${esc(row.calendly_booking_url)}" style="color:#b5532f;word-break:break-all">${esc(row.calendly_booking_url)}</a></p>
<p style="font-size:16px;line-height:1.55;margin:0">We look forward to meeting you.<br><br>Warm regards,<br><b>The team at Aangan Studio, Pune</b></p>
</div></body></html>`;

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

const testSender = () => /@resend\.dev>?$/i.test(env('MAIL_FROM') ?? '');
const email = (row) => {
  const to = row.lead?.email;
  if (!emailConfigured()) return 'skipped: email not set up';
  if (testSender()) return 'skipped: sender domain not verified yet';
  if (!to) return 'skipped: no email given';
  return once('email', row, async () => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env('MAIL_FROM'), to: [to], subject: subjectFor(row), text: emailText(row), html: emailHtml(row) }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 100)}`);
  });
};

const copy = (row, outcome) => {
  const to = env('LINK_COPY_TO');
  if (!to || !emailConfigured()) return undefined;
  return once('copy', row, async () => {
    const who = row.lead?.name ?? 'a caller';
    const text = `The booking link for ${who} (lead ${row.id}) is ready.\n\nSMS: ${outcome.sms}\nEmail: ${outcome.email}\n\nMessage the caller gets:\n${smsText(row)}\n\nLead page: ${env('PUBLIC_BASE_URL') ? `${env('PUBLIC_BASE_URL').replace(/\/$/, '')}/?lead=${row.id}` : '(set PUBLIC_BASE_URL)'}`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env('MAIL_FROM'), to: [to], subject: `Booking link: ${who}`, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 100)}`);
  });
};

export async function sendLink(row) {
  if (!smsConfigured() && !emailConfigured()) return null;
  if (!row.calendly_booking_url) return null;
  const out = { sms: await sms(row), email: await email(row) };
  const owner = await copy(row, out);
  return { ...out, ...(owner ? { owner } : {}), at: new Date().toISOString() };
}
