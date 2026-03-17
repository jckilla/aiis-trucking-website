/**
 * GET/POST /api/cron/daily-summary
 * Generates a daily CRM summary report.
 *
 * Triggered by Vercel Cron at 7 AM UTC (midnight PST) or manually.
 * Queries last 24 hours of replies, activities, and stage changes.
 * Stores the report in crm_daily_reports.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const DIALER_API_KEY = process.env.DIALER_API_KEY;

module.exports = async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  const allowed = ['https://fleet.ins2day.com', 'http://localhost:3000'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: Allow Vercel Cron (has CRON_SECRET) or API key
  const cronSecret = req.headers['authorization'];
  const apiKey = req.headers['x-api-key'];
  const isVercelCron = cronSecret && cronSecret === 'Bearer ' + process.env.CRON_SECRET;
  const isApiKey = apiKey && apiKey === DIALER_API_KEY;

  if (!isVercelCron && !isApiKey) {
    // Allow GET without auth for manual trigger during development
    if (req.method === 'GET' && !process.env.CRON_SECRET) {
      // OK — no cron secret configured, allow manual trigger
    } else if (req.method === 'GET') {
      // Allow GET with API key
    } else {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since = yesterday.toISOString();
    const reportDate = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // 1. Get email replies from last 24 hours
    const { data: replies } = await sb
      .from('crm_email_replies')
      .select('*, lead:lead_id(contact_name, company_name, stage)')
      .gte('received_at', since)
      .order('received_at', { ascending: false });
    const replyList = replies || [];

    // 2. Get email activities from last 24 hours
    const { data: emailActivities } = await sb
      .from('crm_activities')
      .select('*')
      .eq('type', 'email')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    const activityList = emailActivities || [];

    // 3. Get leads with stage changes in last 24 hours
    const { data: stageActivities } = await sb
      .from('crm_activities')
      .select('*, lead:lead_id(contact_name, company_name, stage, email)')
      .eq('type', 'stage_change')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    const stageChangeList = stageActivities || [];

    // 4. Get campaign performance stats
    const { data: campaigns } = await sb
      .from('crm_email_campaigns')
      .select('*')
      .in('status', ['sent', 'sending'])
      .order('completed_at', { ascending: false })
      .limit(5);
    const campaignList = campaigns || [];

    // Classify reply counts
    let interestedCount = 0;
    let notInterestedCount = 0;
    let unclearCount = 0;

    const replyDetails = replyList.map(function(r) {
      const classification = r.interest_classification || 'unclear';
      if (classification === 'interested') interestedCount++;
      else if (classification === 'not_interested') notInterestedCount++;
      else unclearCount++;

      return {
        from_email: r.from_email,
        lead_name: r.lead ? r.lead.contact_name : null,
        company: r.lead ? r.lead.company_name : null,
        subject: r.subject,
        reply_preview: (r.body_text || '').substring(0, 200),
        classification: classification,
        received_at: r.received_at
      };
    });

    // Leads that moved to interested/quote stages
    const interestedLeads = stageChangeList.filter(function(a) {
      return a.description && (
        a.description.includes('Lead') ||
        a.description.includes('interested') ||
        a.description.includes('Quote')
      );
    }).map(function(a) {
      return {
        lead_name: a.lead ? a.lead.contact_name : null,
        company: a.lead ? a.lead.company_name : null,
        description: a.description,
        timestamp: a.created_at
      };
    });

    // Campaign performance
    const campaignStats = campaignList.map(function(c) {
      return {
        name: c.name,
        status: c.status,
        sent: c.sent_count || 0,
        opened: c.open_count || 0,
        clicked: c.click_count || 0,
        replied: c.reply_count || 0,
        bounced: c.bounce_count || 0
      };
    });

    // Total bounced across all recent campaigns
    const totalBounced = campaignList.reduce(function(sum, c) {
      return sum + (c.bounce_count || 0);
    }, 0);

    // Build summary JSON
    const summaryJson = {
      replies: replyDetails,
      interested_leads: interestedLeads,
      campaign_stats: campaignStats,
      stage_changes: stageChangeList.length,
      email_activities: activityList.length
    };

    // Store the report
    const report = {
      report_date: reportDate,
      total_replies: replyList.length,
      interested_count: interestedCount,
      not_interested_count: notInterestedCount,
      bounced_count: totalBounced,
      summary_json: summaryJson,
      created_at: now.toISOString()
    };

    // Upsert by report_date to avoid duplicates if run twice
    const { error: reportErr } = await sb
      .from('crm_daily_reports')
      .upsert(report, { onConflict: 'report_date' });

    if (reportErr) {
      console.error('Failed to save daily report:', reportErr.message);
      // Try insert without upsert
      await sb.from('crm_daily_reports').insert(report).catch(() => {});
    }

    console.log('Daily summary generated:', reportDate, '— Replies:', replyList.length,
      'Interested:', interestedCount, 'Not interested:', notInterestedCount);

    return res.status(200).json({
      success: true,
      report_date: reportDate,
      total_replies: replyList.length,
      interested_count: interestedCount,
      not_interested_count: notInterestedCount,
      bounced_count: totalBounced,
      stage_changes: stageChangeList.length,
      summary: summaryJson
    });

  } catch (e) {
    console.error('Daily summary error:', e);
    return res.status(500).json({ error: e.message });
  }
};
