/**
 * POST /api/twilio/token
 * Generate a Twilio Access Token for the browser Client SDK.
 * The browser uses this to register as a softphone.
 */
const twilio = require('twilio');
const { setCorsHeaders, verifySession, assertCanDial, getCallerOrgId } = require('../../lib/twilio-auth');
const { credentialsForOrg } = require('../../lib/twilio-provision');

module.exports = async function handler(req, res) {
  // CORS
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — require a logged-in CRM session
  if (!(await verifySession(req, res))) return;

  // Seats are dialer seats: the owner account does not get a softphone.
  if (!(await assertCanDial(req, res))) return;

  // Per-tenant credentials: a provisioned workspace signs tokens with its OWN
  // subaccount key, so its calls are billed and reputationally separate. An
  // unprovisioned workspace (and AIIS) falls back to this deployment's env
  // credentials - exactly the behaviour that shipped before subaccounts.
  const orgId = await getCallerOrgId(req);
  const creds = await credentialsForOrg(orgId);

  const TWILIO_ACCOUNT_SID = creds.accountSid;
  const TWILIO_API_KEY = creds.apiKey;
  const TWILIO_API_SECRET = creds.apiSecret;
  const TWILIO_TWIML_APP_SID = creds.twimlAppSid;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_TWIML_APP_SID) {
    return res.status(500).json({ error: 'Twilio credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, and TWILIO_TWIML_APP_SID in Vercel env vars.' });
  }

  try {
    const { body } = req;
    const identity = (body && body.identity) || 'aiis-agent';

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      { identity: identity, ttl: 3600 }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true
    });

    token.addGrant(voiceGrant);

    return res.status(200).json({
      token: token.toJwt(),
      identity: identity,
      credentials: creds.source
    });
  } catch (err) {
    console.error('Token generation error:', err);
    return res.status(500).json({ error: err.message });
  }
};
