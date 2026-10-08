// One-time Calendly setup: lists your event types (pick the consultation link) and
// subscribes our webhook to invitee.created + invitee.canceled. Safe to re-run.
// npm run calendly:setup   (needs CALENDLY_TOKEN, PUBLIC_BASE_URL, CALENDLY_WEBHOOK_SIGNING_KEY in .env)

const { CALENDLY_TOKEN: TOKEN, PUBLIC_BASE_URL: BASE, CALENDLY_WEBHOOK_SIGNING_KEY: SIGNING_KEY } = process.env;
if (!TOKEN) { console.error('Set CALENDLY_TOKEN (a Calendly personal access token) in .env first.'); process.exit(1); }

async function cal(path, method = 'GET', body) {
  const res = await fetch(`https://api.calendly.com${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const me = await cal('/users/me');
if (me.status !== 200) { console.error(`Calendly token rejected (${me.status}).`); process.exit(1); }
const user = me.data.resource.uri, org = me.data.resource.current_organization;

const types = await cal(`/event_types?user=${encodeURIComponent(user)}&active=true&count=100`);
console.log('Active event types — put the consultation one(s) in .env:');
for (const t of types.data?.collection ?? []) console.log(`  ${t.name} (${t.duration} min): ${t.scheduling_url}`);
console.log('  → CALENDLY_EVENT_URL_RESIDENTIAL=<url>   and optionally CALENDLY_EVENT_URL_COMMERCIAL=<url>\n');

if (!BASE || !SIGNING_KEY) { console.log('Set PUBLIC_BASE_URL and CALENDLY_WEBHOOK_SIGNING_KEY, then re-run to create the webhook (optional: booking links work without it).'); process.exit(0); }
const url = `${BASE.replace(/\/$/, '')}/api/calendly-webhook`;
// Round-robin team event types are hosted by whichever designer is next, so their bookings only reach an
// organization-wide webhook. Set CALENDLY_WEBHOOK_SCOPE=organization for that (needs a Teams plan).
const scope = process.env.CALENDLY_WEBHOOK_SCOPE === 'organization' ? 'organization' : 'user';
const subs = await cal(`/webhook_subscriptions?organization=${encodeURIComponent(org)}&scope=${scope}${scope === 'user' ? `&user=${encodeURIComponent(user)}` : ''}`);
if ((subs.data?.collection ?? []).some(s => s.callback_url === url && s.state === 'active')) {
  console.log(`Webhook already active: ${url}\nSet CALENDLY_WEBHOOKS_ENABLED=true (automatic booking tracking).`);
} else {
  const r = await cal('/webhook_subscriptions', 'POST', { url, events: ['invitee.created', 'invitee.canceled'], organization: org, ...(scope === 'user' ? { user } : {}), scope, signing_key: SIGNING_KEY });
  if (r.status === 201) console.log(`Webhook created: ${url}\nSet CALENDLY_WEBHOOKS_ENABLED=true (automatic booking tracking).`);
  else console.log(`Could not create the webhook (${r.status}: ${r.data?.message ?? JSON.stringify(r.data)}).
Calendly webhooks need a paid plan (Standard or above). Nothing breaks: leave CALENDLY_WEBHOOKS_ENABLED=false.
Booking links still go out; designers update booking status on the HubSpot deal by hand.`);
}
