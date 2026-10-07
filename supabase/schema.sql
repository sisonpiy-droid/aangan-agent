-- Aangan AI front desk. Supabase = backend system of record. Run once in the SQL editor (safe to re-run).

-- One row per enquiry (a redial within 30 min is merged into the same row).
create table if not exists public.leads (
  id                     bigint generated always as identity primary key,
  created_at             timestamptz not null default now(),
  call_ids               text[] not null default '{}',  -- Vaani call ids
  phone                  text,                           -- E.164 caller ID, null if withheld
  call_started_at        timestamptz not null,
  duration_sec           int not null default 0,
  transcript             jsonb not null default '[]',   -- [{role, text, atMs}]
  lead                   jsonb not null default '{}',   -- Gemini-extracted fields (lib/extract.js)
  -- qualification (lib/rules.js is the only writer of these)
  status                 text not null check (status in ('QUALIFIED','NEEDS_REVIEW','DECLINED','ESCALATE')),
  reasons                text[] not null default '{}',
  notes                  text[] not null default '{}',
  flags                  text[] not null default '{}',  -- PRICING_LEAK / SLOT_PROMISED (agent check)
  -- usage / cost
  cost_inr               numeric(10,2) not null default 0,
  llm_tokens_in          int not null default 0,
  llm_tokens_out         int not null default 0,
  recording_url          text,
  -- Telegram handoff (each message is also an events row)
  notified_at            timestamptz,
  -- HubSpot
  hubspot_contact_id     text,
  hubspot_deal_id        text,
  hubspot_url            text,
  hubspot_synced_at      timestamptz,
  hubspot_error          text,                           -- non-null = failed sync, shown + retryable on the dashboard
  -- Calendly
  calendly_booking_url   text,
  consultation_status    text check (consultation_status in ('link_ready','booked','rescheduled','canceled')),
  consultation_start     timestamptz,
  consultation_end       timestamptz,
  calendly_event_id      text,
  calendly_invitee_id    text,
  calendly_cancel_reason text
);

create index if not exists leads_phone_started on public.leads (phone, call_started_at desc);
create index if not exists leads_started       on public.leads (call_started_at desc);
create index if not exists leads_call_ids      on public.leads using gin (call_ids);
create index if not exists leads_sync_failed   on public.leads (call_started_at desc) where hubspot_error is not null;
create index if not exists leads_invitee       on public.leads (calendly_invitee_id) where calendly_invitee_id is not null;

-- Append-only: raw Vaani / Calendly webhooks, rules decisions, HubSpot failures, Telegram messages.
-- The unique key makes webhook retries harmless.
create table if not exists public.events (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  source       text not null,            -- vaani | calendly | rules | hubspot | telegram
  type         text not null,            -- call.completed, invitee.created, decided, sync_failed, sent, unmatched…
  external_id  text,                     -- call id / invitee URI / chat:message id
  lead_id      bigint references public.leads(id) on delete set null,
  payload      jsonb not null default '{}',
  unique (source, type, external_id)
);
create index if not exists events_lead on public.events (lead_id, created_at);
create index if not exists events_type on public.events (type, created_at desc);

-- RLS on with no policies: only the server's service-role key can read or write.
alter table public.leads  enable row level security;
alter table public.events enable row level security;
