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
 * @deprecated Replaced by verifySession — the static key was exposed in the public page source.
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

const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

/**
 * Verify the request carries a valid Supabase session (a logged-in CRM user).
 * The browser sends `Authorization: Bearer <supabase access token>`; we validate it against
 * Supabase server-side. Returns true if authorized; otherwise sends 401 and returns false.
 *
 * This replaces the static x-api-key, which was served inside portal.html to anyone who viewed
 * the page source and therefore protected nothing.
 */
async function verifySession(req, res) {
  const authz = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
  const token = m ? m[1].trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: sign in required' });
    return false;
  }
  if (!SUPABASE_KEY) {
    res.status(500).json({ error: 'Server misconfigured: Supabase key not set' });
    return false;
  }
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data || !data.user) {
      res.status(401).json({ error: 'Unauthorized: invalid or expired session' });
      return false;
    }
    return true;
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
}

/**
 * Resolve the per-agent caller ID for an authenticated request.
 * Looks up the calling user's profiles.twilio_caller_id (read under their own RLS scope via
 * their bearer token). Returns that number if it's a valid US E.164 caller ID; otherwise the
 * provided fallback (the shared default number). So each rep dials from their own assigned
 * number, and anyone without one assigned falls back to the default. Never throws.
 */
async function getCallerIdForRequest(req, fallbackNumber) {
  try {
    const authz = req.headers['authorization'] || req.headers['Authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
    const token = m ? m[1].trim() : '';
    const apikey = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;
    if (!token || !apikey) return fallbackNumber;
    const sb = createClient(SUPABASE_URL, apikey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: 'Bearer ' + token } }
    });
    const { data: u } = await sb.auth.getUser(token);
    if (!u || !u.user) return fallbackNumber;
    const { data: prof } = await sb.from('profiles').select('twilio_caller_id').eq('id', u.user.id).maybeSingle();
    const cid = prof && prof.twilio_caller_id ? String(prof.twilio_caller_id).trim() : '';
    return /^\+1[2-9]\d{9}$/.test(cid) ? cid : fallbackNumber;
  } catch (e) {
    return fallbackNumber;
  }
}

/**
 * Resolve the Supabase user for the request's bearer token, or null.
 */
async function getSessionUser(req) {
  const authz = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
  const token = m ? m[1].trim() : '';
  if (!token || !SUPABASE_KEY) return null;
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (e) {
    return null;
  }
}

/**
 * Require that the request comes from an authenticated MASTER (admin).
 * Returns the user object if so; otherwise sends 401/403 and returns null.
 * Reads profiles.role with the service-role key (reliable, RLS-independent).
 */
async function requireMaster(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: sign in required' });
    return null;
  }
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: prof } = await sb.from('profiles').select('role, active').eq('id', user.id).maybeSingle();
    if (!prof || prof.role !== 'master' || prof.active !== true) {
      res.status(403).json({ error: 'Forbidden: admin access required' });
      return null;
    }
    return user;
  } catch (e) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
}

/**
 * Seats are DIALER seats. On a paid plan the owner (master) account is a free
 * admin login that cannot dial — otherwise a 1-seat customer could dial from
 * both the owner account and their one agent, getting two dialers for the price
 * of one. Blocking it in the UI alone would be cosmetic, so the softphone token
 * and the outbound-call endpoint both check here.
 *
 * The internal AIIS workspace is exempt: its masters dial every day and it has
 * no seat limit.
 *
 * Returns true when the request may dial; otherwise sends 403 and returns
 * false. Fails OPEN on an unexpected error — a lookup blip must not take a
 * paying rep off the phones.
 */
async function assertCanDial(req, res) {
  try {
    const user = await getSessionUser(req);
    if (!user) return true; // verifySession already gates authentication

    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: prof } = await sb
      .from('profiles')
      .select('role, org_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!prof) return true; // unknown profile: fail open, RLS still applies

    // A switched-off user keeps a valid JWT until it expires. verifySession
    // only proves the token is real, so without this they could keep dialing.
    if (prof.active === false) {
      res.status(403).json({
        error: 'This account has been deactivated. Contact your account owner.',
        code: 'user_inactive',
      });
      return false;
    }

    const { data: org } = await sb
      .from('orgs')
      .select('plan, active')
      .eq('id', prof.org_id)
      .maybeSingle();

    if (!org) return true;

    // Canceled subscription. RLS already empties their data, but that is only
    // a read control - placing a call spends OUR telephony balance, so it has
    // to be blocked here too. Note past_due is deliberately NOT blocked: that
    // is the dunning grace period and the team keeps working.
    if (org.active === false) {
      res.status(403).json({
        error: 'Your Aduna Dialer subscription is inactive, so calling is turned off. '
             + 'Restart your subscription at adunadialer.com to pick up where you left off.',
        code: 'subscription_inactive',
      });
      return false;
    }

    if (prof.role !== 'master') return true; // dialers dial

    if (org.plan === 'internal') return true;

    res.status(403).json({
      error: 'The owner account is for managing your team and does not include a dialing seat. '
           + 'Add yourself as a dialer from the Dashboard if you want to dial.',
      code: 'owner_cannot_dial',
    });
    return false;
  } catch (e) {
    console.error('assertCanDial failed open:', e && e.message);
    return true;
  }
}

module.exports = { setCorsHeaders, verifyRequest, verifySession, getSessionUser, requireMaster, assertCanDial, getCallerIdForRequest, ALLOWED_ORIGINS };
