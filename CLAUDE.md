# CLAUDE.md — fleet.ins2day.com (AIIS site + Aduna Dialer)

Production repo. Push to `main` = **live deploy** to fleet.ins2day.com via Vercel (~2 min). The Aduna Dialer portal here is used daily for real cold-calling and is also the product being sold to outside buyers — treat every change as customer-facing.

## Architecture (no build step — plain HTML/JS)

- `portal.html` — the entire dialer/CRM app in one file (inline CSS + JS). `login.html`, `set-password.html` — auth pages. Marketing: `index.html` etc., `aduna-dialer.html` = product landing page.
- `api/` — Vercel serverless functions. **Hard cap: 12 functions on this plan and we are AT 12.** Adding a new file under `api/` will break deploys — extend an existing endpoint or consciously remove one.
- `lib/twilio-auth.js` — shared CORS + Supabase session auth (`verifySession`) + per-agent caller-ID lookup.
- `supabase/functions/` — Supabase Edge Functions (deployed separately via Supabase, not Vercel).
- Backend: Supabase (Postgres + Auth + RLS) and Twilio Voice. The anon key in page source is public by design — **RLS is the security boundary**; never weaken a policy to fix a bug.

## Deploy ritual (do all of it)

1. Commit → push `main` (deploys to prod only when the task calls for it).
2. **Verify live**: `curl -H "Cache-Control: no-cache" "https://fleet.ins2day.com/<page>?cb=<timestamp>"` and grep for the change. CDN can serve stale for ~1 min.
3. If the change isn't live in ~4 min, check Vercel's deployments list — the GitHub webhook occasionally misses a push **silently** (no failed build, just nothing). Fix: `git commit --allow-empty` and push again.

## Gotchas that have burned us

- **Twilio webhooks must use the public domain** (`BASE_URL` env or `https://fleet.ins2day.com`), never `VERCEL_URL` — per-deployment URLs sit behind Vercel's auth wall (302) and calls fail with "an application error has occurred."
- **Root `*.md` files are served publicly** (e.g. /STAGING.md). Never put secrets, keys, or personal data in any committed file.
- Supabase's built-in email is unreliable to external addresses (invites/resets) until custom SMTP is configured — org-member addresses receive fine.
- **`vercel.json` allows no comment keys.** A `"//": "..."` entry inside `redirects` failed Vercel's schema validation and silently blocked every deploy from 2026-08-12 to 2026-09-14 (GitHub showed "Deployment failed", the sites kept serving the old build). Put explanations here, not in the JSON. The host-scoped `/` and `/index.html` redirects exist so app.adunadialer.com serves the login page instead of the AIIS marketing site.
- Phones are stored in mixed formats — duplicate/matching logic must normalize digits (see `crm_find_existing_phones` RPC and `normalizePhoneForMatch`).
- **Never call an RLS helper bare inside a policy.** `is_master()` and `auth_org_id()` are STABLE SECURITY DEFINER, but Postgres evaluates them **once per row** in a policy predicate — a single `count(*)` on `crm_leads` cost 1,335 ms instead of 33 ms. Always write `(select is_master())`, `(select auth_org_id())`, `(select auth.uid())`: identical predicate, hoisted into a once-per-statement InitPlan. Every `crm_*` policy was rewritten this way on 2026-10-06; keep new ones in the same shape.
- **Filter on `stage_key`, not `stage`, in anything hot.** `lead_stage` is an enum and `enum_eq` is not leakproof, so under RLS Postgres refuses to push `stage = '...'` below the security barrier — it can never become an index condition and forces a sort of the whole pipeline. `crm_leads.stage_key` is a trigger-maintained text mirror of `stage` (`texteq` *is* leakproof) and is what `idx_crm_leads_board_key` indexes.
- **`crm_email_sends` has `sent_at`, not `created_at`.** The old dashboard queried `created_at` and so the "Emails (24h)" KPI silently read 0 for its whole life.

## Data model + product rules

- `crm_leads.call_list` = the list mechanism; `assigned_to` (uuid-as-text) = per-rep ownership. The dialer shows each user **their leads + unassigned only** — preserve this scoping in any new query (`.or('assigned_to.is.null,assigned_to.eq.<uid>')` or a scoped RPC).
  **Known discrepancy, unresolved:** the `leads_select` RLS policy says `is_master() OR assigned_to = auth.uid()` with no `assigned_to is null` branch, so the *table* is stricter than the rule above. Both current users are `master`, so nothing is broken today — but the first `agent` account will see none of the 3,467 unassigned leads, including everything the daily FMCSA feed inserts (it writes `REP = null` on purpose so both reps share them). Widening the policy is a security decision; ask Jack before changing it.
- **Two pipelines.** `crm_leads.pipeline` is `'commercial'` (trucking insurance) or `'growthcrib'` (Growth Crib law-firm back-office ops). Each has its own stage ladder, and `public.crm_pipeline_stages` (pipeline, stage, ord, label, hint) is the **single source of truth** for both — the board RPC and the portal UI read it, so column order and labels cannot drift. Commercial: prospect → lead → info_pending → quote_submitted → quote_ready → client. Growth Crib: prospect → gc_visited → gc_discovery → gc_blueprint → gc_onboarding → gc_launch → gc_growth (Growth Crib's own five-stage journey, plus the two pre-sales states Kail actually works). `prospect` is the shared entry stage.
- **The dashboard is one page with two sections and no separate board.** Each section is a single `crm_board(p_pipeline, p_limit)` call returning stage counts, top-N cards, call counts, the staleness heat map and the next-step queue together — it replaced ~14 round trips. Add dashboard data to that RPC rather than firing another query from the page.
- `rep_notes` is the reps' working notepad (autosaved from the board); `notes` holds imported research and is rendered read-only so it cannot be typed over. `next_step` is the agreed action in words, `next_follow_up` is when it is due.
- `do_not_call = true` rows are excluded from all dialing paths. `last_dialed_at` drives resume-where-you-left-off — never repurpose `last_contacted_at` (email webhooks write it).
- Roles: `profiles.role` = `master` (admins see everything) vs `agent` (own leads only). Master-only pages must check `isMaster()` AND carry `data-role="master"` on their nav item.
- **Do not rename element ids or the CSS class names the dialer JS toggles** (`active`, `ringing`, `on-call`, `voicemail-detected`, `call-ended`, `dispo-btn`…) — restyle rules, not hooks.
- Product UI is deliberately **emoji-free** and liquid-glass themed (mint-teal `#00e5a0`, Syncopate/Space Mono/Inter). Match it.

## Testing conventions

- Name test data with a `ZZ ` prefix (e.g. list "ZZ Import Test") and **delete it when done** — this DB has real business leads.
- Placing real calls costs money and dials real people — verify telephony changes with curl/TwiML inspection or Twilio test credentials, not live dialing sprees.

## Branches

- `main` = production. `staging` = sandbox wired to a separate staging Supabase project — **never merge staging's config (Supabase URL/keys) back into main.** `STAGING.md` is the runbook.

## FMCSA lead feed (daily, automated)

- `supabase/functions/fmcsa-daily-leads/` — Edge Function that pulls California trucking leads from FMCSA open data into `crm_leads` for the AIIS org (left unassigned so both reps see them). Five pools: new MC applicants with no insurance on file → `New Authority CA - Needs Insurance`; liability cancellations → `BMC-35 CA Lapsed - Uninsured` / `BMC-35 CA Cancelling Soon`; **authority Active with $0 liability on file, or revoked *for* an insurance cancellation → `CA Uninsured Now - No Liability On File`**; **a filing below the carrier's own federal minimum → `Underinsured CA - Below Federal Minimum`**. Leads FMCSA later shows insured/granted/replaced/cured are moved to the matching `- Closed` / `- Already Replaced` / `- Now Insured` / `- Cured` list. Brokers/forwarders are skipped (they need a BMC-84 bond, not truck liability).
- The last two pools are a whole-state scan rather than a dated event, so they carry quality gates the dated pools do not: a reachable phone, census `status_code='A'`, census `phy_state='CA'`, and at least one power unit. `skip_standing: true` in the body skips them. "Uninsured" means EVERY docket on the USDOT reads `bipd_file = 0` — a carrier can hold several.
- One carrier, one lead per run: candidates are ranked (lapsed > cancelling-soon > new authority > revoked > uninsured > underinsured) and deduped by USDOT before the CRM dedupe, so overlapping pools cannot double-insert.
- Trigger: pg_cron job `fmcsa-daily-leads` at 16:00 and 17:00 UTC; the function only does work when it is 9 AM in Los Angeles (DST-proof). Auth is an `x-cron-secret` header generated inside Postgres (`private.job_secrets`) and checked by the service-role-only RPC `job_secret_ok` — no secret lives in code or env. `setup.sql` next to the function is the reference for the schema/cron.
- Every run (or failure) is logged in `public.fmcsa_daily_runs`; read it with the SQL editor. Re-run by hand: `select net.http_post(...)` as in `setup.sql`, adding `"force": true` (and `"dry_run": true` to preview). `apps_lookback_days` widens the applicant window (45 was used for the initial load).
- Phone dedupe for bulk imports uses RPC `crm_existing_phone_digits(org, phones[])` (one scan, hash join); `crm_find_existing_phones` is fine for the UI's small batches but times out past a few hundred numbers.
- `scripts/fmcsa-bmc35-ca.py` is the analyst-side version of the same FMCSA logic (CSV output, no DB writes).
