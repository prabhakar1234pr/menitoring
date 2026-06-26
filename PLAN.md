# PLAN.md — Hourly Activity Tracker + AI Notes

> **Status:** Planning only. No implementation code in this document — schema/SQL/JSON below are *design sketches* to pin down the data model, not the build.

## Context

This is a **portfolio** project (not a public SaaS): a small, multi-user app where each
signed-up user runs an always-on Windows agent + a Chrome extension that silently track
what they do. Every hour, a **server-side** job turns that hour's activity into an AI note
("matched / partial / missed" against the user's planned target for that hour slot). A web UI
shows a daily grid: **planned target per hour vs. AI note + match flag**.

The engineering story to demonstrate: **multi-tenant isolation via Postgres RLS**, a
**centralized server-side scheduled fan-out** (not client-triggered), a **clean event data
model that dedupes overlapping signals**, and **two distinct auth paths** (web/extension JWT
vs. headless agent device token) — all on a **100% free tier**.

### Locked decisions (from kickoff Q&A)
- **Desktop agent:** Python 3 + pywin32.
- **Timetable:** recurring weekly template **+ per-date overrides** (`override ?? template ?? unplanned`).
- **Timezone:** **per-user IANA timezone** (stored on profile); slot bucketing converts UTC → user tz.
- **Web auth:** Supabase Auth **email + password**.

### Fixed constraints
- Free tier only. Stack is fixed: **Vercel** (web UI + API routes), **Supabase** (Postgres + Auth + pg_cron + pg_net), **Groq** (LLM, text only). Any new paid service/infra = explicit open question.
- **Windows only.** No screenshots / no vision — all signals are text (window titles + browser data).
- Multi-user, real auth, **per-user isolation enforced by RLS at the DB level**.

---

## 1. Architecture + data flow

```
┌────────────────────┐        ┌──────────────────────┐
│ Desktop agent (PC) │        │ Chrome extension MV3 │
│ Python + pywin32   │        │ service worker       │
│ • foreground title │        │ • exact URL          │
│ • idle detection   │        │ • YouTube video id   │
│ • Cursor/Claude    │        │ • LeetCode problem   │
│   special-casing   │        │ • active-tab + dur   │
│ auth: DEVICE TOKEN │        │ auth: SUPABASE JWT   │
└─────────┬──────────┘        └──────────┬───────────┘
          │  POST batched events (Bearer …)          │
          └───────────────┬──────────────────────────┘
                          ▼
              ┌───────────────────────────┐
              │ Vercel API routes (stateless) │
              │ POST /api/events          │  ← resolve user_id, validate, write
              │ POST /api/devices         │  ← issue/revoke pairing tokens
              │ POST /api/cron/summarize  │  ← protected, fan-out (see §4)
              └─────────────┬─────────────┘
                            ▼
              ┌───────────────────────────┐        ┌──────────────┐
              │ Supabase Postgres (truth) │        │ Groq LLM     │
              │ profiles / devices        │◀──────▶│ note+verdict │
              │ events (RLS)              │        │ (text only)  │
              │ targets_template/override │        └──────────────┘
              │ hourly_notes (RLS)        │
              │ pg_cron heartbeat ──pg_net─┐
              └───────────────────────────┘│
                            ▲              │ hourly POST → /api/cron/summarize
   Web UI (Next.js) ────────┘              │ (shared secret)
   reads via user session (RLS)   ─────────┘
```

**Two paths:**

**A. Authenticated ingest (real-time-ish).** Agent and extension batch events (~30–60 s) and
POST them to `POST /api/events`. The route resolves `user_id` server-side (JWT *or* device
token → §3), validates the payload, and appends rows to `events` with the resolved `user_id`.
Functions are stateless: no timers, no in-memory state. Writes use the service-role client but
**always inject the resolved `user_id`** — the leak-sensitive surface (reads) is RLS-bound.

**B. Server-side hourly summarize (centralized fan-out).** `pg_cron` is the **heartbeat**: once
an hour it calls `net.http_post` (pg_net) to the protected `POST /api/cron/summarize` route with
a shared secret. That route does the **fan-out**: find every user with completed, unsummarized
slots → dedupe/merge events → call Groq once per (user, slot) → write `hourly_notes`. The loop
lives in TypeScript (where prompt-building belongs), not plpgsql; pg_cron stays a pure scheduler.
This is server-side and client-independent — testers' PCs being off never blocks summarization.

> **Why heartbeat→Vercel instead of pure-SQL loop:** building Groq prompts, parsing JSON, and
> handling backoff in plpgsql is painful and untestable. pg_net is a free Supabase extension (no
> new infra). pg_cron remains the server-side scheduler; only the *per-user loop* runs in app code.
> Flagged as an open decision in §7.

---

## 2. Supabase data model

Every table carries `user_id` and has an RLS policy `user_id = auth.uid()`. Service-role
ingest/cron bypass RLS but always set `user_id` explicitly; **all user-facing reads go through a
user session, so a logic bug can't leak across tenants.**

### `profiles` (1:1 with `auth.users`)
| col | type | notes |
|---|---|---|
| id | uuid PK → auth.users(id) | |
| email | text | |
| timezone | text | IANA, e.g. `Asia/Kolkata`, default `UTC` |
| created_at | timestamptz | |

Row auto-created on signup (trigger on `auth.users`). RLS: `id = auth.uid()`.

### `devices` (agent pairing)
| col | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → auth.users | |
| name | text | e.g. "Home-PC" |
| token_hash | text | SHA-256 of the device token (raw token shown once, never stored) |
| created_at / last_seen_at / revoked_at | timestamptz | |

RLS: `user_id = auth.uid()` (so the web UI lists/revokes the user's own devices). Token *lookup*
during ingest is done by the service-role route, not under RLS.

### `events` (raw activity — the merge/dedupe-friendly schema)
| col | type | purpose |
|---|---|---|
| id | bigint identity PK | |
| user_id | uuid not null | tenant key |
| source | text not null | `'agent'` \| `'extension'` — drives the merge rule |
| app | text | `'Cursor'`, `'Chrome'`, `'Claude Desktop'`, generic exe name |
| repo | text | parsed from Cursor title (`file — repo — Cursor`) |
| file | text | parsed from Cursor title |
| url | text | extension: exact URL |
| title | text | raw window/page title |
| video_id | text | extension: YouTube id |
| problem | text | extension: LeetCode slug |
| meta | jsonb | catch-all (submission state, etc.) |
| is_idle | bool default false | agent: slot was idle |
| started_at | timestamptz not null | event start (UTC) |
| duration_seconds | int not null | rolled duration of the block |
| summarized_at | timestamptz null | set when folded into an hourly note |
| created_at | timestamptz default now() | |

Indexes: `(user_id, started_at)`, partial `(user_id) where summarized_at is null`.

**Why this dedupes cleanly:** `source` + `app` let the job recognize a browser *container* block
from the agent and drop it in favor of the extension's detail rows for the same window. See §4.

### `targets_template` (recurring weekly)
`(id, user_id, weekday 0–6, hour 0–23, goal text)`, unique `(user_id, weekday, hour)`.

### `targets_override` (per-date)
`(id, user_id, date, hour 0–23, goal text)`, unique `(user_id, date, hour)`.

**Resolution for a slot:** `override.goal ?? template.goal ?? null('unplanned')`.

### `hourly_notes` (the AI output, one per user/slot)
| col | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid not null | |
| slot_date | date | user-local date (for the grid) |
| slot_hour | int | 0–23 user-local |
| slot_start | timestamptz | UTC instant of slot start — **unique(user_id, slot_start)** = idempotency |
| goal | text | resolved target, snapshotted |
| note | text | AI summary of the hour |
| match | text | `matched` \| `partial` \| `missed` \| `no_activity` |
| reason | text | one-line justification |
| model / tokens | text / int | optional, for the portfolio "observability" touch |
| created_at | timestamptz | |

RLS on `events`, `targets_*`, `hourly_notes`: `user_id = auth.uid()` for all of select/insert/update/delete.

---

## 3. Auth design

Two deliberately different mechanisms — a good thing to show off.

**Web UI (and Chrome extension): Supabase JWT.**
- Supabase Auth **email + password**. Web app uses `@supabase/ssr`; the session JWT carries
  `auth.uid()`; RLS policies read `auth.uid()`. Dashboard reads `hourly_notes`/`targets` **directly
  under the user session** → isolation enforced by Postgres, not trust in the API.
- The **extension** signs in with the *same* email/password in its popup (supabase-js inside the
  MV3 worker), stores the session in `chrome.storage.local`, refreshes as needed, and sends
  `Authorization: Bearer <access_token>` on every `POST /api/events`. The route verifies the JWT →
  `user_id`.

**Desktop agent: opaque device token (pairing flow).**
1. User logs into the web UI → **Devices** page → "Pair a device" → `POST /api/devices` generates a
   high-entropy token, stores **only its hash** in `devices`, and returns the raw token **once**.
2. User pastes it into the agent's first-run config; agent stores it under `%APPDATA%`.
3. Agent sends `Authorization: Bearer <device_token>` with every batch.
4. `POST /api/events` detects a non-JWT token → hashes it → looks up `devices` (service role) →
   resolves `user_id`, checks `revoked_at IS NULL`, bumps `last_seen_at`, then writes events.

**Route auth resolver (shared helper):** given a request → return `user_id`:
JWT present & valid → user; else device token → hash → `devices` lookup; else 401.

> **Defense-in-depth note (stretch):** the device path can mint a short-lived user-scoped JWT
> (signed with the Supabase JWT secret) so even ingest writes run under RLS. Baseline keeps
> service-role writes with an enforced `user_id`; reads are always RLS-bound, which is where the
> leak risk actually lives.

---

## 4. The hourly `pg_cron` summarize job (exact read→write sequence)

**Trigger:** `pg_cron` job every hour at ~`:05` runs a SQL function that does
`net.http_post('https://<app>/api/cron/summarize', headers => x-cron-secret)`. (The 5-min delay
lets the just-ended hour's late events settle.)

**Inside `POST /api/cron/summarize` (the fan-out):**

1. **Auth:** reject unless `x-cron-secret` header == env secret.
2. **Select due (user, slot) pairs.** A slot is *due* once its wall-clock hour has fully elapsed
   in the user's tz. Pull candidates:
   ```sql
   -- users with pending events, joined to their tz
   select e.user_id, p.timezone, e.id, e.started_at, ...
   from events e join profiles p on p.id = e.user_id
   where e.summarized_at is null;
   ```
   For each row compute its user-local slot = `date_trunc('hour', started_at AT TIME ZONE tz)`;
   keep only slots whose end (`slot_start + 1h`) `<= now()`. Group remaining events by
   `(user_id, slot_start)`.
3. **Per due slot — dedupe / merge** (the core data problem):
   - Split the slot's events into **extension** (browser truth) and **agent**.
   - **Drop agent events whose `app` is a known browser** (Chrome/Edge/Brave…) — these are mere
     *containers* for time the extension already describes in detail (rule: *browser foreground →
     extension wins*).
   - Keep all **non-browser agent events** (Cursor, Claude Desktop, generic apps) — rule: *browser
     not foreground → agent wins*. (Extension is built to only emit while its window is focused, so
     there's no stray "background browser" time to subtract.)
   - Union = `non-browser agent events ∪ all extension events`. Optionally drop `is_idle` blocks.
4. **Resolve the target** for that slot: `targets_override ?? targets_template ?? 'unplanned'`.
5. **Build a compact activity digest** (top apps/sites by duration, repos/files touched, videos,
   LeetCode problems) and call **Groq once** with `{target, digest}` → structured JSON
   `{note, match ∈ {matched,partial,missed}, reason}`. (If target is `unplanned`, still summarize;
   match = `no_activity`-style handling per §7.)
6. **Write idempotently:** `insert into hourly_notes (...) on conflict (user_id, slot_start) do nothing`.
   Then `update events set summarized_at = now()` for that slot's rows so re-runs skip them.
7. **Pacing/backoff:** process slots sequentially with a small delay; on Groq **429**, exponential
   backoff and cap the number processed per invocation (the next heartbeat picks up the rest).
   Proportionate to a handful of users — **no queue system**.

**Empty planned slots:** don't generate notes for hours with zero activity (saves rows + Groq
calls). The UI infers `missed` for a *planned* slot that has passed with no note (§7 decision).

**Retention:** a second daily `pg_cron` job deletes `events where summarized_at is not null and
started_at < now() - interval '7 days'` to stay well under free-tier row caps. Simple, not a
pipeline.

---

## 5. Component breakdown + proposed stack

| Component | Stack | Responsibilities |
|---|---|---|
| **Desktop agent** | Python 3, **pywin32** (`win32gui.GetForegroundWindow/GetWindowText`, `GetLastInputInfo` for idle), `httpx`; config in `%APPDATA%`; packaged with **PyInstaller** (`--onefile --noconsole`); optional `pystray` tray + autostart (Startup shortcut / `Run` registry key) | Poll foreground title every few sec + idle; roll into blocks; special-case **Cursor** (parse `file — repo — Cursor`) and **Claude Desktop**; batch-POST every 30–60 s with device token |
| **Chrome extension** | **MV3**: event-driven service worker (no long timers), content script for SPA URL changes, `tabs` + `webNavigation`, `chrome.storage`, popup (login + status), supabase-js | Own all browser truth: exact URL, YouTube `video_id`, LeetCode problem + submission state, active-tab duration **while focused**; batch-POST with Supabase JWT |
| **Web app + API** | **Next.js (App Router) + TypeScript**, `@supabase/ssr`, Tailwind | Auth pages; **daily grid** (target vs note + match, date picker); **timetable editor** (weekly template + per-date override); Devices page; API routes `/api/events`, `/api/devices`, `/api/cron/summarize` |
| **Supabase** | Postgres + RLS, Auth (email/pw), **pg_cron**, **pg_net**; migrations in `/supabase/migrations` | Source of truth; hourly heartbeat + daily cleanup; RLS isolation |
| **Groq** | e.g. `llama-3.1-8b-instant` (fast/cheap) or `llama-3.3-70b-versatile`; JSON/structured output | One call per (user, slot): activity digest + target → `{note, match, reason}`; 429 backoff |

---

## 6. Build order — thin end-to-end slice first

**Slice 0 — E2E vertical (one signal, one user, fully wired):**
1. Supabase project: `profiles`, `events`, `hourly_notes` + RLS + email/password auth + signup trigger.
2. Next.js on Vercel: login + a dashboard that reads `hourly_notes` for a date under the user session (proves RLS read path).
3. `POST /api/events` with the **JWT** path; get **one** real window event from the Python agent stored with the correct `user_id` (minimal device-token pairing to authenticate the agent).
4. `pg_cron` heartbeat → `/api/cron/summarize` that reads that user's last completed hour, calls **Groq once**, writes **one** `hourly_note`.
5. Dashboard renders that note. ✅ **Signal → authenticated → stored → summarized → shown.**

**Then layer on:**
6. `targets_template` + `targets_override` + timetable editor; resolve target; feed it to Groq → real `match` verdict in the grid.
7. **Chrome extension** ingest (browser truth) + the **merge/dedupe** step in the job (§4.3).
8. Agent richness: Cursor repo/file parsing, Claude Desktop case, idle detection, event batching.
9. Device pairing UI (`/api/devices`) + agent first-run config + multi-device.
10. Retention cleanup cron; Groq pacing/backoff; UI inference of `missed` for empty planned slots.
11. Polish: tray icon, autostart, status/last-seen, per-user timezone setting UI.

**Future work (explicitly out of v1):** Chrome Web Store publishing, desktop-agent code signing — testers sideload/dev-install.

---

## 7. Open questions / decisions needed before building

1. **Fan-out location (recommend: heartbeat→Vercel).** Confirm pg_cron+**pg_net** calling a
   protected Vercel route (loop in TS) vs. a pure-SQL plpgsql loop. *pg_net is a free Supabase
   extension — no new infra, but flagging per the rules.*
2. **Groq model + budget.** `llama-3.1-8b-instant` (cheaper/faster, recommended) vs.
   `llama-3.3-70b-versatile` (better notes). Acceptable token/rate budget on free tier?
3. **Match verdict authority.** LLM decides `matched/partial/missed` (recommended) vs. deterministic
   rules. Confirm LLM.
4. **Browsers to support in v1** for the dedupe browser-container list — Chrome only, or also
   Edge/Brave? (Extension is Chrome MV3; agent may still see Edge windows.)
5. **Idle policy.** Idle threshold (e.g. ≥60 s no input) and whether idle time is excluded from a
   slot / surfaced in the note.
6. **Slot coverage + unplanned hours.** All 24 hours or a waking window? For `unplanned` slots, still
   generate a note (descriptive, no verdict) or skip Groq entirely?
7. **Empty planned slots.** Confirm UI-side inference of `missed` (no note generated) vs. the job
   writing explicit `no_activity` rows.
8. **Agent batch/flush interval** (proposed 30–60 s) — acceptable latency vs. request volume?
9. **Detail depth for browser signals** in v1: how much LeetCode submission state / YouTube metadata
   to capture.
10. **Raw-event retention window** (proposed 7 days) — acceptable?

> Items 1–3 and 6–7 most affect the data model and the Groq contract; worth resolving before Slice 0
> hardens.
