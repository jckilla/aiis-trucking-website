/**
 * POST /api/twilio/hangup
 * End active call(s) by CallSid
 * Body: { callSid: "CA..." } or { callSids: ["CA...", "CA..."] }
 */
const twilio = require('twilio');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return res.status(500).json({ error: 'Twilio not configured' });
  }

  const { callSid, callSids } = req.body || {};
  const sids = callSids || (callSid ? [callSid] : []);
  if (sids.length === 0) return res.status(400).json({ error: 'Missing callSid or callSids' });

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
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
