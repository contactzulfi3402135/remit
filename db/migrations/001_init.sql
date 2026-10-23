-- Remit's own memory. The ledger of record lives in remit_ledger
-- (owned by the Go service); agent state is scoped so evaluation
-- episodes never pollute live behaviour.
create schema if not exists remit;

create table if not exists remit.runs (
  id           bigint generated always as identity primary key,
  kind         text not null,
  draft_model  text not null,
  scope        text not null default 'live',
  note         text not null default '',
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}'::jsonb
);

create table if not exists remit.calls (
  id            bigint generated always as identity primary key,
  run_id        bigint references remit.runs(id),
  stage         text not null,
  model         text not null,
  invoice_ids   text[] not null default '{}',
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(12,6) not null default 0,
  ms            integer not null default 0,
  error         text,
  at            timestamptz not null default now()
);
create index if not exists remit_calls_run_idx on remit.calls (run_id);

create table if not exists remit.decisions (
  id          bigint generated always as identity primary key,
  run_id      bigint references remit.runs(id),
  scope       text not null default 'live',
  invoice_id  text not null,
  world_day   integer not null,
  segment     text not null,
  playbook    text not null default '',
  action      text not null,
  outcome     text not null,
  why         text not null,
  at          timestamptz not null default now()
);
create index if not exists remit_decisions_invoice_idx on remit.decisions (invoice_id, at desc);

create table if not exists remit.queue (
  id          bigint generated always as identity primary key,
  scope       text not null default 'live',
  invoice_id  text not null,
  kind        text not null,
  why         text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolution  text
);
create index if not exists remit_queue_open_idx on remit.queue (scope, resolved_at, created_at);

create table if not exists remit.state (
  key   text primary key,
  value text not null
);

-- Playbook experimentation memory: per segment, which lawful contact
-- playbook actually produced payments. This is Remit's learning loop.
create table if not exists remit.playbook_stats (
  scope     text not null,
  segment   text not null,
  playbook  text not null,
  contacts  integer not null default 0,
  rewards   integer not null default 0,
  primary key (scope, segment, playbook)
);

-- One row per debtor-facing contact. This is the attribution ledger:
-- segment/playbook are frozen at contact time, and a contact can earn
-- at most one binary reward (a payment inside the attribution window).
create table if not exists remit.contact_trials (
  scope                    text not null,
  contact_event_id         bigint not null,
  invoice_id               text not null,
  world_day                integer not null,
  segment                  text not null,
  playbook                 text not null,
  rewarded_payment_event_id bigint,
  rewarded_at              timestamptz,
  created_at               timestamptz not null default now(),
  primary key (scope, contact_event_id)
);
create index if not exists remit_contact_trials_invoice_idx
  on remit.contact_trials (scope, invoice_id, world_day desc, contact_event_id desc);

create table if not exists remit.suppressions (
  scope      text not null,
  invoice_id text not null,
  reason     text not null,
  at         timestamptz not null default now(),
  primary key (scope, invoice_id)
);
