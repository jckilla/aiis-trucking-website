# STAGING-SWAPS.md — Hardcoded Production Value Find/Replace Spec

Every value below is **hardcoded** (not env-driven) and points at production. To stand up staging,
change each one on the `staging` branch. Line numbers were verified by reading the files; they may
drift by a line or two as `portal.html` is edited — search the "Current prod value" string to locate.

> **Security:** the "Replace-with" column uses **placeholders only**. Substitute your real staging
> Supabase project ref, anon key, and domain when you actually edit. Do **not** commit real
> service-role keys, Twilio tokens, or Resend keys into source — those belong in Vercel env vars
> only (see `STAGING.md` §2). The Supabase **anon** key is public-by-design and is the only key that
> legitimately lives in the HTML.
>
> **Production project ref:** `cqijyhudfiteivejcgox` — appears in the Supabase URL and inside the
> anon JWT (`"ref":"cqijyhudfiteivejcgox"`). Both must change to the staging ref/key together.

---

## A. Hardcoded Supabase URL + anon key (browser HTML)

These three pages each embed the prod Supabase URL and anon JWT directly in a `<script>`.

| File              | Approx line | Current prod value                                                                 | Replace-with for staging                                  |
| ----------------- | ----------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `portal.html`     | ~1173       | `const SUPABASE_URL = 'https://cqijyhudfiteivejcgox.supabase.co';`                  | `const SUPABASE_URL = 'https://STAGING-PROJECT.supabase.co';` |
| `portal.html`     | ~1174       | `const SUPABASE_KEY = 'eyJhbGci…08wZTXZSQvB98VEKCMLVc0EcuxleNVSOF5Fg0eKENHI';` (prod anon JWT) | `const SUPABASE_KEY = 'STAGING_ANON_KEY';` (staging anon JWT) |
| `login.html`      | ~127        | `const SUPABASE_URL = 'https://cqijyhudfiteivejcgox.supabase.co';`                  | `const SUPABASE_URL = 'https://STAGING-PROJECT.supabase.co';` |
| `login.html`      | ~128        | `const SUPABASE_ANON_KEY = 'eyJhbGci…08wZTXZSQvB98VEKCMLVc0EcuxleNVSOF5Fg0eKENHI';` | `const SUPABASE_ANON_KEY = 'STAGING_ANON_KEY';`           |
| `set-password.html` | ~79       | `var SUPABASE_URL = 'https://cqijyhudfiteivejcgox.supabase.co';`                    | `var SUPABASE_URL = 'https://STAGING-PROJECT.supabase.co';`   |
| `set-password.html` | ~80       | `var SUPABASE_ANON_KEY = 'eyJhbGci…08wZTXZSQvB98VEKCMLVc0EcuxleNVSOF5Fg0eKENHI';`   | `var SUPABASE_ANON_KEY = 'STAGING_ANON_KEY';`            |

> The full prod anon JWT (truncated above for readability) is the same string in all three files.
> Replace the entire token, not just the `ref` claim inside it — use the staging project's anon key.

---

## B. Production domain `fleet.ins2day.com`

### B.1 Marketing HTML — canonical / Open Graph / JSON-LD tags

| File             | Approx line | Current prod value                                                          | Replace-with for staging                                       |
| ---------------- | ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `index.html`     | ~11         | `<link rel="canonical" href="https://fleet.ins2day.com/">`                  | `<link rel="canonical" href="https://staging.your-domain.com/">` |
| `index.html`     | ~14         | `<meta property="og:url" content="https://fleet.ins2day.com/">`            | `…content="https://staging.your-domain.com/">`                 |
| `index.html`     | ~29         | `"url": "https://fleet.ins2day.com",` (JSON-LD)                             | `"url": "https://staging.your-domain.com",`                    |
| `about.html`     | ~11         | `<link rel="canonical" href="https://fleet.ins2day.com/about.html">`       | `…href="https://staging.your-domain.com/about.html">`          |
| `about.html`     | ~13         | `<meta property="og:url" content="https://fleet.ins2day.com/about.html">` | `…content="https://staging.your-domain.com/about.html">`       |
| `commercial.html`| ~11         | `<link rel="canonical" href="https://fleet.ins2day.com/commercial.html">` | `…href="https://staging.your-domain.com/commercial.html">`     |
| `commercial.html`| ~13         | `<meta property="og:url" content="https://fleet.ins2day.com/commercial.html">` | `…content="https://staging.your-domain.com/commercial.html">` |
| `quote.html`     | ~11         | `<link rel="canonical" href="https://fleet.ins2day.com/quote.html">`      | `…href="https://staging.your-domain.com/quote.html">`          |
| `quote.html`     | ~13         | `<meta property="og:url" content="https://fleet.ins2day.com/quote.html">` | `…content="https://staging.your-domain.com/quote.html">`       |

> SEO-only tags; harmless if left, but to fully avoid staging masquerading as prod (and to keep
> search engines from indexing staging as the canonical site) swap them.

### B.2 `lib/twilio-auth.js` — CORS allow-list

| File                 | Approx line | Current prod value                  | Replace-with for staging                                  |
| -------------------- | ----------- | ----------------------------------- | --------------------------------------------------------- |
| `lib/twilio-auth.js` | ~14         | `'https://fleet.ins2day.com',` (first entry of `ALLOWED_ORIGINS`, line 13–16) | `'https://staging.your-domain.com',` (keep `http://localhost:3000`) |

### B.3 `api/twilio/voice.js` — voicemail prompt copy

| File                  | Approx line | Current prod value                                                | Replace-with for staging                                  |
| --------------------- | ----------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `api/twilio/voice.js` | ~50         | `'…or visit fleet dot ins2day dot com for an instant quote.'` (spoken TwiML) | spoken staging domain, or leave (cosmetic; test creds never play it) |

### B.4 `supabase/functions/admin-create-agent/index.ts` — CORS

| File                                          | Approx line | Current prod value                                                              | Replace-with for staging                                            |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `supabase/functions/admin-create-agent/index.ts` | ~7      | `const ALLOWED = ['https://fleet.ins2day.com', 'http://localhost:3000'];`       | `const ALLOWED = ['https://staging.your-domain.com', 'http://localhost:3000'];` |
| `supabase/functions/admin-create-agent/index.ts` | ~15     | regex `^https:\/\/aiis-trucking-website[a-z0-9-]*\.vercel\.app$`                 | update to match the **staging** Vercel project name, e.g. `^https:\/\/aduna-dialer-staging[a-z0-9-]*\.vercel\.app$` |

> Redeploy the edge function to the **staging** Supabase project after editing (see `STAGING.md` §3,
> Step 4).

### B.5 Other `fleet.ins2day.com` occurrences (env-overridable — prefer env vars over editing source)

These have an env-var override, so set the env var in staging instead of editing the file. Listed so
you know they exist:

| File                            | Approx line(s)        | Hardcoded fallback                                   | How to override for staging                          |
| ------------------------------- | --------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `api/twilio/dial.js`            | ~104, ~106, ~194      | `process.env.BASE_URL \|\| 'https://fleet.ins2day.com'` | set `BASE_URL` env var                               |
| `api/twilio/connect.js`         | ~40 (spoken), ~51     | `process.env.BASE_URL \|\| 'https://fleet.ins2day.com'` | set `BASE_URL` env var                               |
| `api/twilio/numbers.js`         | ~67                   | `process.env.BASE_URL \|\| 'https://fleet.ins2day.com'` | set `BASE_URL` env var                               |
| `api/quote.js`                  | ~24, ~26, ~27, ~36    | prod Supabase URL / `veronica@fleet.ins2day.com` / `trucking@ins2day.com` / CORS origin | set `SUPABASE_URL`, `FROM_EMAIL`, `QUOTE_NOTIFY_EMAIL` env vars (CORS origin ~36 is hardcoded — edit if the public quote form is used in staging) |
| `api/email/send.js`             | ~19, ~21, ~25, ~39, ~233, ~245, ~248 | prod Supabase URL / `FROM_EMAIL` / unsubscribe + logo + footer links / CORS allow-list | set `SUPABASE_URL`, `FROM_EMAIL` env vars; the literal `https://fleet.ins2day.com/...` links + CORS array are hardcoded — edit if exercising email in staging |
| `api/email/webhook.js`          | ~16                   | prod Supabase URL fallback                           | set `SUPABASE_URL` env var                           |
| `api/email/reply-webhook.js`    | ~10                   | prod Supabase URL fallback                           | set `SUPABASE_URL` env var                           |
| `api/cron/daily-summary.js`     | ~11, ~18              | prod Supabase URL fallback / CORS allow-list         | set `SUPABASE_URL` env var; CORS array ~18 hardcoded — edit if needed |
| `lib/twilio-auth.js`            | ~59                   | `process.env.SUPABASE_URL \|\| 'https://cqijyhudfiteivejcgox.supabase.co'` | set `SUPABASE_URL` env var                           |
| `scripts/generate-ca-leads.js`  | ~12                   | hardcoded prod Supabase URL (no env override)        | edit if running this script against staging          |

---

## C. Inbound forward number (`FORWARD_NUMBER`)

Hardcoded, **not** an env var.

| File                  | Approx line | Current prod value                       | Replace-with for staging                                            |
| --------------------- | ----------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `api/twilio/voice.js` | ~16         | `const FORWARD_NUMBER = '+19499698505';` | `const FORWARD_NUMBER = '+15005550006';` (a Twilio magic test number, or any test cell) |

> Only used by the inbound-call leg. With Twilio test creds staging can't receive real inbound calls,
> so this is mostly defensive — but change it so no staging code path forwards to the real cell.

---

## D. HubSpot meeting scheduler link

| File          | Approx line | Current prod value                                              | Replace-with for staging                                            |
| ------------- | ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `portal.html` | ~2455       | `var url = 'https://meetings.hubspot.com/kaduna/demo' + (...);` | `var url = 'https://meetings.hubspot.com/STAGING-MEETING-SLUG/demo' + (...);` (a test/sandbox HubSpot meeting link, or leave as-is if you don't want staging reps booking real demos — but a non-prod slug is safer) |

> Booking from staging would create **real** HubSpot meetings on the prod `kaduna` calendar. Point at
> a throwaway scheduler slug for staging, or disable the button, so test clicks don't book real demos.

---

## Quick checklist (apply on the `staging` branch only)

- [ ] A — Supabase URL + anon key in `portal.html`, `login.html`, `set-password.html`
- [ ] B.1 — canonical/OG/JSON-LD domain in `index/about/commercial/quote.html`
- [ ] B.2 — `lib/twilio-auth.js` `ALLOWED_ORIGINS`
- [ ] B.4 — edge function `ALLOWED` + vercel.app regex (then redeploy to staging Supabase)
- [ ] C — `FORWARD_NUMBER` in `api/twilio/voice.js`
- [ ] D — HubSpot link in `portal.html`
- [ ] B.5 — set `BASE_URL`, `SUPABASE_URL`, `FROM_EMAIL`, `QUOTE_NOTIFY_EMAIL` env vars (no source edit needed for these)
- [ ] Keep these swaps in one isolated commit so they are **not** merged back to prod (see `STAGING.md` §4)
