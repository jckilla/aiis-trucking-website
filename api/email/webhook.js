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
const { readRawBody, verifySvix } = require('../../lib/svix-verify');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

module.exports = async function handler(req, res) {
  // CORS headers (allow Resend and our domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-id, svix-signature, svix-timestamp');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Read the RAW body (bodyParser is disabled at the bottom of this file) so the Svix
  // HMAC can be verified over the exact bytes Resend signed.
  const rawBody = await readRawBody(req);

  // When a signing secret is configured, verify the signature and FAIL CLOSED. If the raw
  // body could not be captured we cannot verify, so we reject rather than accept a possibly
  // forged event. Set RESEND_WEBHOOK_SECRET in Vercel (and in the Resend dashboard) to
  // enable this. Without it, events are unverified (behavior unchanged) — so configure it.
  if (RESEND_WEBHOOK_SECRET) {
    if (!rawBody || !verifySvix(rawBody, req.headers, RESEND_WEBHOOK_SECRET)) {
      console.error('Resend webhook: signature verification failed or raw body unavailable — rejecting.');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (!body || !body.type) {
    return res.status(400).json({ error: 'Invalid webhook payload — missing type' });
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

    // Suppress permanent/hard bounces so we never email them again. Do NOT touch the notes field —
    // the old code overwrote it, destroying any manually-entered notes.
    const isHard = data.bounce && /hard|permanent|undeliverable|suppress/i.test(JSON.stringify(data.bounce));
    if (isHard) {
      await sb.from('crm_leads').update({ unsubscribed: true }).eq('id', leadId).catch(() => {});
    }
  }
}

async function handleComplained(sb, leadId, email, data) {
  if (leadId) {
    await sb.from('crm_activities').insert({
      lead_id: leadId,
      type: 'email',
      description: 'Spam complaint from ' + email + ' — auto-unsubscribed'
    }).catch(() => {});

    // Auto-suppress on a spam complaint via the dedicated flag. Do NOT overwrite notes or hijack the
    // pipeline stage — the old code did both (losing notes, breaking pipeline math), and 'lost' isn't
    // even a valid stage enum value so that write always failed anyway.
    await sb.from('crm_leads').update({
      unsubscribed: true,
      updated_at: new Date().toISOString()
    }).eq('id', leadId).catch(() => {});
  }
}

// Disable Vercel's automatic body parsing so we can read the raw body and verify the
// Svix signature over the exact bytes. NOTE: after deploying, confirm delivery events
// still return 200 (send a test event from the Resend dashboard).
module.exports.config = { api: { bodyParser: false } };
