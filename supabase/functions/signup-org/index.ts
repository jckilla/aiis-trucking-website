// Self-serve signup. Creates a NEW TENANT: auth user + org + master profile.
// Public by necessity (this is the signup endpoint) - verify_jwt=false.
// Every new account lands in its OWN org, so it can never see another
// customer's data (enforced by org-scoped RLS, not by this code).
//
// PAYMENT GATE. Two things must line up before a workspace is created:
//   1. billing_subscriptions has a row for that email, status active/trialing,
//      not yet redeemed (org_id IS NULL); and
//   2. the request carries the Stripe checkout session id (`ref`) matching that
//      row.
//
// Requirement 2 exists because the email address alone is NOT a credential -
// anyone who knows a buyer's address could otherwise POST it with a password of
// their choosing and walk off with the workspace that buyer just paid for,
// permanently consuming the payment. The cs_... id is only ever shown to
// whoever completed that checkout, so it is a real bearer token. It reaches us
// via success_url -> welcome.html -> ?ref= on the signup link.
//
// RETURNING CUSTOMERS never reach the gate. If the email already owns an
// account, the stripe-webhook has already re-attached the new subscription to
// their existing workspace and switched it back on - so they just sign in with
// the password they already have. This endpoint only tells them so.
//
// TO COMP AN ACCOUNT (no payment), insert a row with NO checkout_session_id:
//   insert into billing_subscriptions
//     (email, stripe_customer_id, stripe_subscription_id, status, seats)
//   values ('them@co.com', 'manual', 'manual-<unique>', 'active', 3);
// Rows without a checkout_session_id are treated as a deliberate manual grant
// and skip requirement 2.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ALLOWED = [
  // Aduna Dialer customers sign up on their own brand's hostname. A customer
  // who bought Aduna Dialer must never be sent to an insurance company domain.
  'https://app.adunadialer.com',
  // AIIS's own workspace.
  'https://fleet.ins2day.com',
  'http://localhost:3000',
];

function cors(origin: string): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
  if (ALLOWED.includes(origin) || /^https:\/\/aiis-trucking-website[a-z0-9-]*\.vercel\.app$/.test(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

function slugify(s: string): string {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  const H = cors(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: H });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: H });

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fullName = String(body.full_name || '').trim();
  const company = String(body.company_name || '').trim();
  const ref = String(body.ref || body.session_id || '').trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'Enter a valid email address.' }), { status: 400, headers: H });
  }
  if (password.length < 8) {
    return new Response(JSON.stringify({ error: 'Password must be at least 8 characters.' }), { status: 400, headers: H });
  }
  if (company.length < 2) {
    return new Response(JSON.stringify({ error: 'Enter your company name.' }), { status: 400, headers: H });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // 0) Returning customer? If this email already has an account, creating a
  //    second workspace is never the right answer - and the generic "we
  //    couldn't match this to a payment" message would be badly misleading for
  //    someone who has just paid to come back. The webhook has already
  //    reattached their subscription and reactivated the workspace by now.
  //    No new information is leaked: createUser below would say the same.
  const { data: existingProfile } = await admin
    .from('profiles')
    .select('org_id')
    .eq('email', email)
    .limit(1)
    .maybeSingle();

  if (existingProfile) {
    let active = false;
    if (existingProfile.org_id) {
      const { data: o } = await admin.from('orgs').select('active').eq('id', existingProfile.org_id).maybeSingle();
      active = o?.active === true;
    }
    return new Response(JSON.stringify({
      already_registered: true,
      workspace_active: active,
      error: active
        ? 'You already have a workspace on this email, and your subscription is active. Just sign in with your existing password - everything is exactly as you left it.'
        : 'You already have a workspace on this email. Sign in with your existing password; if it still says your subscription is inactive, give the payment a minute to land and refresh, then contact support if it persists.',
    }), { status: 409, headers: H });
  }

  // 1) Payment gate. Emails are stored lowercased by the webhook and lowercased
  //    here, so an exact match is safe (and avoids LIKE wildcard problems with
  //    underscores in addresses).
  const { data: candidates, error: subErr } = await admin
    .from('billing_subscriptions')
    .select('id, seats, status, checkout_session_id')
    .eq('email', email)
    .is('org_id', null)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(10);

  if (subErr) {
    console.error('billing lookup failed:', subErr.message);
    return new Response(JSON.stringify({ error: 'Could not verify your subscription. Please try again.' }), { status: 500, headers: H });
  }

  const rows = candidates || [];
  // Prefer an exact session match; otherwise fall back to a manual grant.
  let sub = ref ? rows.find((r) => r.checkout_session_id === ref) || null : null;
  if (!sub) sub = rows.find((r) => !r.checkout_session_id) || null;

  if (!sub) {
    // Deliberately the SAME response whether no subscription exists or the ref
    // did not match, so this endpoint cannot be used to discover which email
    // addresses hold an unredeemed paid subscription.
    return new Response(JSON.stringify({
      error: "We couldn't match this signup to a payment. Please use the 'Create my workspace' link from your payment confirmation page - it carries a one-time reference. If you no longer have it, contact support and we'll finish setting you up.",
    }), { status: 402, headers: H });
  }

  // 2) Create the auth user. Auto-confirmed so they can sign in immediately.
  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, company_name: company },
  });
  if (userErr || !created?.user) {
    const msg = String(userErr?.message || 'Could not create the account.');
    const dupe = /already|registered|exists/i.test(msg);
    return new Response(
      JSON.stringify({ error: dupe ? 'An account with that email already exists. Try signing in instead.' : msg }),
      { status: 400, headers: H },
    );
  }
  const uid = created.user.id;

  const rollback = async (message: string, status = 400) => {
    try { await admin.auth.admin.deleteUser(uid); } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: message }), { status, headers: H });
  };

  // 3) Create the tenant, retrying the slug on collision.
  let orgId: string | null = null;
  const base = slugify(company);
  for (let attempt = 0; attempt < 5 && !orgId; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 7)}`;
    const { data: org, error: orgErr } = await admin
      .from('orgs')
      .insert({ name: company, slug, plan: 'trial' })
      .select('id')
      .single();
    if (org && !orgErr) { orgId = org.id; break; }
    if (orgErr && !/duplicate|unique/i.test(orgErr.message)) {
      return await rollback('Could not create your workspace: ' + orgErr.message, 500);
    }
  }
  if (!orgId) return await rollback('Could not create your workspace. Please try again.', 500);

  // 4) Profile: owner of the NEW org (master of their own tenant only).
  const { error: profErr } = await admin.from('profiles').upsert({
    id: uid,
    org_id: orgId,
    email,
    full_name: fullName || email,
    role: 'master',
    active: true,
  }, { onConflict: 'id' });

  if (profErr) {
    try { await admin.from('orgs').delete().eq('id', orgId); } catch { /* ignore */ }
    return await rollback('Could not finish setting up your workspace: ' + profErr.message, 500);
  }

  // 5) Redeem the subscription against this workspace. The `is null` guard
  //    makes a double-redeem race impossible: with two concurrent signups on
  //    the same payment, only one update matches.
  const { data: redeemed, error: redeemErr } = await admin
    .from('billing_subscriptions')
    .update({ org_id: orgId, updated_at: new Date().toISOString() })
    .eq('id', sub.id)
    .is('org_id', null)
    .select('id');

  if (redeemErr || !redeemed || redeemed.length === 0) {
    // Unwind in FK-safe order: the user (which cascades the profile) first,
    // then the org the profile pointed at.
    try { await admin.auth.admin.deleteUser(uid); } catch { /* ignore */ }
    try { await admin.from('orgs').delete().eq('id', orgId); } catch { /* ignore */ }
    return new Response(JSON.stringify({
      error: 'That subscription has already been used to create a workspace. Please sign in instead, or contact support.',
    }), { status: 409, headers: H });
  }

  // 6) Apply the plan and the paid seat count.
  const { error: planErr } = await admin
    .from('orgs')
    .update({ plan: 'paid', seat_limit: sub.seats })
    .eq('id', orgId);
  if (planErr) {
    console.error('could not apply plan/seat_limit to org', orgId, planErr.message);
  }

  // Telephony provisioning is queued by a DATABASE TRIGGER on orgs, not from here - see
  // public.queue_telephony_provision(). It fires the moment plan becomes 'paid' (which step 6
  // above does), so it covers this signup path AND the stripe-webhook reactivation path
  // without either function needing to know about the outbox. A Vercel cron
  // (/api/cron/provision-telephony) then drains it and buys the number.
  return new Response(JSON.stringify({ ok: true, org_id: orgId, email, seats: sub.seats }), { headers: H });
});
