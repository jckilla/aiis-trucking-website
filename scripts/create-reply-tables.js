/**
 * Create the crm_email_replies and crm_daily_reports tables in Supabase.
 *
 * Usage: node scripts/create-reply-tables.js
 *
 * This script attempts to create the tables via Supabase RPC.
 * If that fails (anon key can't run DDL), it prints the SQL to run manually.
 *
 * Required tables:
 * 1. crm_email_replies — stores inbound email replies matched to leads
 * 2. crm_daily_reports — stores daily CRM summary reports
 *
 * Also adds reply_count and bounce_count columns to crm_email_campaigns if missing.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxaWp5aHVkZml0ZWl2ZWpjZ294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzI5OTUsImV4cCI6MjA4OTI0ODk5NX0.08wZTXZSQvB98VEKCMLVc0EcuxleNVSOF5Fg0eKENHI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const SQL_STATEMENTS = [
  // Table: crm_email_replies
  `CREATE TABLE IF NOT EXISTS crm_email_replies (
  id BIGSERIAL PRIMARY KEY,
  lead_id BIGINT REFERENCES crm_leads(id) ON DELETE SET NULL,
  from_email TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  interest_classification TEXT DEFAULT 'unclear',
  received_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);`,

  // Index for fast lookups by lead
  `CREATE INDEX IF NOT EXISTS idx_email_replies_lead_id ON crm_email_replies(lead_id);`,

  // Index for date-range queries (daily summary)
  `CREATE INDEX IF NOT EXISTS idx_email_replies_received_at ON crm_email_replies(received_at);`,

  // RLS policy — allow anon to insert and read
  `ALTER TABLE crm_email_replies ENABLE ROW LEVEL SECURITY;`,
  `CREATE POLICY IF NOT EXISTS "Allow all for anon" ON crm_email_replies FOR ALL USING (true) WITH CHECK (true);`,

  // Table: crm_daily_reports
  `CREATE TABLE IF NOT EXISTS crm_daily_reports (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE UNIQUE NOT NULL,
  total_replies INTEGER DEFAULT 0,
  interested_count INTEGER DEFAULT 0,
  not_interested_count INTEGER DEFAULT 0,
  bounced_count INTEGER DEFAULT 0,
  summary_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`,

  // RLS policy
  `ALTER TABLE crm_daily_reports ENABLE ROW LEVEL SECURITY;`,
  `CREATE POLICY IF NOT EXISTS "Allow all for anon" ON crm_daily_reports FOR ALL USING (true) WITH CHECK (true);`,

  // Add reply_count and bounce_count to crm_email_campaigns if not present
  `ALTER TABLE crm_email_campaigns ADD COLUMN IF NOT EXISTS reply_count INTEGER DEFAULT 0;`,
  `ALTER TABLE crm_email_campaigns ADD COLUMN IF NOT EXISTS bounce_count INTEGER DEFAULT 0;`
];

async function checkTableExists(tableName) {
  const { data, error } = await sb.from(tableName).select('id').limit(1);
  if (error && error.code === '42P01') return false; // relation does not exist
  if (error && error.message && error.message.includes('does not exist')) return false;
  return true; // table exists (even if empty)
}

async function main() {
  console.log('Checking existing tables...\n');

  const repliesExist = await checkTableExists('crm_email_replies');
  const reportsExist = await checkTableExists('crm_daily_reports');

  console.log('crm_email_replies exists:', repliesExist);
  console.log('crm_daily_reports exists:', reportsExist);

  if (repliesExist && reportsExist) {
    console.log('\nAll tables already exist. Checking for missing columns...');

    // Check if reply_count column exists on crm_email_campaigns
    const { data: campaigns, error: campErr } = await sb
      .from('crm_email_campaigns')
      .select('reply_count')
      .limit(1);

    if (campErr && campErr.message && campErr.message.includes('reply_count')) {
      console.log('crm_email_campaigns.reply_count column is missing — needs to be added.');
    } else {
      console.log('crm_email_campaigns.reply_count column exists.');
    }

    console.log('\nNo table creation needed. Done.');
    return;
  }

  console.log('\n--- SQL TO RUN IN SUPABASE SQL EDITOR ---\n');
  console.log('Go to: https://supabase.com/dashboard/project/cqijyhudfiteivejcgox/sql/new\n');
  console.log('Copy and paste the following SQL:\n');
  console.log('-- ============================================');
  console.log('-- Email Reply Tracking Tables for AIIS CRM');
  console.log('-- ============================================\n');

  SQL_STATEMENTS.forEach(function(sql) {
    console.log(sql);
    console.log('');
  });

  console.log('-- ============================================');
  console.log('-- END OF SQL');
  console.log('-- ============================================');
}

main().catch(function(e) {
  console.error('Error:', e.message);
  process.exit(1);
});
