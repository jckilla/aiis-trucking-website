/**
 * POST /api/twilio/token
 * Generate a Twilio Access Token for the browser Client SDK.
 * The browser uses this to register as a softphone.
 */
const twilio = require('twilio');
const { setCorsHeaders, verifyRequest } = require('./auth');

module.exports = async function handler(req, res) {
  // CORS
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  if (!verifyRequest(req, res)) return;

  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    TWILIO_TWIML_APP_SID
  } = process.env;

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
      identity: identity
    });
  } catch (err) {
    console.error('Token generation error:', err);
    return res.status(500).json({ error: err.message });
  }
};
