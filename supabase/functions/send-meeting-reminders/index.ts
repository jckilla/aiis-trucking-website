// Sends ~1-hour-before SMS reminders for booked meetings.
// Triggered every 5 min by pg_cron (x-cron-secret header). DRY-RUN until
// REMINDERS_LIVE=true (set after A2P 10DLC registration).
//
// ⚠️ SECURITY — READ BEFORE REDEPLOYING THIS FILE.
// The version currently DEPLOYED to Supabase has the cron secret HARDCODED as a string literal
// on the CRON_SECRET line. That value was deliberately NOT copied into this repo: committing
// it would put a live credential into git history, and this repo is served by Vercel.
// This endpoint is public (verify_jwt=false) and the secret is its only guard; anyone holding
// it can drive this function, which sends SMS to real leads once REMINDERS_LIVE=true.
// Rotate it, store it as CRON_SECRET in the function's secrets (and update the pg_cron job's
// header to match), then redeploy from this file.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';   // deployed version hardcodes this
const BRAND = 'Advanced Insurance Solutions';
const PER_RUN_CAP = 200;

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const normUs = (p: string | null) => {
  const d = String(p || '').replace(/\D/g, '');
  const e = d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : '';
  return /^\+1[2-9]\d{9}$/.test(e) ? e : '';
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  // Fail closed when no secret is configured, rather than allowing every caller through.
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'forbidden' }, 403);

  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const LIVE = (Deno.env.get('REMINDERS_LIVE') || '').toLowerCase() === 'true';
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
  const tok = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
  const fallbackFrom = Deno.env.get('TWILIO_DEFAULT_NUMBER') || '';

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const in6hIso = new Date(now + 6 * 3600_000).toISOString();
  const staleIso = new Date(now - 10 * 60_000).toISOString();

  // Recover rows orphaned in 'sending' by a crashed run (>10 min old): if an sms_sid was
  // recorded it DID send (finalize as 'sent'); otherwise requeue to 'pending'. Idempotent.
  await admin.from('crm_meetings').update({ reminder_status: 'sent' })
    .eq('reminder_status', 'sending').lt('updated_at', staleIso).not('sms_sid', 'is', null);
  await admin.from('crm_meetings').update({ reminder_status: 'pending', last_error: 'requeued after stuck send' })
    .eq('reminder_status', 'sending').lt('updated_at', staleIso).is('sms_sid', null);

  // Candidates: pending, not yet started, within the next 6h.
  const { data: rows, error } = await admin.from('crm_meetings')
    .select('id, lead_id, agent_id, client_name, client_phone, meeting_at, meeting_local_str, reminder_offset_minutes')
    .eq('reminder_status', 'pending').gt('meeting_at', nowIso).lte('meeting_at', in6hIso);
  if (error) return json({ error: error.message }, 500);

  const due = (rows || []).filter((r) => {
    const mt = new Date(r.meeting_at).getTime();
    const off = (r.reminder_offset_minutes || 60) * 60_000;
    return now >= mt - off && now < mt;
  }).slice(0, PER_RUN_CAP);

  // Resolve each agent's own caller ID (the sender).
  const agentIds = [...new Set(due.map((r) => r.agent_id).filter(Boolean))];
  const fromByAgent: Record<string, string> = {};
  if (agentIds.length) {
    const { data: profs } = await admin.from('profiles').select('id, twilio_caller_id').in('id', agentIds);
    for (const p of profs || []) fromByAgent[p.id] = normUs(p.twilio_caller_id) || '';
  }

  // Consent gate: current opt-out state of each lead (checked at SEND time, not booking time).
  const leadIds = [...new Set(due.map((r) => r.lead_id).filter((x) => x != null))];
  const optOut: Record<string, boolean> = {};
  if (leadIds.length) {
    const { data: leads } = await admin.from('crm_leads').select('id, do_not_call, do_not_text, unsubscribed').in('id', leadIds);
    for (const l of leads || []) optOut[l.id] = !!(l.do_not_call || l.do_not_text || l.unsubscribed);
  }

  const detail: unknown[] = [];
  let sent = 0, dry = 0, failed = 0, suppressed = 0;

  for (const r of due) {
    // Consent gate FIRST — never text a lead who opted out, or one we can't verify (row removed).
    if (r.lead_id == null || optOut[r.lead_id]) {
      await admin.from('crm_meetings').update({ reminder_status: 'canceled', last_error: r.lead_id == null ? 'suppressed: lead removed, consent unverifiable' : 'suppressed: lead opted out' })
        .eq('id', r.id).eq('reminder_status', 'pending');
      suppressed++; detail.push({ id: r.id, status: 'suppressed' }); continue;
    }

    // Atomically claim so overlapping runs can't double-send.
    const { data: claimed } = await admin.from('crm_meetings')
      .update({ reminder_status: 'sending' }).eq('id', r.id).eq('reminder_status', 'pending').select('id');
    if (!claimed || claimed.length === 0) continue;

    const to = normUs(r.client_phone);
    const from = fromByAgent[r.agent_id] || fallbackFrom;
    const first = (r.client_name || '').split(' ')[0] || 'there';
    const body = `Hi ${first}, quick reminder about your meeting${r.meeting_local_str ? ' ' + r.meeting_local_str : ''} with ${BRAND}. Talk soon! Reply STOP to opt out.`;

    if (!to) {
      await admin.from('crm_meetings').update({ reminder_status: 'failed', reminder_body: body, last_error: 'invalid client phone' }).eq('id', r.id);
      failed++; detail.push({ id: r.id, status: 'failed', reason: 'invalid client phone' }); continue;
    }
    if (!LIVE) {
      await admin.from('crm_meetings').update({ reminder_status: 'dryrun', reminder_body: body, reminder_sent_at: nowIso, last_error: null }).eq('id', r.id);
      dry++; detail.push({ id: r.id, status: 'dryrun', to, from: from || '(none)', body }); continue;
    }
    if (!sid || !tok || !from) {
      await admin.from('crm_meetings').update({ reminder_status: 'failed', reminder_body: body, last_error: 'twilio not configured / no sender number' }).eq('id', r.id);
      failed++; detail.push({ id: r.id, status: 'failed', reason: 'twilio not configured / no sender' }); continue;
    }
    try {
      const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`${sid}:${tok}`), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
      });
      const j = await resp.json();
      if (resp.ok) {
        await admin.from('crm_meetings').update({ reminder_status: 'sent', reminder_body: body, reminder_sent_at: new Date().toISOString(), sms_sid: j.sid, last_error: null }).eq('id', r.id);
        sent++; detail.push({ id: r.id, status: 'sent', to, sid: j.sid });
      } else {
        await admin.from('crm_meetings').update({ reminder_status: 'failed', reminder_body: body, last_error: String(j.message || resp.status) }).eq('id', r.id);
        failed++; detail.push({ id: r.id, status: 'failed', reason: j.message });
      }
    } catch (e) {
      await admin.from('crm_meetings').update({ reminder_status: 'failed', reminder_body: body, last_error: String((e as Error)?.message || e) }).eq('id', r.id);
      failed++; detail.push({ id: r.id, status: 'failed', reason: String((e as Error)?.message || e) });
    }
  }

  return json({ ok: true, live: LIVE, candidates: (rows || []).length, due: due.length, sent, dryrun: dry, suppressed, failed, detail });
});
