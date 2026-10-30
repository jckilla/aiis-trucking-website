// Onboarding helper for two allowlisted accounts. Two modes:
//   {email}            -> returns a one-time setup (recovery) link
//   {email, send:true} -> asks Supabase to SEND the reset email via the configured SMTP
// Guarded by a secret AND an email allowlist. verify_jwt=false.
//
// ⚠️ SECURITY — READ BEFORE REDEPLOYING THIS FILE.
// The version currently DEPLOYED to Supabase has the admin secret HARDCODED as a string
// literal on the line below. That value was deliberately NOT copied into this repo: committing
// it would put a live credential into git history, and this repo is served by Vercel.
//
// Consequences, all true as of 2026-10-30:
//   * This is a PUBLIC endpoint (verify_jwt=false) whose only guard is that hardcoded string.
//   * It mints password-RECOVERY links for samrid@getsuperagent.com and
//     eduardo@getsuperagent.com — two accounts whose access was deliberately revoked
//     (profiles.active = false for both).
//   * Anyone holding that string can therefore obtain a password-reset link for a revoked
//     account. is_master() checks profiles.active so they would not get master powers, but
//     auth_org_id() does NOT check active, so they would still resolve into the org.
//
// This function was a ONE-OFF for onboarding in July 2026 and has no ongoing purpose.
// RECOMMENDED: delete it from the Supabase dashboard. If it must stay, rotate the secret and
// read it from Deno.env.get('ADMIN_SETUP_SECRET') as written here, then redeploy.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SECRET = Deno.env.get('ADMIN_SETUP_SECRET') || '';   // deployed version hardcodes this
const ALLOW = new Set(['samrid@getsuperagent.com', 'eduardo@getsuperagent.com']);
const REDIRECT = 'https://fleet.ins2day.com/set-password.html';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  // Fail closed when no secret is configured, rather than allowing every caller through.
  if (!SECRET || req.headers.get('x-admin-secret') !== SECRET) return json({ error: 'forbidden' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const email = String(body.email || '').trim().toLowerCase();
  if (!ALLOW.has(email)) return json({ error: 'email not allowed' }, 403);

  const url = Deno.env.get('SUPABASE_URL')!;

  if (body.send === true) {
    // Trigger Supabase to SEND the password-reset email through the configured SMTP (Resend).
    const pub = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await pub.auth.resetPasswordForEmail(email, { redirectTo: REDIRECT });
    if (error) return json({ error: error.message }, 400);
    return json({ email, sent: true });
  }

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: REDIRECT } });
  if (error) return json({ error: error.message }, 400);
  return json({ email, link: data?.properties?.action_link || null });
});
