-- Pandora storage schema (Supabase Postgres / hot store).
-- Run in the Supabase SQL editor, or as a migration.

create extension if not exists "pgcrypto";

-- ── events: hot, immediately queryable ───────────────────────────────────
create table if not exists events (
  id              bigint generated always as identity primary key,
  event_id        uuid        not null unique,        -- idempotency key (from SDK)
  source         text        not null,
  scope           text        not null check (scope in ('product_improvement','model_training')),
  type            text        not null,
  user_id         text        not null,               -- pseudonymous; never PII
  session_id      text,
  ts              timestamptz not null,               -- client event time
  received_at     timestamptz not null default now(),
  schema_version  int         not null default 1,
  data            jsonb       not null default '{}'::jsonb,
  context         jsonb       not null default '{}'::jsonb,
  compacted_at    timestamptz                          -- set once written to R2 cold
);

create index if not exists events_source_ts_idx on events (source, ts desc);
create index if not exists events_type_idx        on events (type);
create index if not exists events_user_idx         on events (user_id);
create index if not exists events_scope_idx        on events (scope);
create index if not exists events_uncompacted_idx  on events (id) where compacted_at is null;
create index if not exists events_data_gin         on events using gin (data);

-- ── rejections: validation + processing failures (audit / debugging) ─────
create table if not exists rejections (
  id          bigint generated always as identity primary key,
  event_id    uuid,
  source     text,
  type        text,
  stage       text        not null check (stage in ('validation','processing')),
  reason      text        not null,
  raw         jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists rejections_created_idx on rejections (created_at desc);

-- ── opt_outs: append-only grant/revoke log (the source of truth) ─────────
-- model_training is default-on. Revocation is a new row, never an update.
-- The SDK resolver reads the derived state below: no row means allowed, latest
-- revoke means opted out, latest grant means opted back in.
create table if not exists consent (
  id          bigint generated always as identity primary key,
  source     text        not null,
  user_id     text        not null,
  scope       text        not null check (scope in ('product_improvement','model_training')),
  action      text        not null check (action in ('grant','revoke')),
  created_at  timestamptz not null default now()
);

create index if not exists consent_lookup_idx on consent (source, user_id, scope, created_at desc);

-- latest action per (source, user, scope); granted = last action was 'grant'
create or replace view current_consent as
select distinct on (source, user_id, scope)
  source,
  user_id,
  scope,
  action = 'grant' as granted,
  created_at       as as_of
from consent
order by source, user_id, scope, created_at desc;

alter view current_consent set (security_invoker = true);

-- Back resolveConsent() in a source backend: select granted_scopes('nubia','u_123')
-- No consent row means allowed by default; the latest revoke removes a scope.
create or replace function granted_scopes(p_source text, p_user_id text)
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  with all_scopes(scope) as (
    values ('product_improvement'::text), ('model_training'::text)
  )
  select coalesce(array_agg(s.scope order by s.scope), '{}')
  from all_scopes s
  left join current_consent c
    on c.source = p_source
   and c.user_id = p_user_id
   and c.scope = s.scope
  where coalesce(c.granted, true)
$$;

revoke execute on function granted_scopes(text, text) from public, anon, authenticated;
grant execute on function granted_scopes(text, text) to service_role;

-- ── api_keys: per-source ingestion credentials ──────────────────────────
create table if not exists api_keys (
  id           bigint generated always as identity primary key,
  key_id       text        not null unique,           -- public: pk_<source>_xxx
  source      text        not null,
  secret       text        not null,                  -- HMAC secret. Encrypt at rest (KMS) in prod.
  name         text,
  active       boolean     not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists api_keys_active_idx on api_keys (key_id) where active and revoked_at is null;

-- ── datasets: versioned, provenance-stamped training cuts (Bloomberg/Scale) ─
-- Each row is one built dataset. The manifest records consent basis, sources,
-- types, time range, counts, and a content hash — the saleable/trainable
-- provenance. distributable is false for any internal (product_improvement) cut.
create table if not exists datasets (
  id              bigint generated always as identity primary key,
  dataset_id      uuid        not null unique,
  name            text        not null,
  scope           text        not null check (scope in ('product_improvement','model_training')),
  sources         text[]      not null,
  event_types     text[],
  from_ts         timestamptz,
  to_ts           timestamptz,
  row_count       bigint      not null default 0,
  schema_versions int[],
  format          text        not null,
  object_key      text        not null,                -- R2 location of the data
  manifest        jsonb       not null,
  content_sha256  text        not null,
  distributable   boolean     not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists datasets_created_idx on datasets (created_at desc);

-- RLS: every table here is written only by the service role (worker + ingestion
-- + dataset builder) and never touched by end users. Enable RLS with no public
-- policies, so the anon/auth keys are locked out; the service role bypasses RLS.
alter table events     enable row level security;
alter table rejections enable row level security;
alter table consent    enable row level security;
alter table api_keys   enable row level security;
alter table datasets   enable row level security;

drop policy if exists "No client access" on events;
create policy "No client access" on events
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "No client access" on rejections;
create policy "No client access" on rejections
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "No client access" on consent;
create policy "No client access" on consent
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "No client access" on api_keys;
create policy "No client access" on api_keys
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "No client access" on datasets;
create policy "No client access" on datasets
  for all to anon, authenticated
  using (false)
  with check (false);
