# Aangan AI front desk (MESA Case 03)

Every call to Aangan Studio is answered by a Vaani Voice voice agent, 24/7. After the call the backend
extracts the enquiry, **qualifies it with deterministic rules**, records it in Supabase, syncs it to
HubSpot, gives qualified callers a Calendly link to book a real consultation slot, and hands off to
humans on Telegram.

## Architecture

```
            ┌──────────── call ────────────┐
Caller ──► Vaani Voice (voice agent, en/hi) │
            └─ call_started / call_postprocessing (?key=) ─► /api/call-ended ─(waitUntil)─► processCall()
                                                         1. Gemini: transcript → lead JSON   (extraction only)
                                                         2. merge a redial from the same number ≤ 30 min
                                                         3. lib/rules.js → status            (sole authority)
                                                         4. scan agent lines: PRICING_LEAK / SLOT_PROMISED
                                                         5. Supabase leads + events          (system of record)
                                                         6. Calendly booking link (utm_content = lead id)
                                                         7. HubSpot contact (by phone) + deal (by lead id)
                                                         8. Telegram handoff (with HubSpot + booking links)
Caller ──► Calendly page (real availability) ──► invitee.created / invitee.canceled (signed)
            └──► /api/calendly-webhook ─► match lead ─► Supabase ─► HubSpot (stage, times) ─► Telegram confirmation
Nikhil ──► dashboard (/api/stats, passcode) ─► "Retry failed syncs" ─► /api/retry-sync
```

| Component | Owns | Never does |
|---|---|---|
| **Vaani Voice** | inbound calls, voice conversation (English, Hindi), post-call webhooks with transcript and entities | decide a status; quote a price; state availability |
| **Gemini** | transcript → structured lead | decide a status |
| **`lib/rules.js`** | `QUALIFIED` · `NEEDS_INFO` (live only) · `NEEDS_REVIEW` · `DECLINED` · `ESCALATE` | — |
| **Supabase** | calls, transcripts, leads, statuses, HubSpot IDs, Calendly IDs, Telegram records, cost, audit trail | — |
| **HubSpot** | CRM + sales pipeline: contact per phone, deal per lead | hold any qualification logic |
| **Calendly** | consultation availability and booking (status tracked automatically only with webhooks) | — |
| **Telegram** | human handoff | — |

## Statuses (lib/rules.js)

| Status | Meaning | HubSpot stage | Telegram |
|---|---|---|---|
| `QUALIFIED` | passes all five qualified.md criteria | Qualified → Consultation booked | designers, with the booking link |
| `NEEDS_REVIEW` | undocumented policy, an unanswered criterion, or one soft failure | Needs review | none (dashboard + HubSpot), **except** a failed/dropped call with caller ID → designers to call back |
| `DECLINED` | a clear hard disqualifier, or 2+ soft failures | Declined (closed lost) | none |
| `ESCALATE` | existing client (complaint, ongoing project) | contact only, no deal | Nikhil |
| `NEEDS_INFO` | during a call only: ask the one question for an unclear criterion | — | — |

**Hard disqualifiers** (the transcripts' operating behaviour): advice/decor/Vastu/sourcing only ·
restaurant/hotel/retail/gym · outside Pune/PCMC · completion needed in < 8 weeks · a volunteered budget
below 50% of the lowest pricing.md estimate. **Soft failures:** caller isn't the decision-maker and not
authorised · site not available within 10 weeks. Uncertain budget or decision-maker → a note, never a push.

`HIGH_VALUE` (volunteered budget, or the lowest estimate, ≥ ₹30L) is a **priority signal only**
(HubSpot `hs_priority = high`, a ⭐ on Telegram). It never changes a status; a test enforces this.

**Never autonomous:** quoting or inventing a price (the agent only says the pricing.md line; a post-call
scan flags `PRICING_LEAK`) · stating or promising a slot (availability only ever comes from Calendly; a
scan flags `SLOT_PROMISED`) · deciding undocumented policy (→ `NEEDS_REVIEW`) · quietly rejecting an
ambiguous lead (unknowns → review; every decline has a reason code on the dashboard and in HubSpot).

## Source-policy ambiguities (decided, not hidden)

1. **Timeline: 6 weeks vs 8–10 weeks.** services.md says Aangan can't start a project that must be ready
   in under 6 weeks; qualified.md says the site must be available for execution within 8–10 weeks of the
   consultation, and that 3 weeks is impossible. **qualified.md is the authority** (it says "use this to decide").
   No combined formula. Completion needed in < 8 weeks → declined (T07, F08).
2. **"Within 8–10 weeks" read literally** would also reject callers whose site is free *later* (F06: execution from
   February 2027, about 20 weeks out, ₹35–40L, otherwise strong). That reading is unclear, so a site free more than
   10 weeks out is `NEEDS_REVIEW`, never an automatic decline.
3. **One failure vs two.** qualified.md says both "if it fails one, close gracefully" and "two or more criteria fail:
   decline". The transcripts decline single clear failures (T03 area, T04 advice, T10 budget). So: a clear hard
   disqualifier → declined; 2+ soft failures → declined; one soft failure → review.
4. **Commercial minimum size.** The front desk told T18 "500 sq ft minimum"; no document says so. Under 500 sq ft →
   `NEEDS_REVIEW` (`COMMERCIAL_UNDER_500_UNDOCUMENTED`). Over ~3,000 sq ft → review ("approximately").
5. **Founder's ask vs pricing.md.** Nikhil asked for per-sq-ft quotes on the phone; pricing.md forbids any number.
   pricing.md wins. Its rates are used only inside the rules to spot a clearly impossible volunteered budget.

All thresholds are named constants at the top of `lib/rules.js`, to tune with Nikhil after the first month.

## Integrations

### Vaani Voice
Platform: **Vaani Voice** (app.vaanivoice.ai, docs at docs.vaanivoice.ai/guides/webhook-setup). The adapter is `lib/vaani.js`.
- Webhook (Settings → Webhooks): `https://<app>/api/call-ended?key=<VAANI_WEBHOOK_SECRET>`. Vaani documents **no
  signature**, so the secret is in the URL (constant-time compare; missing/wrong key or an unset secret → 401). Keep
  that URL private.
- `call_started` → `{ room_name, phone_number }` is saved in `events`. That's where the **caller ID** comes from:
  `call_postprocessing` doesn't document a phone field (we use one if it's there).
- `call_postprocessing` → `data.{ call_id, room_name, call_duration (milliseconds), transcript (text: "[hh:mm:ss] AGENT: …
  USER: …"), entities {name, preferred_time}, summary, recording_url }` → parsed into AGENT/CALLER lines → pipeline.
  The reply is immediate; processing finishes in `waitUntil`.
- A call where the caller said nothing (failed or dropped; Vaani's `call_failed` is outbound-only) → empty transcript
  → the call-back path (Telegram to designers when there's a caller ID).
- `outbound-…` calls are ignored. Other events (`call_ended`, `user_picked_up_at`, transfers) are logged only.
  A repeated `call_postprocessing` is processed once (the call id is checked first).
- **To verify on the first real call:** that inbound `call_started` carries `phone_number` (the docs only show it on outbound).
  The raw event is in `events`; if it's missing, fetch the number from Vaani's call-history API.
- **No dependence on mid-call custom functions.** `/api/check-lead` is an optional extra. Don't enable Vaani's Cal.com
  integration or a `schedule_callback` tool: both book specific slots on the call.
- **Vaani's API has no SMS send**, so it can't text the Calendly link (see Calendly → delivery). WhatsApp is not used anywhere.
- No cost field is documented → cost = minutes × `VAANI_INR_PER_MIN` + Gemini tokens × rate.

### HubSpot (service key)
- Auth: `HUBSPOT_SERVICE_KEY` as a Bearer token. No legacy private app.
- **Contact** upsert on the unique custom property `aangan_phone_e164`; **deal** upsert on the unique `aangan_lead_id`
  (= Supabase `leads.id`), associated with the contact via the v4 default association. Re-running never duplicates.
- Escalations update the contact only. No caller ID → deal without a contact. Merging a redial can't clear a field
  that already has a value; status, reasons, stage and consultation fields are always overwritten.
- Failures: `hubspot_error` on the lead + an `events` row → dashboard banner → **Retry failed syncs**.
- Telegram is sent after the sync so it can link the record; if the sync fails, Telegram still goes out, marked.
- **Activity on the record** (`activityPlan` / `syncActivity`), created once each (the `events` table remembers what exists, so
  retries and Calendly updates never duplicate): a **Note** (Vaani's summary, why, next task, lead-page link), a **Call**
  (inbound, with the full transcript and the recording link in its body; `hs_call_recording_url` only takes direct audio files,
  so it isn't used) and a **Task**, all associated with the deal and contact (association IDs 214/202, 206/194, 216/204).
  An activity failure (for example a missing HubSpot scope) shows as `hubspot_error: activity: …` on the dashboard and is
  retried by **Retry failed syncs**.
- **Tasks** (`lib/tasks.js`, the same logic as the Telegram "Next task" line):

| Lead | Task | Due |
|---|---|---|
| `QUALIFIED` | Send consultation link (or "Book a consultation" if Calendly isn't set up) | 1 hour |
| `ESCALATE` | Call back existing client (on the contact; no deal) | 15 minutes |
| Failed/dropped call with caller ID | Call back caller | 15 minutes |
| `NEEDS_REVIEW` | Review AI lead (this is how review leads get seen, since they're not on Telegram) | 4 hours |
| `DECLINED` for a "not now" reason (`TIMELINE_TOO_SHORT`, `NOT_A_FULL_PROJECT`) | Re-contact | 5 weeks |
| Other `DECLINED` (area, budget, business type) | none | — |

- Board, saved views and a dashboard: the API can't create them, so [docs/HUBSPOT-DASHBOARD.md](docs/HUBSPOT-DASHBOARD.md)
  has the click-by-click steps.

HubSpot properties (group "AI Front Desk", created by `npm run hubspot:setup`):

| Object | Property | Value |
|---|---|---|
| Contact | `aangan_phone_e164` (unique) · `phone` | caller ID, E.164 |
| Contact | `firstname` · `lastname` · `email` | name split at the first space · email only if volunteered |
| Contact | `city` · `aangan_locality` | Pune / PCMC / Outside service area · locality as said |
| Contact | `aangan_source` · `aangan_last_status` · `aangan_consultation_status` | "AI Front Desk" · latest status · Calendly state |
| Deal | `dealname` · `pipeline` · `dealstage` | "Kothrud · full home · Priya" · AI Front Desk · Qualified / Needs review / Consultation booked / Declined |
| Deal | `amount` · `hs_priority` | volunteered budget max · `high` when HIGH_VALUE |
| Deal | `aangan_lead_id` (unique) | Supabase lead id (transcript reference) |
| Deal | `aangan_qualification_status` · `aangan_qualification_reason` | from rules.js |
| Deal | `aangan_project_type` · `aangan_segment` · `aangan_property_type` · `aangan_service_required` | full home / partial / single room / office fitout · residential/commercial · apartment/villa/… · design and execution/… |
| Deal | `aangan_carpet_sqft` · `aangan_rooms` · `aangan_deadline` · `aangan_site_available` | |
| Deal | `aangan_budget_min` · `aangan_budget_max` · `aangan_decision_maker` · `aangan_preferred_slot` | volunteered only · · caller's preference, not a booking |
| Deal | `aangan_ai_notes` · `aangan_agent_flags` · `aangan_call_ids` · `aangan_recording_url` · `aangan_source` | |
| Deal | `aangan_calendly_booking_url` · `aangan_consultation_status` · `aangan_consultation_start` · `aangan_consultation_end` · `aangan_calendly_event_id` · `aangan_calendly_invitee_id` · `aangan_cancel_reason` | from Calendly |

### Calendly (capability-aware)

**Core v1, which works on any Calendly plan:** qualified lead → Calendly booking link. We never compute availability.
Each `QUALIFIED` lead (and each `NEEDS_REVIEW` lead, for a human to send later) gets a link to the consultation event
type (a commercial one if configured) with `utm_source=aangan_ai_front_desk`, `utm_content=<lead id>` and the
name/email prefilled. `consultation_status = link_ready`.

**Delivery to the caller.** Vaani's API has no way to send a text, so these are the options:

| Option | Status |
|---|---|
| **One-tap email** (`mailto:` with the link prefilled) when the caller gave an address; the agent offers it once before closing | ✅ built, still one tap by a designer |
| Link also on the HubSpot deal and in the task | ✅ built |
| **Fully automatic email via HubSpot** | ❌ not possible here: sending email from HubSpot's API needs the paid Marketing Hub transactional add-on or a Sales Hub workflow/sequence |

On the call the agent says exactly: *"A designer will send you a link where you can choose a convenient
consultation time."* It never names or promises a time; only Calendly's own page shows availability.

**Round-robin across designers** (needs a Calendly **Teams** plan; no code change): in Calendly create a **Team** →
**Round robin** event type with the designers as hosts, copy its link into `CALENDLY_EVENT_URL_RESIDENTIAL`, and set
`CALENDLY_WEBHOOK_SCOPE=organization` before running `npm run calendly:setup` for automatic tracking, because team
bookings only reach an organization-wide webhook.

Booking tracking depends on whether your Calendly account has webhook access (paid plans):

| `CALENDLY_WEBHOOKS_ENABLED` | Booking link | Booking / reschedule / cancel tracking |
|---|---|---|
| `true` (webhook created by `npm run calendly:setup`) | ✅ | **Automatic:** webhook → Supabase → HubSpot (stage + times) → Telegram confirmation |
| `false` (default, or no webhook access) | ✅ | **Manual:** designers update the HubSpot deal when the caller books. We never write consultation fields to HubSpot, so a designer's edits aren't overwritten. Telegram notes and the dashboard say "tracked by hand". |

Nothing fails without webhooks: the link, HubSpot sync, Telegram handoff and dashboard all work. `calendly:setup`
reports which mode you're in.

When webhooks are on (`POST /api/calendly-webhook`, events `invitee.created` + `invitee.canceled`):
- Signature `Calendly-Webhook-Signature: t=…,v1=…` (HMAC-SHA256 of `t.body`, 5-minute replay window).
- Matching: `utm_content` → lead; else the previous invitee (reschedules); else the invitee's SMS-reminder phone
  number; else **unmatched** → Telegram to designers + dashboard banner.
- `booked` → Supabase (`consultation_status`, start/end, event + invitee IDs) → HubSpot stage "Consultation booked"
  → Telegram "✅ booked". Reschedule (cancel with `rescheduled: true`, then a new invitee with `old_invitee`) →
  `rescheduled` with the new time → Telegram "🔁". Cancel → `canceled` + reason → deal back to Qualified → Telegram "❌".
  A late cancel for an old invitee changes nothing. A duplicate delivery is processed once (the `events` table).

### Telegram

| Trigger | To | Contains |
|---|---|---|
| `QUALIFIED` | designers group | **Next task**, Vaani's summary, full brief, booking link with a one-tap email button, HubSpot + lead-page links, and the **full transcript as an attached `.txt`** (a reply to the note) |
| `ESCALATE` | Nikhil | the same: next task (call back within 15 min), summary, transcript file |
| Failed or dropped call **with caller ID** | designers group | 📞 CALL BACK + tap-to-call number, next task |
| Failed call **without** caller ID | none | (dashboard + HubSpot "Needs review") |
| Consultation booked / rescheduled / canceled (webhooks on) | designers group | caller, time (IST) or reason, HubSpot link |
| Calendly booking that matches no call (webhooks on) | designers group | invitee details, "link by hand" |
| `NEEDS_REVIEW`, `DECLINED` | none | (HubSpot + dashboard) |

Every message sent is recorded in `events` (`source = telegram`, `external_id = chat:message_id`). If Telegram
rejects the formatting of a note, it is resent as plain text with the links written out, so a handoff is never lost.

**Weekly digest to Nikhil** (`api/weekly-digest.js`, Vercel Cron `30 3 * * 1` = Monday 09:00 IST, authenticated by
`CRON_SECRET`): calls answered (and the change on last week), after-hours share, qualified / review / declined /
escalated, consultation numbers, top decline reasons, median handoff time, **what the tool cost** (total, per call,
per qualified lead), qualified pipeline value, and any price/slot flags or failed syncs. These are the numbers he used to pull by hand.

**Lead page** (`/?lead=<id>`, same passcode as the dashboard, linked from every Telegram note and HubSpot Note): Vaani's
summary, the next task, everything the AI captured, the full transcript, the links, and the audit timeline.

### Supabase
- `leads`: one row per enquiry: transcript, extracted lead, status/reasons/notes/flags, cost and tokens,
  `notified_at`, HubSpot IDs/URL/sync state, Calendly link/status/start/end/event/invitee/cancel reason.
- `events`: append-only raw Vaani and Calendly payloads, rules decisions, HubSpot failures and the Notes/Calls/Tasks
  created, Telegram messages, unmatched bookings. `unique (source, type, external_id)` makes webhook retries harmless.
- RLS on with no policies: only the server's service-role key can read or write.

## Environment variables

See `.env.example`. **Secrets** (never in the repo or in chat): `VAANI_WEBHOOK_SECRET`, `GEMINI_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `HUBSPOT_SERVICE_KEY`, `CALENDLY_TOKEN`, `CALENDLY_WEBHOOK_SIGNING_KEY`,
`TELEGRAM_BOT_TOKEN`, `DASHBOARD_PASSCODE`, `CHECK_LEAD_SECRET`, `CRON_SECRET`. `npm run secrets` generates `VAANI_WEBHOOK_SECRET`,
`CALENDLY_WEBHOOK_SIGNING_KEY`, `DASHBOARD_PASSCODE`, `CHECK_LEAD_SECRET` and `CRON_SECRET`.
**Not secret:** URLs, IDs, chat IDs, rates.

## Setup

1. `npm install`, then `cp .env.example .env` and `npm run secrets`.
2. **Supabase:** run `supabase/schema.sql` in the SQL editor. Copy the project URL and service-role key into `.env`.
3. **HubSpot:** create a service key with scopes `crm.objects.contacts.read/write`, `crm.objects.deals.read/write`,
   `crm.schemas.contacts.write`, `crm.schemas.deals.write`. Put it in `.env` as `HUBSPOT_SERVICE_KEY`, run
   `npm run hubspot:setup`, and copy the printed IDs into `.env`.
4. **Telegram:** create a bot with @BotFather, add it to the designers group, and put the bot token, group chat ID and
   Nikhil's chat ID in `.env`.
5. **Deploy** to Vercel. Copy every `.env` value into the Vercel project and set `PUBLIC_BASE_URL` to the deployed URL.
6. **Calendly:** create a personal access token and a consultation event type (ideally with the "text reminder" phone
   field on), put the token in `.env`, run `npm run calendly:setup`, and copy the event type URL into
   `CALENDLY_EVENT_URL_RESIDENTIAL` (and `_COMMERCIAL` if separate). *Optional, paid plans only:* run it again to create
   the webhook, then set `CALENDLY_WEBHOOKS_ENABLED=true`.
7. **Vaani Voice:** paste `prompt/agent.md` into the agent (greeting "Hello, Aangan Studio. How can I help you today?",
   extraction fields `name` and `preferred_time` with no defaults, no `schedule_callback` tool, no Cal.com integration),
   attach the inbound number in Telephony, and in **Settings → Webhooks** add
   `https://<app>/api/call-ended?key=<VAANI_WEBHOOK_SECRET from .env>`.

## Run and test

```
npm test                            rules, HubSpot sync, Calendly flow, guardrails — no network
npm run simulate -- T01 T17a T17b   real pipeline on the case transcripts (offline fixtures if no GEMINI_API_KEY)
npm run test:live                   Gemini extraction on the real transcripts vs hand-written leads (costs a little)
npm run dev                         dashboard + API on http://localhost:3400 (memory store, demo data, passcode "demo")
```

## Extending to a web form (not built)

A web form is a lead that skips extraction (its fields map one-to-one) and feeds the same `processCall()`.
The rules, HubSpot, Calendly, Telegram and the dashboard stay unchanged.

