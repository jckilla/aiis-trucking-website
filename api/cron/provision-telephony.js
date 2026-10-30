/**
 * GET|POST /api/cron/provision-telephony
 *
 * Drains the telephony_provision_jobs outbox: gives each newly signed-up workspace its own
 * Twilio subaccount, API key, TwiML app and phone number.
 *
 * THIS SPENDS REAL MONEY. Buying a number is a charge, every time, and it recurs monthly for
 * as long as the number is held. Everything below exists to bound that:
 *
 *   - Vercel Cron auth only (Bearer CRON_SECRET). No API-key path: a shared static key is how
 *     the provisioning endpoint became reachable by anyone who read this repo's public history.
 *   - claim_provision_job() claims one row at a time with FOR UPDATE SKIP LOCKED, so two
 *     overlapping cron runs can never provision the same workspace twice.
 *   - PRIMARY KEY on org_id means one workspace can only ever have one job.
 *   - provisionOrg() is itself idempotent: it returns early if the org already has a subaccount.
 *   - DAILY_CAP below: if more workspaces than this provision in 24h, the runner STOPS and
 *     reports instead of spending. A legitimate day of signups does not look like that yet;
 *     a bug or an abuse burst does.
 *   - MAX_PER_RUN keeps any single invocation small and well inside the function timeout.
 *
 * Schedule lives in vercel.json.
 */
const { createClient } = require('@supabase/supabase-js');
const { provisionOrg } = require('../../lib/twilio-provision');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_PER_RUN = 3;    // numbers bought per invocation
const MAX_ATTEMPTS = 3;   // per workspace, before it is parked as 'failed'
const DAILY_CAP = 5;      // workspaces provisioned per rolling 24h before the runner refuses

module.exports = async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically.
  const expected = process.env.CRON_SECRET;
  const supplied = req.headers['authorization'];
  if (!expected || supplied !== 'Bearer ' + expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set' });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const summary = { claimed: 0, provisioned: 0, alreadyDone: 0, needsAttention: 0, failed: 0, detail: [] };

  // Blast-radius guard, checked BEFORE anything is claimed.
  const { count: recent } = await sb
    .from('telephony_provision_jobs')
    .select('org_id', { count: 'exact', head: true })
    .eq('status', 'done')
    .gte('completed_at', dayAgo);

  if ((recent || 0) >= DAILY_CAP) {
    console.error('provision runner halted: %d workspaces provisioned in 24h (cap %d)', recent, DAILY_CAP);
    return res.status(200).json({
      halted: true,
      reason: 'daily_cap_reached',
      provisioned_last_24h: recent,
      cap: DAILY_CAP,
      note: 'Refusing to buy more numbers until a human looks. Raise DAILY_CAP deliberately.',
    });
  }

  for (let i = 0; i < MAX_PER_RUN; i++) {
    const { data: claimed, error: claimErr } = await sb.rpc('claim_provision_job', { p_max_attempts: MAX_ATTEMPTS });
    if (claimErr) {
      console.error('claim failed:', claimErr.message);
      break;
    }
    const job = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!job || !job.org_id) break;   // queue empty

    summary.claimed++;
    const orgId = job.org_id;

    try {
      const result = await provisionOrg(orgId, { areaCode: job.area_code || undefined });

      // A retry after a PARTIAL failure takes provisionOrg's "already provisioned" early
      // return - it has a subaccount sid but never got as far as buying a number. Recording
      // that as success would leave a paying customer unable to dial, silently.
      if (result.alreadyProvisioned && !result.phoneNumber) {
        await sb.from('telephony_provision_jobs').update({
          status: 'needs_attention',
          last_error: 'Subaccount exists but no phone number - an earlier attempt died partway. '
                    + 'Finish it by hand in the Twilio console, then set the job to done.',
          updated_at: new Date().toISOString(),
        }).eq('org_id', orgId);
        summary.needsAttention++;
        summary.detail.push({ orgId, status: 'needs_attention' });
        continue;
      }

      await sb.from('telephony_provision_jobs').update({
        status: 'done',
        last_error: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('org_id', orgId);

      if (result.alreadyProvisioned) summary.alreadyDone++; else summary.provisioned++;
      summary.detail.push({ orgId, status: 'done', number: result.phoneNumber || null });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 400);
      const attempts = job.attempts || 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await sb.from('telephony_provision_jobs').update({
        status: exhausted ? 'failed' : 'pending',   // pending -> the next run retries it
        last_error: msg,
        updated_at: new Date().toISOString(),
      }).eq('org_id', orgId);
      summary.failed++;
      summary.detail.push({ orgId, status: exhausted ? 'failed' : 'will_retry', attempts, error: msg });
      console.error('provision failed for', orgId, 'attempt', attempts, msg);
    }
  }

  return res.status(200).json(summary);
};
