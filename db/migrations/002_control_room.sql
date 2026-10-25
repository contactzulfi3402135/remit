-- Dashboard/control-room support. Current settings themselves live as
-- JSON in remit.state under settings:<scope>; this table is the audit
-- trail for every saved version. It contains no API keys or passwords.
create table if not exists remit.settings_history (
  id         bigint generated always as identity primary key,
  scope      text not null,
  settings   jsonb not null,
  changed_by text not null default 'dashboard',
  changed_at timestamptz not null default now()
);
create index if not exists remit_settings_history_scope_idx
  on remit.settings_history (scope, changed_at desc);
