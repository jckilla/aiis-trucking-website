/**
 * POST /api/unsubscribe
 * Records an email opt-out for the public unsubscribe page (unsubscribe.html) and the
 * one-click List-Unsubscribe header.
 *
 * Body (JSON): { email, sig? }
 *  - email: the address to suppress
 *  - sig:   HMAC signature from the email link (optional for legacy links). When present it MUST
 *           be valid, which stops anyone from forging a link to unsubscribe an arbitrary address.
 *
 * Uses the Supabase SERVICE ROLE key so it works against the locked-down, authenticated-only RLS
 * policies (the anonymous key — which the old unsubscribe.html used — now has no DB access). It sets
 * the dedicated `crm_leads.unsubscribed` flag; the email-send query excludes those rows.
 */
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

function expectedSig(email) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.UNSUBSCRIBE_SECRET || 'aiis-unsub';
  return crypto.createHmac('sha256', secret).update(String(email).toLowerCase()).digest('hex').slice(0, 24);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://fleet.ins2day.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();
  const sig = (b.sig || '').trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  // If a signature is supplied it must verify (anti-abuse for current links). Legacy links without a
  // signature are still honored, because failing to honor an opt-out is the worse outcome.
  if (sig) {
    const exp = expectedSig(email);
    const ok = sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
    if (!ok) return res.status(403).json({ error: 'This unsubscribe link is invalid or expired.' });
  }
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server misconfigured.' });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  try {
    // Case-insensitive match so mixed-case stored addresses are still suppressed.
    const { error } = await sb.from('crm_leads')
      .update({ unsubscribed: true, updated_at: new Date().toISOString() })
      .ilike('email', email);
    if (error) {
      console.error('unsubscribe update failed:', error.message);
      return res.status(500).json({ error: 'Could not process your request. Please email veronica@fleet.ins2day.com.' });
    }

    // Best-effort activity log (don't fail the opt-out if this errors).
    const { data: lead } = await sb.from('crm_leads').select('id').ilike('email', email).limit(1).maybeSingle();
    if (lead && lead.id) {
      await sb.from('crm_activities').insert({
        lead_id: lead.id, type: 'email', description: 'Lead unsubscribed from emails (one-click)'
      }).catch(() => {});
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('unsubscribe error:', e.message);
    return res.status(500).json({ error: 'Could not process your request. Please email veronica@fleet.ins2day.com.' });
  }
};
