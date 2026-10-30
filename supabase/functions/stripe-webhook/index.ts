// Stripe webhook - mirrors subscription state into billing_subscriptions so
// signup-org can refuse to create a workspace that nobody paid for, and so a
// returning customer gets their old workspace back automatically.
//
// verify_jwt = false is REQUIRED: Stripe cannot send a Supabase JWT. The Stripe
// signature is the authentication - every request without a valid v1 signature
// computed with STRIPE_WEBHOOK_SECRET is rejected before anything is read.
//
// Env: STRIPE_WEBHOOK_SECRET (whsec_...). SUPABASE_URL and
//      SUPABASE_SERVICE_ROLE_KEY are injected by Supabase automatically.
//
// RULES THIS FILE EXISTS TO ENFORCE, all learned from real failure modes:
//
//  1. checkout.session.completed writes ONLY immutable facts (email, customer
//     id, checkout session id). It never writes status or seats. It fires once
//     and its metadata is frozen at session-creation time, so letting it touch
//     mutable state lets a stale value win a race against the truth.
//
//  2. Mutable state (seats, status) is owned by customer.subscription.* alone,
//     and every such write is guarded by last_event_at so an out-of-order or
//     retried delivery can never resurrect an older state.
//
//  3. Invoice events never promote to active. A customer paying a final
//     outstanding invoice after cancellation must not flip a dead subscription
//     back to paying - Stripe would never bill them again.

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe('sk_signature_verification_only', {
  httpClient: Stripe.createFetchHttpClient(),
});
const webCrypto = Stripe.createSubtleCryptoProvider();

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const now = () => new Date().toISOString();

function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

function tsToIso(sec: unknown): string | null {
  return typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return json({ error: 'Webhook not configured' }, 500);
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) return json({ error: 'Missing signature' }, 400);

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, secret, undefined, webCrypto);
  } catch (e) {
    console.error('signature verification failed:', String(e));
    return json({ error: 'Invalid signature' }, 400);
  }

  // Two-phase dedup: only a claim that reached processed=true counts, so a
  // handler that dies midway still gets re-run by Stripe's retry.
  const { data: prior } = await admin
    .from('billing_events').select('processed').eq('id', event.id).maybeSingle();

  if (prior?.processed) return json({ received: true, duplicate: true });

  if (!prior) {
    const { error: claimErr } = await admin
      .from('billing_events').insert({ id: event.id, type: event.type });
    if (claimErr && !/duplicate|unique/i.test(claimErr.message)) {
      console.error('could not record event:', claimErr.message);
      return json({ error: 'Storage error' }, 500);
    }
  }

  try {
    await handle(event);
  } catch (e) {
    console.error('handler failed for', event.type, String(e));
    return json({ error: 'Handler error' }, 500);
  }

  const { error: doneErr } = await admin
    .from('billing_events').update({ processed: true }).eq('id', event.id);
  if (doneErr) console.error('could not mark event processed:', event.id, doneErr.message);

  return json({ received: true });
});

async function findSub(subscriptionId: string) {
  const { data, error } = await admin
    .from('billing_subscriptions')
    .select('id, org_id, seats, status, last_event_at, email')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  if (error) throw new Error('lookup failed: ' + error.message);
  return data;
}

// REACTIVATION.
// A returning customer already has an account and a password - sending them
// back through signup would just hit "an account with that email already
// exists", leaving them paid up and still locked out. So when a payment lands
// for an email that already owns a workspace, attach the new subscription to
// that workspace and let syncOrg switch it back on. They simply sign in.
async function tryRelinkToExistingOrg(subscriptionId: string) {
  const row = await findSub(subscriptionId);
  if (!row || row.org_id) return;                                  // already attached
  if (row.status !== 'active' && row.status !== 'trialing') return; // not paying yet
  if (!row.email) return;                                          // email arrives with checkout.session.completed

  // Does this email already own a workspace? Only an owner can bring one back.
  const { data: prof } = await admin
    .from('profiles')
    .select('org_id')
    .eq('email', row.email)
    .eq('role', 'master')
    .limit(1)
    .maybeSingle();
  if (!prof?.org_id) return; // brand-new customer: normal signup flow applies

  // Never take a workspace that a different LIVE subscription is already
  // paying for - that would silently move billing between subscriptions.
  const { data: live } = await admin
    .from('billing_subscriptions')
    .select('id')
    .eq('org_id', prof.org_id)
    .in('status', ['active', 'trialing'])
    .neq('id', row.id)
    .limit(1);
  if (live && live.length) return;

  // Release the dead subscription's claim first: org_id has a partial unique
  // index, so two rows cannot point at the same workspace.
  const { error: relErr } = await admin
    .from('billing_subscriptions')
    .update({ org_id: null, updated_at: now() })
    .eq('org_id', prof.org_id)
    .neq('id', row.id);
  if (relErr) throw new Error('could not release the old subscription: ' + relErr.message);

  const { error: linkErr } = await admin
    .from('billing_subscriptions')
    .update({ org_id: prof.org_id, updated_at: now() })
    .eq('id', row.id)
    .is('org_id', null);
  if (linkErr) throw new Error('could not attach the subscription: ' + linkErr.message);

  console.log('reactivated workspace', prof.org_id, 'from subscription', subscriptionId);
}

async function linkAndSync(subscriptionId: string) {
  await tryRelinkToExistingOrg(subscriptionId);
  await syncOrg(subscriptionId);
}

// Immutable facts from the checkout. Never status, never seats.
async function recordCheckoutFacts(args: {
  subscriptionId: string; customerId: string; email: string | null; checkoutSessionId: string;
}) {
  const existing = await findSub(args.subscriptionId);

  if (!existing) {
    // status/seats omitted so the column defaults apply ('incomplete', 1). The
    // gate stays shut until customer.subscription.* confirms the subscription
    // is really active - which for ACH is only once the debit clears.
    const { error } = await admin.from('billing_subscriptions').insert({
      stripe_subscription_id: args.subscriptionId,
      stripe_customer_id: args.customerId,
      email: args.email,
      checkout_session_id: args.checkoutSessionId,
      updated_at: now(),
    });
    if (error) throw new Error('insert failed: ' + error.message);
    return;
  }

  const patch: Record<string, unknown> = {
    stripe_customer_id: args.customerId,
    checkout_session_id: args.checkoutSessionId,
    updated_at: now(),
  };
  if (args.email) patch.email = args.email;

  const { error } = await admin
    .from('billing_subscriptions').update(patch).eq('id', existing.id);
  if (error) throw new Error('update failed: ' + error.message);
}

// Mutable state, owned exclusively by customer.subscription.* events.
async function applySubscriptionState(args: {
  subscriptionId: string; customerId: string; status: string; seats: number | null;
  itemId: string | null; currentPeriodEnd: string | null; eventAt: string;
}) {
  const existing = await findSub(args.subscriptionId);

  const patch: Record<string, unknown> = {
    status: args.status, last_event_at: args.eventAt, updated_at: now(),
  };
  if (args.seats !== null) patch.seats = args.seats;
  if (args.itemId !== null) patch.stripe_item_id = args.itemId;
  if (args.currentPeriodEnd !== null) patch.current_period_end = args.currentPeriodEnd;

  if (!existing) {
    const { error } = await admin.from('billing_subscriptions').insert({
      stripe_subscription_id: args.subscriptionId,
      stripe_customer_id: args.customerId,
      ...patch,
    });
    if (error) throw new Error('insert failed: ' + error.message);
    await linkAndSync(args.subscriptionId);
    return;
  }

  // Recency guard in the WHERE clause so it is atomic rather than a
  // check-then-write race. An older event matches zero rows and is dropped.
  const { data: updated, error } = await admin
    .from('billing_subscriptions')
    .update(patch)
    .eq('id', existing.id)
    .lt('last_event_at', args.eventAt)
    .select('id');
  if (error) throw new Error('update failed: ' + error.message);

  if (!updated || updated.length === 0) {
    console.log('dropped stale event for', args.subscriptionId, 'at', args.eventAt);
    return;
  }
  await linkAndSync(args.subscriptionId);
}

// Mirror billing state onto the workspace, once one has been claimed.
async function syncOrg(subscriptionId: string) {
  const data = await findSub(subscriptionId);
  if (!data?.org_id) return; // not redeemed yet - nothing to mirror

  const paying = data.status === 'active' || data.status === 'trialing';
  const plan = paying ? 'paid' : data.status === 'past_due' ? 'past_due' : 'canceled';

  const patch: Record<string, unknown> = { plan, seat_limit: data.seats };
  // orgs.active IS enforced: auth_org_id() returns NULL for an inactive org,
  // which empties every org-scoped table, and assertCanDial() blocks calling.
  // past_due deliberately leaves active alone - that is the dunning grace
  // period and the team keeps working while Stripe retries the card.
  if (plan === 'canceled') patch.active = false;
  if (plan === 'paid') patch.active = true;

  const { error } = await admin.from('orgs').update(patch).eq('id', data.org_id);
  if (error) throw new Error('org sync failed: ' + error.message);
}

async function handle(event: Stripe.Event) {
  const eventAt = tsToIso(event.created) || now();

  switch (event.type) {
    // Fires once after checkout. The ONLY event carrying the email and the
    // checkout session id. Writes no mutable state - see the header comment.
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode !== 'subscription') return;

      const subId = idOf(s.subscription);
      const custId = idOf(s.customer);
      if (!subId || !custId) {
        console.error('checkout session without subscription/customer', s.id);
        return;
      }

      const email = String(s.customer_details?.email || s.customer_email || '')
        .trim().toLowerCase();

      await recordCheckoutFacts({
        subscriptionId: subId, customerId: custId,
        email: email || null, checkoutSessionId: s.id,
      });
      // The email may only now have arrived, which is what makes a returning
      // customer recognisable - so try the relink here too.
      await linkAndSync(subId);
      return;
    }

    // Authoritative seat count and status.
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const custId = idOf(sub.customer);
      if (!custId) return;

      const item = sub.items?.data?.[0] as unknown as Record<string, unknown> | undefined;
      const qty = item?.quantity;

      // current_period_end sits on the subscription in older API versions and
      // on the subscription item in newer ones. Read whichever exists.
      const periodEnd =
        tsToIso((sub as unknown as Record<string, unknown>).current_period_end) ??
        tsToIso(item?.current_period_end);

      await applySubscriptionState({
        subscriptionId: sub.id,
        customerId: custId,
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        seats: typeof qty === 'number' && qty > 0 ? qty : null,
        itemId: typeof item?.id === 'string' ? (item.id as string) : null,
        currentPeriodEnd: periodEnd,
        eventAt,
      });
      return;
    }

    // Demote only. Recovery comes from customer.subscription.updated.
    case 'invoice.payment_failed': {
      const inv = event.data.object as unknown as Record<string, unknown>;
      const parent = inv.parent as Record<string, unknown> | undefined;
      const details = parent?.subscription_details as Record<string, unknown> | undefined;
      const subId = idOf(inv.subscription) ?? idOf(details?.subscription);
      if (!subId) return;

      const existing = await findSub(subId);
      if (!existing) return;
      if (existing.status === 'canceled') return; // never revive a dead sub

      const { data: updated, error } = await admin
        .from('billing_subscriptions')
        .update({ status: 'past_due', last_event_at: eventAt, updated_at: now() })
        .eq('id', existing.id)
        .lt('last_event_at', eventAt)
        .select('id');
      if (error) throw new Error('invoice status update failed: ' + error.message);
      if (updated && updated.length) await syncOrg(subId);
      return;
    }

    // Deliberately ignored - see the comment on invoice.payment_failed.
    case 'invoice.payment_succeeded':
      return;
  }
}
