# STAGING.md — Aduna Dialer Staging Environment Runbook

This runbook describes how to stand up a **completely isolated staging clone** of the Aduna
Dialer app and how to promote staging changes back to production safely.

> Companion document: **`STAGING-SWAPS.md`** lists every hardcoded production value (Supabase
> URL/keys baked into the HTML, the `fleet.ins2day.com` domain, the inbound forward number, and
> the HubSpot meeting link) that must be changed for staging. Do both: set the env vars described
> here **and** apply the find/replace swaps in that file.

---

## 1. Overview

Staging is a **full sandbox** that mirrors production but shares **none** of its data or credentials:

| Resource           | Production                                  | Staging                                              |
| ------------------ | ------------------------------------------- | ---------------------------------------------------- |
| Supabase project   | `cqijyhudfiteivejcgox` (real customer data) | a **separate Supabase project** (fake data only)     |
| Twilio credentials | live SID / Auth Token (real billing)        | Twilio **TEST credentials** (no real calls, $0)      |
| Hosting            | Vercel project on `fleet.ins2day.com`       | a **separate Vercel project** on a staging URL        |
| Git source         | `main` (production branch)                   | a dedicated `staging` branch                          |
| Email (Resend)     | live `veronica@fleet.ins2day.com` sender    | a test inbox / sandbox sender                          |

Key isolation guarantees:

- **No real calls, no charges.** Twilio TEST credentials can only dial Twilio's "magic" test
  numbers; they physically cannot reach a real phone. Billing stays at $0.
- **No real customer data.** Staging points at its own Supabase project, seeded with a handful of
  fake leads. Production rows are never touched.
- **No shared secrets.** Staging gets its own anon/service-role keys, its own Twilio test creds,
  and its own (placeholder) domain. Promoting staging to prod must **not** carry any of these back.

The codebase is environment-agnostic for almost everything **except** the values catalogued in
`STAGING-SWAPS.md` (hardcoded into HTML and a few server files). Setting env vars alone is not
enough — apply the swaps too.

---

## 2. Environment Variable Reference

Every variable read by the app, grouped by area. "Required" = the relevant feature breaks without
it. Server (Vercel function) vars are read via `process.env`; the edge function reads two via
`Deno.env.get`. The browser HTML does **not** read env vars — its Supabase URL/key are hardcoded
(see `STAGING-SWAPS.md`).

This list was verified by grepping the entire repo for `process.env.*` and `Deno.env.get(...)`.

### 2.1 Supabase

| Var                         | Required | Read by                                                                 | Staging value                                                            |
| --------------------------- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `SUPABASE_URL`              | Yes      | `lib/twilio-auth.js`, `api/quote.js`, `api/email/*`, `api/cron/daily-summary.js`, edge fn | `https://<STAGING-PROJECT-REF>.supabase.co` (the staging project's URL)   |
| `SUPABASE_ANON_KEY`         | Yes      | `lib/twilio-auth.js` (caller-id lookup), fallbacks in `api/*`            | the **staging** project's anon (publishable) key                          |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | `api/quote.js`, `api/email/*`, `api/cron/daily-summary.js`, edge fn, also HMAC seed for unsubscribe links | the **staging** project's service-role key (server-only secret)           |

> Code also reads legacy fallbacks `SUPABASE_KEY` and `SUPABASE_SERVICE_KEY` (the latter only in
> `scripts/generate-ca-leads.js`). You normally set the three canonical vars above; the fallbacks
> exist for older scripts. If you run the seed scripts, set `SUPABASE_SERVICE_KEY` to the staging
> service-role key too.

### 2.2 Twilio

Use the **Twilio account TEST credentials** for staging (Twilio Console → Account → "Test
Credentials"). Test creds only place calls to Twilio magic test numbers, so staging cannot dial
real people.

| Var                    | Required | Read by                                  | Staging value                                                        |
| ---------------------- | -------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`   | Yes      | `token.js`, `dial.js`, `status.js`, `hangup.js`, `numbers.js` | the **Test** Account SID (`AC…`, from Test Credentials)               |
| `TWILIO_AUTH_TOKEN`    | Yes      | `dial.js`, `status.js`, `hangup.js`, `numbers.js` | the **Test** Auth Token                                              |
| `TWILIO_API_KEY`       | Yes*     | `token.js` (browser access token)        | a Test-mode API Key SID (`SK…`) — needed for the browser softphone   |
| `TWILIO_API_SECRET`    | Yes*     | `token.js`                               | the matching API Key secret                                          |
| `TWILIO_TWIML_APP_SID` | Yes*     | `token.js`                               | a TwiML App SID (`AP…`) whose Voice URL points at the staging domain |
| `TWILIO_DEFAULT_NUMBER`| Yes      | `dial.js` (caller ID; no hardcoded fallback — calls fail without it) | a Twilio magic test "from" number (e.g. `+15005550006`)              |
| `BASE_URL`             | Yes      | `dial.js`, `connect.js`, `numbers.js`    | the staging public URL, e.g. `https://staging.your-domain.com` (no trailing slash). Falls back to `https://fleet.ins2day.com` if unset — **must** be set in staging or webhooks hit prod |
| `FORWARD_NUMBER`       | n/a      | hardcoded in `api/twilio/voice.js` (NOT an env var) | change in source per `STAGING-SWAPS.md`, or a test number             |
| `TWILIO_AUTO_PROVISION`| Optional | `dial.js`                                | leave unset for staging                                              |

> *The browser softphone (token endpoint) needs `TWILIO_API_KEY`, `TWILIO_API_SECRET`,
> `TWILIO_TWIML_APP_SID`. With pure Test credentials the softphone path is limited; for staging you
> primarily exercise the dialer wiring and UI, not live audio.

### 2.3 Email (Resend)

| Var                     | Required | Read by                                  | Staging value                                                       |
| ----------------------- | -------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `RESEND_API_KEY`        | Optional | `api/quote.js`, `api/email/send.js`      | a Resend **test/sandbox** API key, or leave unset to disable sends  |
| `RESEND_WEBHOOK_SECRET` | Optional | `api/email/webhook.js`                   | a staging webhook signing secret (only if you wire Resend webhooks) |
| `FROM_EMAIL`            | Optional | `api/quote.js`, `api/email/send.js`      | a verified test sender, e.g. `Staging <staging@your-test-domain>`   |
| `QUOTE_NOTIFY_EMAIL`    | Optional | `api/quote.js`                           | a **test inbox** you own, e.g. `staging-leads@your-test-domain`     |
| `UNSUBSCRIBE_SECRET`    | Optional | `api/quote.js`, `api/email/send.js`      | any random staging string (HMAC seed; falls back to service-role key)|

> Defaults in code point at `veronica@fleet.ins2day.com` / `trucking@ins2day.com`. Override
> `FROM_EMAIL` and `QUOTE_NOTIFY_EMAIL` in staging so no test mail looks like it came from prod.

### 2.4 Other

| Var              | Required | Read by                         | Staging value                                              |
| ---------------- | -------- | ------------------------------- | ---------------------------------------------------------- |
| `CRON_SECRET`    | Optional | `api/cron/daily-summary.js`     | a random staging string (Vercel sets this for Cron jobs)   |
| `DIALER_API_KEY` | Optional | `lib/twilio-auth.js` (legacy `verifyRequest`), `api/cron/daily-summary.js`, `api/email/send.js` | a random staging string; legacy static key, mostly deprecated by `verifySession` |

**Vars present in the repo but NOT in the original task list** (found via grep — set these too if
you exercise those paths):
- `SUPABASE_KEY` — legacy fallback for the anon/service key (multiple files + scripts).
- `SUPABASE_SERVICE_KEY` — used only by `scripts/generate-ca-leads.js`.

---

## 3. Step-by-Step Setup

### Step 1 — Create the staging Supabase project
1. In the Supabase dashboard, create a **new project** (e.g. `aduna-dialer-staging`) in the same org.
2. Record its **Project URL** (`https://<ref>.supabase.co`), **anon key**, and **service-role key**.
   These become `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and also the
   hardcoded HTML values in `STAGING-SWAPS.md`.

### Step 2 — Apply the schema (from a dump of production)
The cleanest path is to **dump the production schema (structure only, no data)** and load it into
staging, so staging matches prod exactly.

1. From production (`cqijyhudfiteivejcgox`), export the schema only:
   - `supabase db dump --schema public --schema-only -f staging-schema.sql` (or use the dashboard /
     `pg_dump --schema-only`). **Schema only — do not export row data** (no real customer data).
2. Apply `staging-schema.sql` to the staging project (`supabase db push`, `psql`, or the SQL editor).

The dump must include:
- **Tables:** `crm_leads`, `crm_calls`, `crm_dialer_sessions`, `profiles`, and the email tables
  (`crm_email_campaigns`, `crm_activities`, `crm_daily_reports`, and the reply/email tables created
  by `scripts/create-reply-tables.js`). Include whatever else the prod `public` schema contains —
  dumping the whole schema guarantees parity.
- **Enums:** the disposition/role/status enum types used by those tables.
- **RLS policies:** the master-vs-agent row-level-security policies on every table.
- **Functions:** `is_master` and `handle_new_user` (the signup trigger that creates a `profiles`
  row), plus their triggers.

After loading, confirm RLS is **enabled** on every table and `is_master` / `handle_new_user` exist
in staging.

### Step 3 — Seed minimal fake data
Insert **only synthetic data** — never copy production rows.
1. One **master** user: create via Supabase Auth (Dashboard → Authentication → Add user), then
   ensure a `profiles` row with `role = 'master'` (set `app_metadata.role = 'master'` so RLS sees it
   from first login).
2. One **agent** user: same, with `role = 'agent'`.
3. ~**20 fake leads** in `crm_leads`: obviously-fake names, companies, and **non-routable test phone
   numbers** (e.g. `+15005550006` / `555-01xx` style). Do not use real businesses' DOT/MC numbers.
   You can adapt `scripts/generate-ca-leads.js`, but for staging prefer a tiny hand-written insert of
   fake rows over hitting the live FMCSA API.

### Step 4 — Deploy the `admin-create-agent` edge function to staging Supabase
1. Link the CLI to the staging project: `supabase link --project-ref <STAGING-PROJECT-REF>`.
2. Deploy: `supabase functions deploy admin-create-agent`.
3. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected into the function by Supabase —
   no manual secret needed.
4. Update the function's CORS allow-list to the staging domain (see `STAGING-SWAPS.md` — the
   `ALLOWED` array and the `*.vercel.app` regex in `index.ts`).

### Step 5 — Create a separate Vercel project from the `staging` branch
1. Create a `staging` git branch off `main`.
2. In Vercel, **create a new project** (do not reuse the prod project) and point it at this repo with
   the **Production Branch set to `staging`** (or deploy `staging` as the project's main branch).
3. Set **every** env var from section 2 in the staging Vercel project's settings, using the staging
   values (staging Supabase keys, Twilio **test** creds, staging `BASE_URL`, test email addresses).
4. Apply the source swaps from `STAGING-SWAPS.md` on the `staging` branch and push. The hardcoded
   HTML Supabase URL/key and the domain references are **not** env-driven, so they must be edited in
   source on the staging branch.
5. Deploy. Note the assigned URL (e.g. `https://aduna-dialer-staging.vercel.app`) and use it as
   `BASE_URL` and as the staging domain in the swaps. If you attach a custom subdomain like
   `staging.your-domain.com`, use that instead.
6. In Twilio, point the TwiML App Voice URL and any number webhooks at the staging `BASE_URL`
   (`<BASE_URL>/api/twilio/voice`, `/api/twilio/status`).

### Step 6 — Twilio test-credentials note
With Twilio **test** credentials, the API only accepts calls to Twilio's magic test numbers and
returns canned results; it will **not** connect to a real phone, and nothing is billed. This is the
core safety property of staging: you can click "Dial", watch the request/queue/status wiring, and
verify the UI without ever ringing a real person. To exercise real audio you would need live creds —
which defeats the isolation, so keep staging on test creds.

---

## 4. Promoting Staging → Production

When a change is validated in staging and ready to ship:

1. Merge the `staging` branch into `main` (PR review as usual).
2. **CRITICAL — do not carry staging-only values into prod.** Before/at merge, revert or exclude:
   - the hardcoded **staging Supabase URL + anon key** in `portal.html`, `login.html`,
     `set-password.html` (must read the **production** `cqijyhudfiteivejcgox` values);
   - the **staging domain** in canonical/OG tags, `lib/twilio-auth.js` `ALLOWED_ORIGINS`,
     `api/twilio/voice.js`, and the edge function CORS (must read `fleet.ins2day.com`);
   - the **`FORWARD_NUMBER`** and **HubSpot meeting link** if you changed them for staging;
   - any Twilio **test** creds or staging `BASE_URL` — production Vercel keeps its own live env vars.
   The practical way to avoid mistakes: keep the `STAGING-SWAPS.md` changes as a small, isolated
   commit on the `staging` branch and **do not merge that commit** (cherry-pick everything else), or
   revert it as the first commit after merge. Only application/logic changes should flow to prod.
3. Production Vercel env vars are already set with live values — leave them untouched. Confirm prod
   still points at `cqijyhudfiteivejcgox` and live Twilio creds after deploy.

---

## 5. Vercel Hobby Plan Function Cap

The Vercel **Hobby** plan allows a maximum of **12 Serverless Functions** per project. This repo is
already at **12/12** (`api/quote.js`, `api/cron/daily-summary.js`, `api/email/{send,webhook,reply-webhook}.js`,
`api/twilio/{token,dial,status,hangup,numbers,connect,voice}.js`). There is **no headroom** to add
functions.

Because the staging deployment is a **separate Vercel project**, it gets its own independent 12/12
budget — so the existing function count is fine as-is. But note:
- The staging project needs its **own Hobby (or Pro) plan allotment**; you cannot squeeze a 13th
  function into the prod project.
- If staging ever needs an **extra** function (debug endpoint, seed trigger, etc.), the staging
  project must be on **Pro**, since 12 is already the Hobby ceiling.
