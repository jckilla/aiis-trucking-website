/**
 * /api/twilio/status
 *
 * POST — Twilio call status webhook (called by Twilio servers, no API key needed)
 * GET  — Browser poll for call status (requires API key)
 *   Query: ?callSid=CA...&callSid=CA... (one or more)
 */
const twilio = require('twilio');
const { setCorsHeaders, verifySession, getCallerOrg } = require('../../lib/twilio-auth');
const { twilioClientForOrg, sendTelephonyError } = require('../../lib/twilio-provision');

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — browser polls call status
  if (req.method === 'GET') {
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

    // Accept ?callSid=CA1&callSid=CA2 or ?callSids=CA1,CA2
    let sids = req.query.callSid
      ? (Array.isArray(req.query.callSid) ? req.query.callSid : [req.query.callSid])
      : [];
    if (req.query.callSids) {
      sids = sids.concat(req.query.callSids.split(','));
    }
    sids = sids.filter(s => s && s.startsWith('CA'));

    if (sids.length === 0) {
      return res.status(400).json({ error: 'Provide callSid query parameter(s)' });
    }

    try {
      const results = await Promise.allSettled(
        sids.map(sid => client.calls(sid).fetch())
      );
      const statuses = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          const c = r.value;
          statuses[sids[i]] = {
            status: c.status,           // queued, ringing, in-progress, completed, busy, no-answer, canceled, failed
            answeredBy: c.answeredBy,   // human, machine_start, machine_end_beep, etc.
            duration: c.duration,
            direction: c.direction
          };
        } else {
          statuses[sids[i]] = { status: 'unknown', error: r.reason?.message };
        }
      });
      return res.status(200).json({ statuses });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — Twilio webhook (no API key needed)
  if (req.method === 'POST') {
    const body = req.body || {};
    const {
      CallSid,
      CallStatus,
      CallDuration,
      AnsweredBy,
      From,
      To,
      Direction
    } = body;

    const leadId = req.query.leadId || body.leadId || '';
    const line = req.query.line || body.line || '';

    console.log(`[Call Status] SID=${CallSid} Status=${CallStatus} AnsweredBy=${AnsweredBy || 'N/A'} Duration=${CallDuration || 0}s Lead=${leadId} Line=${line}`);

    return res.status(200).json({ received: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
