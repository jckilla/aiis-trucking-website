/**
 * GET  /api/twilio/numbers — list all owned numbers with area codes
 * POST /api/twilio/numbers — buy a number for a specific area code
 *   Body: { areaCode: "657" }
 */
const twilio = require('twilio');
const { setCorsHeaders, verifySession, getCallerOrg } = require('../../lib/twilio-auth');
const { twilioClientForOrg, sendTelephonyError } = require('../../lib/twilio-provision');

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

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
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  if (req.method === 'GET') {
    // List all owned numbers
    try {
      const numbers = await client.incomingPhoneNumbers.list({ limit: 200 });
      const pool = numbers.map(n => {
        const match = n.phoneNumber.match(/^\+1(\d{3})/);
        return {
          sid: n.sid,
          phoneNumber: n.phoneNumber,
          areaCode: match ? match[1] : null,
          friendlyName: n.friendlyName,
          dateCreated: n.dateCreated
        };
      });

      // Group by area code
      const byAreaCode = {};
      pool.forEach(n => {
        if (n.areaCode) {
          if (!byAreaCode[n.areaCode]) byAreaCode[n.areaCode] = [];
          byAreaCode[n.areaCode].push(n);
        }
      });

      return res.status(200).json({
        total: pool.length,
        numbers: pool,
        byAreaCode: byAreaCode,
        areaCodes: Object.keys(byAreaCode).sort()
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    // Buy a number for a specific area code
    const { areaCode } = req.body || {};
    if (!areaCode || areaCode.length !== 3) {
      return res.status(400).json({ error: 'Provide a 3-digit areaCode' });
    }

    try {
      const baseUrl = process.env.BASE_URL || 'https://fleet.ins2day.com';

      // Search available numbers
      const available = await client.availablePhoneNumbers('US')
        .local
        .list({ areaCode: areaCode, limit: 5, voiceEnabled: true });

      if (available.length === 0) {
        return res.status(404).json({ error: `No numbers available for area code ${areaCode}` });
      }

      // Purchase the first available
      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        friendlyName: `AIIS-Pool-${areaCode}`,
        voiceUrl: `${baseUrl}/api/twilio/voice`,
        voiceMethod: 'POST',
        statusCallback: `${baseUrl}/api/twilio/status`,
        statusCallbackMethod: 'POST'
      });

      return res.status(200).json({
        success: true,
        phoneNumber: purchased.phoneNumber,
        areaCode: areaCode,
        sid: purchased.sid,
        monthlyCost: '$1.15'
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
