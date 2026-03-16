/**
 * POST /api/twilio/hangup
 * End an active call by its CallSid
 * Body: { callSid: "CA..." }
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

  const { callSid } = req.body || {};
  if (!callSid) return res.status(400).json({ error: 'Missing callSid' });

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    await client.calls(callSid).update({ status: 'completed' });
    return res.status(200).json({ success: true, callSid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
