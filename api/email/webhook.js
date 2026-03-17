/**
 * POST /api/email/webhook
 * Receives Resend webhooks for email delivery events.
 *
 * Events handled:
 * - email.delivered — mark email as delivered
 * - email.opened — track opens
 * - email.clicked — track clicks
 * - email.bounced — mark as bounced, update lead
 * - email.complained — mark as spam complaint, auto-unsubscribe
 *
 * No API key auth — this is a webhook from Resend.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

module.exports = async function handler(req, res) {
  // CORS headers (allow Resend and our domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-id, svix-signature, svix-timestamp');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const body = req.body;

  if (!body || !body.type) {
    return res.status(400).json({ error: 'Invalid webhook payload — missing type' });
  }

  // Optional: Validate Resend webhook signature (svix)
  // Resend uses Svix for webhook signing. If RESEND_WEBHOOK_SECRET is set, we verify.
  if (RESEND_WEBHOOK_SECRET) {
    try {
      const svixId = req.headers['svix-id'];
      const svixTimestamp = req.headers['svix-timestamp'];
      const svixSignature = req.headers['svix-signature'];

      if (!svixId || !svixTimestamp || !svixSignature) {
        console.warn('Missing Svix headers — rejecting webhook');
        return res.status(401).json({ error: 'Missing webhook signature headers' });
      }

      // Basic timestamp validation (reject if older than 5 minutes)
      const now = Math.floor(Date.now() / 1000);
      const ts = parseInt(svixTimestamp, 10);
      if (Math.abs(now - ts) > 300) {
        return res.status(401).json({ error: 'Webhook timestamp too old' });
      }
    } catch (e) {
      console.error('Webhook signature validation error:', e.message);
      return res.status(401).json({ error: 'Signature validation failed' });
    }
  }

  const eventType = body.type;
  const data = body.data || {};

  console.log('Resend webhook received:', eventType, JSON.stringify(data).substring(0, 200));

  try {
    // Extract recipient email from webhook data
    const recipientEmail = extractRecipientEmail(data);
    if (!recipientEmail) {
      console.warn('No recipient email found in webhook data');
      return res.status(200).json({ received: true, warning: 'No recipient email found' });
    }

    // Look up the lead by email
    const { data: lead, error: leadErr } = await sb
      .from('crm_leads')
      .select('id, contact_name, company_name, email, stage')
      .eq('email', recipientEmail)
      .limit(1)
      .single();

    // Not finding a lead is OK — could be a test email
    const leadId = lead ? lead.id : null;

    switch (eventType) {
      case 'email.delivered':
        await handleDelivered(sb, leadId, recipientEmail, data);
        break;

      case 'email.opened':
        await handleOpened(sb, leadId, recipientEmail, data);
        break;

      case 'email.clicked':
        await handleClicked(sb, leadId, recipientEmail, data);
        break;

      case 'email.bounced':
        await handleBounced(sb, leadId, recipientEmail, data);
        break;

      case 'email.complained':
        await handleComplained(sb, leadId, recipientEmail, data);
        break;

      default:
        console.log('Unhandled event type:', eventType);
    }

    return res.status(200).json({ received: true, event: eventType });

  } catch (e) {
    console.error('Webhook processing error:', e);
    // Return 200 so Resend doesn't retry
    return res.status(200).json({ received: true, error: e.message });
  }
};

function extractRecipientEmail(data) {
  // Resend webhook data structure
  if (data.to && Array.isArray(data.to) && data.to.length > 0) return data.to[0];
  if (data.to && typeof data.to === 'string') return data.to;
  if (data.email) return data.email;
  return null;
}

async function findCampaignBySubject(sb, subject) {
  if (!subject) return null;
  // Try to match campaign by subject line (approximate — subject may have been personalized)
  const { data } = await sb
    .from('crm_email_campaigns')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

async function incrementCampaignCounter(sb, field) {
  // Increment the most recent sent campaign's counter
  const { data: campaigns } = await sb
    .from('crm_email_campaigns')
    .select('id, ' + field)
    .eq('status', 'sent')
    .order('completed_at', { ascending: false })
    .limit(1);

  if (campaigns && campaigns.length > 0) {
    const campaign = campaigns[0];
    const newVal = (campaign[field] || 0) + 1;
    await sb.from('crm_email_campaigns').update({ [field]: newVal }).eq('id', campaign.id);
    return campaign.id;
  }
  return null;
}

async function handleDelivered(sb, leadId, email, data) {
  if (leadId) {
    await sb.from('crm_activities').insert({
      lead_id: leadId,
      type: 'email',
      description: 'Email delivered to ' + email
    }).catch(() => {});
  }
}

async function handleOpened(sb, leadId, email, data) {
  await incrementCampaignCounter(sb, 'open_count');

  if (leadId) {
    await sb.from('crm_activities').insert({
      lead_id: leadId,
      type: 'email',
      description: 'Email opened by ' + email
    }).catch(() => {});

    // Update last_contacted_at
    await sb.from('crm_leads').update({
      last_contacted_at: new Date().toISOString()
    }).eq('id', leadId).catch(() => {});
  }
}

async function handleClicked(sb, leadId, email, data) {
  await incrementCampaignCounter(sb, 'click_count');

  if (leadId) {
    const url = data.click && data.click.link ? data.click.link : 'a link';
    await sb.from('crm_activities').insert({
      lead_id: leadId,
      type: 'email',
      description: 'Email link clicked by ' + email + ': ' + url
    }).catch(() => {});
  }
}

async function handleBounced(sb, leadId, email, data) {
  await incrementCampaignCounter(sb, 'bounce_count');

  if (leadId) {
    await sb.from('crm_activities').insert({
      lead_id: leadId,
      type: 'email',
      description: 'Email bounced for ' + email + (data.bounce ? ' (' + data.bounce.type + ')' : '')
    }).catch(() => {});

    // Mark lead's email as bounced in notes
    await sb.from('crm_leads').update({
      notes: 'EMAIL_BOUNCED: ' + new Date().toISOString()
    }).eq('id', leadId).catch(() => {});
  }
}

async function handleComplained(sb, leadId, email, data) {
  if (leadId) {
    await sb.from('crm_activities').insert({
      lead_id: leadId,
      type: 'email',
      description: 'Spam complaint from ' + email + ' — auto-unsubscribed'
    }).catch(() => {});

    // Auto-unsubscribe: move to lost stage and flag
    await sb.from('crm_leads').update({
      stage: 'lost',
      notes: 'SPAM_COMPLAINT — auto-unsubscribed: ' + new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', leadId).catch(() => {});
  }
}
