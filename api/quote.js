/**
 * POST /api/quote
 * Public endpoint for the website quote form (quote.html).
 *
 * Does two things the old email-only flow did not:
 *   1. Creates a lead in crm_leads (so web quotes enter the CRM pipeline / dialer).  [fixes bug #5]
 *   2. Emails the agent the request WITH the uploaded documents attached via Resend. [fixes bug #4]
 *
 * Body (JSON): {
 *   firstName, lastName, email, phone, address,
 *   dot, mc, units, insuranceType, notes,
 *   files: [{ name, type, b64 }],   // base64 (no data: prefix), total kept small by the client
 *   skippedFiles: [{ name, size }]  // files the client left out because the batch was too large
 * }
 *
 * Uses the Supabase SERVICE ROLE key (server-only secret) so it works with the
 * locked-down, authenticated-only RLS policies — the public anon key has no DB access.
 */
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Veronica at AdvancedIns.ai <veronica@fleet.ins2day.com>';
const NOTIFY_EMAIL = process.env.QUOTE_NOTIFY_EMAIL || 'trucking@ins2day.com';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = async function handler(req, res) {
  // Same-origin form, but set permissive CORS for safety on the public site
  res.setHeader('Access-Control-Allow-Origin', 'https://fleet.ins2day.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Email opt-out is served here (POST /api/quote?op=unsubscribe) rather than as its own function,
  // because the Vercel Hobby plan caps the project at 12 serverless functions.
  if (req.query && req.query.op === 'unsubscribe') {
    return handleUnsubscribe(req, res);
  }

  const b = req.body || {};
  const firstName = (b.firstName || '').trim();
  const lastName = (b.lastName || '').trim();
  const email = (b.email || '').trim();

  // Minimal validation — block empty/garbage submissions
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!firstName && !lastName) {
    return res.status(400).json({ error: 'A name is required.' });
  }

  const fullName = (firstName + ' ' + lastName).trim();
  const phone = (b.phone || '').trim();
  const address = (b.address || '').trim();
  const dot = (b.dot || '').trim();
  const mc = (b.mc || '').trim();
  const units = (b.units || '').toString().trim();
  const insuranceType = (b.insuranceType || '').trim();
  const userNotes = (b.notes || '').trim();
  const files = Array.isArray(b.files) ? b.files.slice(0, 10) : [];
  const skipped = Array.isArray(b.skippedFiles) ? b.skippedFiles : [];

  const unitsNum = parseInt(units, 10);
  const noteLines = [
    'Submitted via website quote form (fleet.ins2day.com/quote.html)',
    insuranceType ? 'Coverage requested: ' + insuranceType : '',
    mc ? 'MC Number: ' + mc : '',
    units ? 'Units/Vehicles: ' + units : '',
    userNotes ? 'Notes: ' + userNotes : '',
    skipped.length ? 'NOTE: ' + skipped.length + ' file(s) were too large to attach automatically — follow up to collect them: ' + skipped.map(f => f.name).join(', ') : ''
  ].filter(Boolean);

  const sb = SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

  // 1) Create the CRM lead (best-effort — never block the customer on a DB hiccup)
  let leadId = null;
  if (sb) {
    try {
      const lead = {
        company_name: fullName || 'Website Quote',
        contact_name: fullName || null,
        phone: phone || null,
        email: email,
        dot_number: (dot && dot.toLowerCase() !== 'not provided') ? dot : null,
        address: address || null,
        stage: 'lead',
        source: 'website_quote',
        lead_score: 60,
        notes: noteLines.join('\n'),
        last_contacted_at: null
      };
      if (!isNaN(unitsNum) && unitsNum > 0) { lead.power_units = unitsNum; lead.trucks = unitsNum; }

      const { data, error } = await sb.from('crm_leads').insert(lead).select('id').single();
      if (error) {
        console.error('quote: lead insert failed:', error.message);
      } else {
        leadId = data ? data.id : null;
        if (leadId) {
          await sb.from('crm_activities').insert({
            lead_id: leadId, type: 'note',
            description: 'New website quote request — ' + (insuranceType || 'coverage') + (files.length ? ' (' + files.length + ' document(s) attached, emailed to agent)' : '')
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('quote: lead insert exception:', e.message);
    }
  }

  // 2) Email the agent the request + attachments via Resend
  let emailed = false;
  if (RESEND_API_KEY) {
    try {
      const resend = new Resend(RESEND_API_KEY);
      const rows = [
        ['Name', fullName], ['Email', email], ['Phone', phone || '—'], ['Address', address || '—'],
        ['DOT', dot || '—'], ['MC', mc || '—'], ['Units', units || '—'], ['Coverage', insuranceType || '—']
      ].map(r => `<tr><td style="padding:6px 12px;color:#64748b;font-weight:600;white-space:nowrap;">${esc(r[0])}</td><td style="padding:6px 12px;color:#0f172a;">${esc(r[1])}</td></tr>`).join('');

      const attachments = files
        .filter(f => f && f.b64 && f.name)
        .map(f => ({ filename: String(f.name), content: String(f.b64) }));

      const skippedHtml = skipped.length
        ? `<p style="color:#b45309;font-size:13px;margin:12px 0 0;">⚠ ${skipped.length} file(s) were too large to attach automatically — ask the customer to email them: ${esc(skipped.map(f => f.name).join(', '))}</p>`
        : '';

      const html = `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;margin:0 auto;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
<tr><td style="background:#0f172a;padding:20px 28px;color:#fff;font-size:17px;font-weight:700;">New Quote Request — AdvancedIns.ai</td></tr>
<tr><td style="padding:24px 28px;">
<p style="margin:0 0 16px;color:#0f172a;font-size:15px;">A new quote request came in from the website${leadId ? ` and was added to the CRM as lead #${leadId}` : ''}.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;border-collapse:collapse;">${rows}</table>
${userNotes ? `<p style="margin:16px 0 0;color:#0f172a;font-size:14px;"><strong>Notes:</strong><br>${esc(userNotes)}</p>` : ''}
${attachments.length ? `<p style="margin:16px 0 0;color:#16a34a;font-size:13px;">📎 ${attachments.length} document(s) attached to this email.</p>` : '<p style="margin:16px 0 0;color:#64748b;font-size:13px;">No documents were uploaded.</p>'}
${skippedHtml}
</td></tr>
</table></body></html>`;

      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        reply_to: email,
        subject: `New Quote Request — ${fullName || email}${insuranceType ? ' | ' + insuranceType : ''}`,
        html: html,
        attachments: attachments.length ? attachments : undefined
      });
      if (error) console.error('quote: resend failed:', error.message);
      else emailed = true;
    } catch (e) {
      console.error('quote: resend exception:', e.message);
    }
  }

  // Success if we captured the lead OR notified the agent. The client also keeps
  // its own EmailJS notification as a backstop, so a lead is never silently lost.
  if (leadId || emailed) {
    return res.status(200).json({ success: true, leadId: leadId, emailed: emailed });
  }
  return res.status(500).json({ error: 'Could not record the quote. Please call (657) 366-5312.' });
};

// ===================== EMAIL OPT-OUT (POST /api/quote?op=unsubscribe) =====================
// Records an unsubscribe for the public unsubscribe page and one-click List-Unsubscribe.
// Body: { email, sig? }. A present signature must verify (HMAC keyed on the server-only
// service-role secret) so a link can't be forged to opt out an arbitrary address; legacy
// links without a signature are still honored. Uses the service-role key (the locked-down
// RLS blocks the anon key the old page relied on, which never worked anyway).
function unsubExpectedSig(email) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.UNSUBSCRIBE_SECRET || 'aiis-unsub';
  return crypto.createHmac('sha256', secret).update(String(email).toLowerCase()).digest('hex').slice(0, 24);
}

async function handleUnsubscribe(req, res) {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();
  const sig = (b.sig || '').trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (sig) {
    const exp = unsubExpectedSig(email);
    const ok = sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
    if (!ok) return res.status(403).json({ error: 'This unsubscribe link is invalid or expired.' });
  }
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server misconfigured.' });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  try {
    const { error } = await sb.from('crm_leads')
      .update({ unsubscribed: true, updated_at: new Date().toISOString() })
      .ilike('email', email);
    if (error) {
      console.error('unsubscribe update failed:', error.message);
      return res.status(500).json({ error: 'Could not process your request. Please email veronica@fleet.ins2day.com.' });
    }
    // Best-effort activity log — must never affect the opt-out result (the opt-out already succeeded).
    try {
      const { data: leads } = await sb.from('crm_leads').select('id').ilike('email', email).limit(1);
      const lead = leads && leads[0];
      if (lead && lead.id) {
        await sb.from('crm_activities').insert({
          lead_id: lead.id, type: 'email', description: 'Lead unsubscribed from emails (one-click)'
        });
      }
    } catch (_) { /* ignore — opt-out is recorded */ }
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('unsubscribe error:', e.message);
    return res.status(500).json({ error: 'Could not process your request. Please email veronica@fleet.ins2day.com.' });
  }
}
