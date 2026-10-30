/**
 * POST /api/admin/provision-telephony
 *
 * Gives a workspace its own Twilio subaccount, API key, TwiML app and phone
 * number. Body: { org_id, area_code?, dry_run? }
 *
 * ADMIN ONLY. This SPENDS MONEY (buying a number is a real charge), so it requires BOTH
 * the DIALER_API_KEY header AND an authenticated master session. The key alone used to be
 * the whole gate, and that key had been sitting in this repo's PUBLIC git history for
 * months - so the old claim that it was "never reachable from a customer session" was
 * false. Two independent factors now, so a leaked key is not sufficient by itself.
 *
 * Idempotent: an org that already has a subaccount is returned untouched.
 */
const { provisionOrg } = require('../../lib/twilio-provision');
const { setCorsHeaders, requireMaster } = require('../../lib/twilio-auth');

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const DIALER_API_KEY = process.env.DIALER_API_KEY;
  const supplied = req.headers['x-api-key'] || (req.body && req.body.api_key);

  // Fail closed: with no key configured, nobody can spend money through this.
  if (!DIALER_API_KEY || !supplied || supplied !== DIALER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // BOTH, not either. The key alone was the only gate until 2026-10-30, and the key had been
  // sitting in this repo's PUBLIC git history for months - so "never reachable from a customer
  // session" was not true: anyone who read the history could make us buy phone numbers.
  // Requiring a signed-in master as well means a leaked key is no longer sufficient on its own.
  if (!(await requireMaster(req, res))) return;

  const body = req.body || {};
  const orgId = String(body.org_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) {
    return res.status(400).json({ error: 'org_id (uuid) is required' });
  }

  try {
    const result = await provisionOrg(orgId, {
      areaCode: body.area_code,
      dryRun: body.dry_run === true,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('provision-telephony failed:', e && e.message);
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
