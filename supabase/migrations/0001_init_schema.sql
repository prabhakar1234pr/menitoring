-- 0001_init_schema.sql
-- Core multi-tenant schema for the hourly activity tracker.
-- Every table carries user_id and is protected by Row-Level Security (user_id = auth.uid()).
-- Service-role (API ingest + pg_cron job) bypasses RLS automatically; it always sets user_id explicitly.
--
-- Scope: Slice 0 of PLAN.md — profiles, devices, events, targets, hourly_notes + RLS + signup trigger.
-- The pg_cron / pg_net scheduling lands in a later migration once the Vercel endpoint + secret exist.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- =====================================================================
-- profiles : 1:1 with auth.users, holds per-user IANA timezone
-- =====================================================================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  timezone   text not null default 'UTC',   -- IANA, e.g. 'Asia/Kolkata'
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- INSERTs handled by the signup trigger below (security definer); no insert policy needed.

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- devices : desktop-agent pairing. Only the SHA-256 hash of the token is stored.
-- =====================================================================
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists devices_user_id_idx on public.devices(user_id);

alter table public.devices enable row level security;

create policy "devices_select_own" on public.devices
  for select to authenticated using (user_id = auth.uid());
create policy "devices_insert_own" on public.devices
  for insert to authenticated with check (user_id = auth.uid());
create policy "devices_update_own" on public.devices
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "devices_delete_own" on public.devices
  for delete to authenticated using (user_id = auth.uid());

-- =====================================================================
-- events : raw activity blocks (agent + extension). Source for merge/dedupe.
-- =====================================================================
create table if not exists public.events (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  source           text not null check (source in ('agent','extension')),
  app              text,            -- 'Cursor', 'Chrome', 'Claude Desktop', generic exe name
  repo             text,            -- parsed from Cursor title
  file             text,            -- parsed from Cursor title
  url              text,            -- extension: exact URL
  title            text,            -- raw window / page title
  video_id         text,            -- extension: YouTube id
  problem          text,            -- extension: LeetCode slug
  meta             jsonb,           -- catch-all (submission state, etc.)
  is_idle          boolean not null default false,
  started_at       timestamptz not null,
  duration_seconds integer not null check (duration_seconds >= 0),
  summarized_at    timestamptz,     -- set when folded into an hourly note
  created_at       timestamptz not null default now()
);

create index if not exists events_user_started_idx on public.events(user_id, started_at);
create index if not exists events_user_unsummarized_idx on public.events(user_id) where summarized_at is null;

alter table public.events enable row level security;

create policy "events_select_own" on public.events
  for select to authenticated using (user_id = auth.uid());
create policy "events_insert_own" on public.events
  for insert to authenticated with check (user_id = auth.uid());
create policy "events_update_own" on public.events
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "events_delete_own" on public.events
  for delete to authenticated using (user_id = auth.uid());

-- =====================================================================
-- targets_template : recurring weekly plan  (weekday, hour) -> goal
-- =====================================================================
create table if not exists public.targets_template (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),  -- 0 = Sunday
  hour    smallint not null check (hour between 0 and 23),
  goal    text not null,
  unique (user_id, weekday, hour)
);

create index if not exists targets_template_user_idx on public.targets_template(user_id);

alter table public.targets_template enable row level security;

create policy "targets_template_all_own" on public.targets_template
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- targets_override : per-date override  (date, hour) -> goal
-- Resolution for a slot: override.goal ?? template.goal ?? 'unplanned'
-- =====================================================================
create table if not exists public.targets_override (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date    date not null,
  hour    smallint not null check (hour between 0 and 23),
  goal    text,   -- nullable: an empty override can clear the template slot
  unique (user_id, date, hour)
);

create index if not exists targets_override_user_date_idx on public.targets_override(user_id, date);

alter table public.targets_override enable row level security;

create policy "targets_override_all_own" on public.targets_override
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- hourly_notes : the AI output, one row per (user, slot).
-- unique(user_id, slot_start) makes the summarize job idempotent.
-- 'match' is renamed to match_status to avoid the SQL MATCH keyword.
-- =====================================================================
create table if not exists public.hourly_notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  slot_date    date not null,       -- user-local date (for the grid)
  slot_hour    smallint not null check (slot_hour between 0 and 23),  -- user-local hour
  slot_start   timestamptz not null,  -- UTC instant of slot start
  goal         text,                -- resolved target, snapshotted
  note         text,                -- AI summary of the hour
  match_status text check (match_status in ('matched','partial','missed','no_activity')),
  reason       text,                -- one-line justification
  model        text,                -- observability: which Groq model
  tokens       integer,             -- observability: token usage
  created_at   timestamptz not null default now(),
  unique (user_id, slot_start)
);

create index if not exists hourly_notes_user_date_idx on public.hourly_notes(user_id, slot_date);

alter table public.hourly_notes enable row level security;

create policy "hourly_notes_select_own" on public.hourly_notes
  for select to authenticated using (user_id = auth.uid());
create policy "hourly_notes_insert_own" on public.hourly_notes
  for insert to authenticated with check (user_id = auth.uid());
create policy "hourly_notes_update_own" on public.hourly_notes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "hourly_notes_delete_own" on public.hourly_notes
  for delete to authenticated using (user_id = auth.uid());
