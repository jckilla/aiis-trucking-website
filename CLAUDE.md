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
- Phones are stored in mixed formats — duplicate/matching logic must normalize digits (see `crm_find_existing_phones` RPC and `normalizePhoneForMatch`).

## Data model + product rules

- `crm_leads.call_list` = the list mechanism; `assigned_to` (uuid-as-text) = per-rep ownership. The dialer shows each user **their leads + unassigned only** — preserve this scoping in any new query (`.or('assigned_to.is.null,assigned_to.eq.<uid>')` or a scoped RPC).
- `do_not_call = true` rows are excluded from all dialing paths. `last_dialed_at` drives resume-where-you-left-off — never repurpose `last_contacted_at` (email webhooks write it).
- Roles: `profiles.role` = `master` (admins see everything) vs `agent` (own leads only). Master-only pages must check `isMaster()` AND carry `data-role="master"` on their nav item.
- **Do not rename element ids or the CSS class names the dialer JS toggles** (`active`, `ringing`, `on-call`, `voicemail-detected`, `call-ended`, `dispo-btn`…) — restyle rules, not hooks.
- Product UI is deliberately **emoji-free** and liquid-glass themed (mint-teal `#00e5a0`, Syncopate/Space Mono/Inter). Match it.

## Testing conventions

- Name test data with a `ZZ ` prefix (e.g. list "ZZ Import Test") and **delete it when done** — this DB has real business leads.
- Placing real calls costs money and dials real people — verify telephony changes with curl/TwiML inspection or Twilio test credentials, not live dialing sprees.

## Branches

- `main` = production. `staging` = sandbox wired to a separate staging Supabase project — **never merge staging's config (Supabase URL/keys) back into main.** `STAGING.md` is the runbook.
