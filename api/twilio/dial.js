/**
 * POST /api/twilio/dial
 * Initiates an outbound call to a lead using a Twilio number
 * that matches the lead's area code.
 *
 * Body: { to: "+16575551234", leadId: 123, line: 1 }
 *
 * Flow:
 *  1. Extract area code from lead's phone
 *  2. Search our Twilio number pool for a matching area code
 *  3. If no match found, auto-provision a number with that area code
 *  4. If can't provision, fall back to default number
 *  5. Initiate call from matching number to lead
 */
const twilio = require('twilio');
const { setCorsHeaders, verifyRequest } = require('./auth');

// In-memory cache of owned numbers (refreshed every 5 min)
let numberPoolCache = null;
let numberPoolCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Rate limiting: simple in-memory counter (100 calls/hour)
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
let rateLimitCount = 0;
let rateLimitWindowStart = Date.now();

// Phone number validation
const US_PHONE_REGEX = /^\+1[2-9]\d{9}$/;
const PREMIUM_PREFIXES = ['+1900', '+1976'];

function normalizePhone(phone) {
  if (!phone) return null;
  // Strip everything except digits
  let digits = phone.replace(/\D/g, '');
  // Handle US numbers
  if (digits.length === 10) digits = '1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  // If already has country code
  if (digits.length > 10) return '+' + digits;
  return null;
}

function extractAreaCode(e164Phone) {
  if (!e164Phone) return null;
  // US numbers: +1AAANNNNNNN
  const match = e164Phone.match(/^\+1(\d{3})/);
  return match ? match[1] : null;
}

function checkRateLimit() {
  const now = Date.now();
  if (now - rateLimitWindowStart > RATE_LIMIT_WINDOW) {
    rateLimitCount = 0;
    rateLimitWindowStart = now;
  }
  rateLimitCount++;
  return rateLimitCount <= RATE_LIMIT_MAX;
}

async function getNumberPool(client) {
  const now = Date.now();
  if (numberPoolCache && (now - numberPoolCacheTime) < CACHE_TTL) {
    return numberPoolCache;
  }

  try {
    const numbers = await client.incomingPhoneNumbers.list({ limit: 200 });
    numberPoolCache = numbers.map(n => ({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      areaCode: extractAreaCode(n.phoneNumber),
      friendlyName: n.friendlyName
    }));
    numberPoolCacheTime = now;
    return numberPoolCache;
  } catch (err) {
    console.error('Failed to fetch number pool:', err);
    return numberPoolCache || [];
  }
}

async function findOrProvisionNumber(client, targetAreaCode, defaultNumber) {
  const pool = await getNumberPool(client);

  // 1. Check if we already own a number with this area code
  const match = pool.find(n => n.areaCode === targetAreaCode);
  if (match) {
    console.log(`Area code ${targetAreaCode}: using owned number ${match.phoneNumber}`);
    return match.phoneNumber;
  }

  // 2. Try to auto-provision a local number with matching area code
  try {
    const available = await client.availablePhoneNumbers('US')
      .local
      .list({ areaCode: targetAreaCode, limit: 1, voiceEnabled: true });

    if (available.length > 0) {
      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        friendlyName: `AIIS-AutoPool-${targetAreaCode}`,
        voiceUrl: (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.BASE_URL || 'https://fleet.ins2day.com') + '/api/twilio/voice',
        voiceMethod: 'POST',
        statusCallback: (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.BASE_URL || 'https://fleet.ins2day.com') + '/api/twilio/status',
        statusCallbackMethod: 'POST'
      });

      console.log(`Area code ${targetAreaCode}: auto-provisioned ${purchased.phoneNumber}`);

      // Bust cache so it includes the new number
      numberPoolCache = null;
      numberPoolCacheTime = 0;

      return purchased.phoneNumber;
    }
  } catch (err) {
    console.error(`Could not provision number for area code ${targetAreaCode}:`, err.message);
  }

  // 3. Try nearby area codes (same state) — skip for now, fall back to default
  console.log(`Area code ${targetAreaCode}: no match found, using default ${defaultNumber}`);
  return defaultNumber;
}

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
    TWILIO_DEFAULT_NUMBER,
    TWILIO_AUTO_PROVISION
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  // SEC-09: Require TWILIO_DEFAULT_NUMBER env var — no hardcoded fallback
  if (!TWILIO_DEFAULT_NUMBER) {
    return res.status(500).json({ error: 'TWILIO_DEFAULT_NUMBER env var is not set. Cannot place calls without a configured caller ID.' });
  }

  const { to, leadId, line, agentIdentity } = req.body || {};

  if (!to) {
    return res.status(400).json({ error: 'Missing "to" phone number' });
  }

  // Rate limiting
  if (!checkRateLimit()) {
    return res.status(429).json({ error: 'Rate limit exceeded: max 100 calls per hour' });
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const e164To = normalizePhone(to);

    if (!e164To) {
      return res.status(400).json({ error: 'Invalid phone number: ' + to });
    }

    // SEC-06: Validate US phone number format
    if (!US_PHONE_REGEX.test(e164To)) {
      return res.status(400).json({ error: 'Only US phone numbers are allowed (format: +1XXXXXXXXXX)' });
    }

    // SEC-06: Block premium rate numbers
    for (const prefix of PREMIUM_PREFIXES) {
      if (e164To.startsWith(prefix)) {
        return res.status(400).json({ error: 'Premium rate numbers are not allowed' });
      }
    }

    const targetAreaCode = extractAreaCode(e164To);

    // Fixed caller ID — always use the configured default number
    const callerId = TWILIO_DEFAULT_NUMBER;

    console.log(`Using fixed caller ID: ${callerId}`);

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : (process.env.BASE_URL || 'https://fleet.ins2day.com');

    // Create the outbound call
    // This calls the lead's phone, and when they pick up the TwiML from /api/twilio/voice
    // will bridge them to the agent's browser client
    const call = await client.calls.create({
      to: e164To,
      from: callerId,
      url: `${baseUrl}/api/twilio/connect?agentIdentity=${encodeURIComponent(agentIdentity || 'aiis-agent')}&leadId=${leadId || ''}&line=${line || 1}`,
      method: 'POST',
      statusCallback: `${baseUrl}/api/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      timeout: 30,
      machineDetection: 'DetectMessageEnd' // Detect voicemail/answering machines
    });

    console.log(`Call initiated: ${call.sid} from ${callerId} (area ${extractAreaCode(callerId)}) to ${e164To} (area ${targetAreaCode})`);

    return res.status(200).json({
      success: true,
      callSid: call.sid,
      from: callerId,
      fromAreaCode: extractAreaCode(callerId),
      to: e164To,
      toAreaCode: targetAreaCode,
      areaCodeMatch: extractAreaCode(callerId) === targetAreaCode,
      leadId: leadId,
      line: line
    });

  } catch (err) {
    console.error('Dial error:', err);
    return res.status(500).json({ error: err.message });
  }
};
