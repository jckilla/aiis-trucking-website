/**
 * POST /api/twilio/hangup
 * End active call(s) by CallSid
 * Body: { callSid: "CA..." } or { callSids: ["CA...", "CA..."] }
 */
const twilio = require('twilio');
const { setCorsHeaders, verifySession, getCallerOrg } = require('../../lib/twilio-auth');
const { twilioClientForOrg, sendTelephonyError } = require('../../lib/twilio-provision');

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — require a logged-in CRM session
  if (!(await verifySession(req, res))) return;

  // Scope every REST call to the CALLER'S OWN Twilio account. A tenant acts on its own
  // subaccount; only AIIS ('internal') uses the parent. Without this, one tenant could act on
  // a CallSid belonging to another, and all usage landed on the owner's bill.
  let client;
  try {
    const org = await getCallerOrg(req);
    ({ client } = await twilioClientForOrg(org));
  } catch (e) {
    if (sendTelephonyError(res, e)) return;
    console.error('could not build a Twilio client:', e && e.message);
    return res.status(500).json({ error: 'Twilio not configured' });
  }

  const { callSid, callSids } = req.body || {};
  const sids = callSids || (callSid ? [callSid] : []);
  if (sids.length === 0) return res.status(400).json({ error: 'Missing callSid or callSids' });

  try {
    const results = await Promise.allSettled(
      sids.map(sid => client.calls(sid).update({ status: 'completed' }))
    );
    const summary = results.map((r, i) => ({
      callSid: sids[i],
      success: r.status === 'fulfilled',
      error: r.status === 'rejected' ? r.reason?.message : undefined
    }));
    return res.status(200).json({ success: true, results: summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
