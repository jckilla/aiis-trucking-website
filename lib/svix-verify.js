/**
 * Svix / Resend webhook signature verification.
 *
 * Resend signs its webhooks with Svix. Verifying requires the EXACT raw request
 * body, so the calling endpoint must disable body parsing
 * (module.exports.config = { api: { bodyParser: false } }) and read the raw body
 * via readRawBody() before parsing JSON.
 *
 * verifySvix() returns true only when the signature is cryptographically valid.
 */
const crypto = require('crypto');

/**
 * Read the raw request body as a string.
 * Resolves '' if the stream was already consumed (e.g. a platform body-parser ran
 * first) so the caller can detect that verification is not possible.
 */
function readRawBody(req) {
  return new Promise((resolve) => {
    try {
      if (typeof req.body === 'string' && req.body.length) return resolve(req.body);
      let data = '';
      let got = false;
      req.on('data', (chunk) => { got = true; data += chunk; });
      req.on('end', () => resolve(got ? data : ''));
      req.on('error', () => resolve(''));
      // Safety timeout so a drained/never-emitting stream can't hang the function.
      setTimeout(() => resolve(got ? data : ''), 2500);
    } catch (e) {
      resolve('');
    }
  });
}

// Constant-time compare of two signature strings.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a Svix-signed webhook.
 * @param {string} rawBody exact raw request body bytes as a string
 * @param {object} headers req.headers (needs svix-id, svix-timestamp, svix-signature)
 * @param {string} secret  Svix signing secret, e.g. "whsec_..."
 * @returns {boolean}
 */
function verifySvix(rawBody, headers, secret) {
  try {
    if (!rawBody || !secret) return false;
    const id = headers['svix-id'];
    const ts = headers['svix-timestamp'];
    const sigHeader = headers['svix-signature'];
    if (!id || !ts || !sigHeader) return false;

    // Replay protection: reject timestamps more than 5 minutes from now.
    const now = Math.floor(Date.now() / 1000);
    const t = parseInt(ts, 10);
    if (!Number.isFinite(t) || Math.abs(now - t) > 300) return false;

    // The signing key is base64 after the "whsec_" prefix.
    const keyB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const key = Buffer.from(keyB64, 'base64');

    const signedContent = `${id}.${ts}.${rawBody}`;
    const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');

    // svix-signature is a space-separated list of "v1,<sig>" entries; any match passes.
    return sigHeader.split(' ').some((part) => {
      const idx = part.indexOf(',');
      const sig = idx >= 0 ? part.slice(idx + 1) : part;
      return sig && safeEqual(expected, sig);
    });
  } catch (e) {
    return false;
  }
}

module.exports = { readRawBody, verifySvix, safeEqual };
