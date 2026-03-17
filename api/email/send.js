/**
 * POST /api/email/send
 * Sends an email campaign to matching leads using Resend.
 *
 * Body: { campaignId, testMode?, testEmail? }
 * - campaignId: ID from crm_email_campaigns table
 * - testMode: if true, sends only to testEmail (for previewing)
 * - testEmail: email address for test sends
 *
 * Sends in batches of 10 with 1s delay between batches to avoid rate limits.
 * Tracks sent_count, open_count, click_count in crm_email_campaigns.
 * Logs each send to crm_activities.
 */
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Veronica at AdvancedIns.ai <veronica@fleet.ins2day.com>';
const DIALER_API_KEY = process.env.DIALER_API_KEY;

// Unsubscribe page URL
const UNSUBSCRIBE_URL = 'https://fleet.ins2day.com/unsubscribe.html';

module.exports = async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  const allowed = ['https://fleet.ins2day.com', 'http://localhost:3000'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== DIALER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured. Set it in Vercel env vars.' });
  }

  const resend = new Resend(RESEND_API_KEY);
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { campaignId, testMode, testEmail } = req.body || {};

  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

  try {
    // Get campaign
    const { data: campaign, error: cErr } = await sb
      .from('crm_email_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (cErr || !campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // TEST MODE — send single test email
    if (testMode) {
      const email = testEmail || 'cohua666@gmail.com';
      const html = buildEmailHtml(campaign.body_html, {
        first_name: 'Test', company: 'Test Trucking Co', city: 'Los Angeles'
      }, email);

      const { data, error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: [email],
        subject: campaign.subject.replace(/\{\{first_name\}\}/g, 'Test').replace(/\{\{company\}\}/g, 'Test Trucking Co'),
        html: html,
        headers: {
          'List-Unsubscribe': `<${UNSUBSCRIBE_URL}?email=${encodeURIComponent(email)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      });

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, test: true, messageId: data.id });
    }

    // LIVE MODE — send to all matching leads
    // Build query for matching leads with email addresses
    let query = sb.from('crm_leads')
      .select('id, contact_name, company_name, email, city, state, phone, segment, stage')
      .not('email', 'is', null)
      .neq('email', '');

    if (campaign.target_segment && campaign.target_segment !== 'all') {
      query = query.eq('segment', campaign.target_segment);
    }
    if (campaign.target_stage && campaign.target_stage !== 'all') {
      query = query.eq('stage', campaign.target_stage);
    }
    if (campaign.target_state && campaign.target_state !== 'all') {
      query = query.eq('state', campaign.target_state);
    }

    // Limit to 100 per send (warm-up period)
    const { data: leads, error: lErr } = await query.limit(100);
    if (lErr) return res.status(500).json({ error: 'Failed to query leads: ' + lErr.message });
    if (!leads || leads.length === 0) {
      return res.status(200).json({ success: true, sent: 0, message: 'No matching leads with email addresses' });
    }

    // Update campaign status
    await sb.from('crm_email_campaigns').update({
      status: 'sending',
      started_at: new Date().toISOString(),
      total_recipients: leads.length
    }).eq('id', campaignId);

    // Send in batches of 10
    let sentCount = 0;
    let failCount = 0;
    const batchSize = 10;

    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize);

      const promises = batch.map(async (lead) => {
        const firstName = (lead.contact_name || '').split(' ')[0] || 'there';
        const company = lead.company_name || 'your company';
        const city = lead.city || 'your area';

        const subject = campaign.subject
          .replace(/\{\{first_name\}\}/g, firstName)
          .replace(/\{\{company\}\}/g, company)
          .replace(/\{\{city\}\}/g, city);

        const html = buildEmailHtml(campaign.body_html, {
          first_name: firstName,
          company: company,
          city: city
        }, lead.email);

        try {
          const { data, error } = await resend.emails.send({
            from: FROM_EMAIL,
            to: [lead.email],
            subject: subject,
            html: html,
            headers: {
              'List-Unsubscribe': `<${UNSUBSCRIBE_URL}?email=${encodeURIComponent(lead.email)}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
          });

          if (error) {
            console.error(`Failed to send to ${lead.email}:`, error.message);
            failCount++;
            return;
          }

          sentCount++;

          // Log activity
          await sb.from('crm_activities').insert({
            lead_id: lead.id,
            type: 'email',
            description: `Campaign "${campaign.name}" sent — Subject: ${subject}`
          }).catch(() => {});

        } catch (e) {
          console.error(`Error sending to ${lead.email}:`, e.message);
          failCount++;
        }
      });

      await Promise.all(promises);

      // Small delay between batches to avoid rate limits
      if (i + batchSize < leads.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Update campaign stats
    await sb.from('crm_email_campaigns').update({
      status: 'sent',
      sent_count: sentCount,
      completed_at: new Date().toISOString()
    }).eq('id', campaignId);

    return res.status(200).json({
      success: true,
      sent: sentCount,
      failed: failCount,
      total: leads.length,
      campaignId: campaignId
    });

  } catch (e) {
    console.error('Campaign send error:', e);
    return res.status(500).json({ error: e.message });
  }
};

/**
 * Build the full email HTML with personalization, styling, and unsubscribe footer.
 */
function buildEmailHtml(bodyHtml, tokens, recipientEmail) {
  // Replace personalization tokens
  let html = (bodyHtml || '')
    .replace(/\{\{first_name\}\}/g, tokens.first_name || 'there')
    .replace(/\{\{company\}\}/g, tokens.company || 'your company')
    .replace(/\{\{city\}\}/g, tokens.city || 'your area');

  // Wrap in professional email template
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

<!-- Header -->
<tr><td style="background:#0f172a;padding:24px 32px;">
<img src="https://fleet.ins2day.com/logo.png" alt="AdvancedIns.ai" height="32" style="height:32px;" onerror="this.style.display='none'">
<span style="color:#ffffff;font-size:18px;font-weight:700;margin-left:8px;">AdvancedIns.ai</span>
</td></tr>

<!-- Body -->
<tr><td style="padding:32px;font-size:15px;line-height:1.6;color:#1e293b;">
${html}
</td></tr>

<!-- Footer -->
<tr><td style="padding:24px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.5;">
<p style="margin:0 0 8px;">AdvancedIns.ai — California Commercial Trucking Insurance<br>
<a href="https://fleet.ins2day.com" style="color:#3b82f6;">fleet.ins2day.com</a></p>
<p style="margin:0 0 8px;">You're receiving this because you were identified as a trucking company that may benefit from better insurance rates.</p>
<p style="margin:0;"><a href="${UNSUBSCRIBE_URL}?email=${encodeURIComponent(recipientEmail)}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a> ·
<a href="https://fleet.ins2day.com" style="color:#94a3b8;text-decoration:underline;">Visit our website</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
