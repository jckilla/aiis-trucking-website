/**
 * Shared authentication middleware for Twilio API endpoints.
 *
 * Browser-facing endpoints (token, dial, numbers, hangup):
 *   - Requires x-api-key header matching DIALER_API_KEY env var
 *   - Restricts CORS to allowed domains
 *
 * Webhook endpoints (status, connect, voice):
 *   - Called by Twilio servers, not browsers
 *   - Should use setCorsHeaders() but skip API key auth
 */

const ALLOWED_ORIGINS = [
  'https://fleet.ins2day.com',
  'http://localhost:3000'
];

/**
 * Set restricted CORS headers on the response.
 * Returns the matched origin or null.
 */
function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // No Access-Control-Allow-Origin header = browser will block
    // For non-browser requests (Twilio webhooks), this is fine
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.setHeader('Vary', 'Origin');
}

/**
 * Verify that the request has a valid API key.
 * Returns true if authorized, false if not (and sends 401 response).
 */
function verifyRequest(req, res) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.DIALER_API_KEY;

  if (!expectedKey) {
    console.error('DIALER_API_KEY env var is not set');
    res.status(500).json({ error: 'Server misconfigured: DIALER_API_KEY not set' });
    return false;
  }

  if (!apiKey || apiKey !== expectedKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing x-api-key' });
    return false;
  }

  return true;
}

module.exports = { setCorsHeaders, verifyRequest, ALLOWED_ORIGINS };
