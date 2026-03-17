/**
 * POST /api/email/reply-webhook
 * Receives Resend inbound email webhooks when someone replies to veronica@fleet.ins2day.com.
 *
 * Parses the reply, matches to a lead, saves to crm_email_replies,
 * and auto-detects interest signals to move leads through the pipeline.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

// Interest detection keywords
const INTERESTED_KEYWORDS = [
  'quote', 'interested', 'pricing', 'rates', 'how much', 'cost',
  'save', 'compare', 'comparison', 'renewal', 'policy', 'coverage',
  'call me', 'reach out', 'available', 'schedule', 'appointment', 'yes'
];

const NOT_INTERESTED_KEYWORDS = [
  'unsubscribe', 'remove', 'stop', 'not interested', 'no thanks',
  "don't contact", 'dont contact', 'take me off', 'opt out', 'optout'
];

module.exports = async function handler(req, res) {
  // CORS — open for Resend inbound webhook
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-id, svix-signature, svix-timestamp');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const body = req.body;

  if (!body) {
    return res.status(400).json({ error: 'Empty request body' });
  }

  console.log('Inbound email webhook received:', JSON.stringify(body).substring(0, 500));

  try {
    // Resend inbound email webhook format
    // The payload may come as body.data for event-wrapped format, or directly
    const emailData = body.data || body;

    const fromEmail = extractFromEmail(emailData);
    const subject = emailData.subject || '(no subject)';
    const bodyText = emailData.text || emailData.body_text || '';
    const bodyHtml = emailData.html || emailData.body_html || '';

    if (!fromEmail) {
      console.warn('No sender email found in inbound webhook');
      return res.status(200).json({ received: true, warning: 'No sender email found' });
    }

    console.log('Reply from:', fromEmail, 'Subject:', subject);

    // Look up the lead by email
    const { data: lead, error: leadErr } = await sb
      .from('crm_leads')
      .select('id, contact_name, company_name, email, stage, notes')
      .eq('email', fromEmail)
      .limit(1)
      .maybeSingle();

    const leadId = lead ? lead.id : null;

    // Classify interest
    const classification = classifyInterest(subject + ' ' + bodyText);

    // Save the reply to crm_email_replies
    const replyRecord = {
      lead_id: leadId,
      from_email: fromEmail,
      subject: subject,
      body_text: bodyText.substring(0, 10000), // Limit size
      body_html: bodyHtml.substring(0, 50000),
      interest_classification: classification,
      received_at: new Date().toISOString()
    };

    const { error: insertErr } = await sb.from('crm_email_replies').insert(replyRecord);
    if (insertErr) {
      console.error('Failed to insert reply:', insertErr.message);
      // Don't fail the webhook — continue processing
    }

    // Log activity
    if (leadId) {
      const subjectPreview = subject.length > 60 ? subject.substring(0, 60) + '...' : subject;
      await sb.from('crm_activities').insert({
        lead_id: leadId,
        type: 'email_reply',
        description: 'Email reply received: "' + subjectPreview + '" [' + classification + ']'
      }).catch(() => {});

      // Auto-move lead based on classification
      if (classification === 'interested') {
        // Move to "lead" stage if currently a prospect
        if (lead.stage === 'prospect') {
          await sb.from('crm_leads').update({
            stage: 'lead',
            notes: ((lead.notes || '') + '\n[AUTO] reply_interested: ' + new Date().toISOString()).trim(),
            updated_at: new Date().toISOString()
          }).eq('id', leadId);

          await sb.from('crm_activities').insert({
            lead_id: leadId,
            type: 'stage_change',
            description: 'Auto-moved to Lead — interested email reply detected'
          }).catch(() => {});
        } else {
          // Just flag it
          await sb.from('crm_leads').update({
            notes: ((lead.notes || '') + '\n[AUTO] reply_interested: ' + new Date().toISOString()).trim(),
            updated_at: new Date().toISOString()
          }).eq('id', leadId).catch(() => {});
        }
      } else if (classification === 'not_interested') {
        await sb.from('crm_leads').update({
          stage: 'lost',
          notes: ((lead.notes || '') + '\n[AUTO] reply_not_interested: ' + new Date().toISOString()).trim(),
          updated_at: new Date().toISOString()
        }).eq('id', leadId);

        await sb.from('crm_activities').insert({
          lead_id: leadId,
          type: 'stage_change',
          description: 'Auto-moved to Lost — not interested email reply detected'
        }).catch(() => {});
      } else {
        // Unclear — flag for manual review
        await sb.from('crm_leads').update({
          notes: ((lead.notes || '') + '\n[AUTO] reply_needs_review: ' + new Date().toISOString()).trim(),
          updated_at: new Date().toISOString()
        }).eq('id', leadId).catch(() => {});
      }
    }

    // Update reply_count on the most recent campaign
    await incrementCampaignReplyCount(sb);

    return res.status(200).json({
      received: true,
      from: fromEmail,
      classification: classification,
      lead_matched: !!lead
    });

  } catch (e) {
    console.error('Reply webhook error:', e);
    return res.status(200).json({ received: true, error: e.message });
  }
};

function extractFromEmail(data) {
  // Resend inbound format variations
  if (data.from && typeof data.from === 'string') {
    // Could be "Name <email@domain.com>" format
    const match = data.from.match(/<([^>]+)>/);
    return match ? match[1].toLowerCase() : data.from.toLowerCase().trim();
  }
  if (data.from_email) return data.from_email.toLowerCase().trim();
  if (data.sender) {
    const match = data.sender.match(/<([^>]+)>/);
    return match ? match[1].toLowerCase() : data.sender.toLowerCase().trim();
  }
  return null;
}

function classifyInterest(text) {
  const lower = text.toLowerCase();

  // Check not interested first (more specific)
  for (const keyword of NOT_INTERESTED_KEYWORDS) {
    if (lower.includes(keyword)) return 'not_interested';
  }

  // Check interested
  for (const keyword of INTERESTED_KEYWORDS) {
    if (lower.includes(keyword)) return 'interested';
  }

  return 'unclear';
}

async function incrementCampaignReplyCount(sb) {
  try {
    const { data: campaigns } = await sb
      .from('crm_email_campaigns')
      .select('id, reply_count')
      .eq('status', 'sent')
      .order('completed_at', { ascending: false })
      .limit(1);

    if (campaigns && campaigns.length > 0) {
      const campaign = campaigns[0];
      await sb.from('crm_email_campaigns').update({
        reply_count: (campaign.reply_count || 0) + 1
      }).eq('id', campaign.id);
    }
  } catch (e) {
    console.error('Failed to update campaign reply count:', e.message);
  }
}
