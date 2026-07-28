/**
 * Per-customer Twilio provisioning.
 *
 * Gives a workspace its own Twilio SUBACCOUNT, API key, TwiML app and phone
 * number, so its usage is metered separately and its caller reputation is its
 * own rather than shared with every other customer.
 *
 * DESIGN NOTE — why we create an API key ON the subaccount
 * A browser softphone needs a Voice Access Token, and an Access Token must be
 * signed with an API key + secret. It is undocumented whether the PARENT key
 * can sign for a subaccount. Creating a key on the subaccount is the documented
 * path and works either way, so it is the safe choice. If the spike later shows
 * the parent key is sufficient, we can stop creating these without changing any
 * consumer: callers read the org's key when present and fall back to the
 * deployment's env credentials when absent.
 *
 * SPENDS MONEY: buying a phone number is a real charge. Every entry point is
 * idempotent and refuses to run twice for the same org.
 */
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqijyhudfiteivejcgox.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function admin() {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Public base URL Twilio should call back on, per deployment. */
function voiceBaseUrl() {
  const explicit = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  // Falls back to the AIIS host, which is what shipped before this existed.
  return 'https://fleet.ins2day.com';
}

/**
 * Provision telephony for one org. Idempotent: if the org already has a
 * subaccount, it returns what exists and buys nothing.
 *
 * @param {string} orgId
 * @param {{ areaCode?: string, dryRun?: boolean }} opts
 */
async function provisionOrg(orgId, opts = {}) {
  const { TWILIO_ACCOUNT_SID: PARENT_SID, TWILIO_AUTH_TOKEN: PARENT_TOKEN } = process.env;
  if (!PARENT_SID || !PARENT_TOKEN) {
    throw new Error('Twilio parent credentials are not configured on this deployment');
  }

  const sb = admin();

  const { data: org, error: orgErr } = await sb
    .from('orgs')
    .select('id, name, plan, active, telephony_status, twilio_subaccount_sid, twilio_number')
    .eq('id', orgId)
    .maybeSingle();
  if (orgErr) throw new Error('org lookup failed: ' + orgErr.message);
  if (!org) throw new Error('workspace not found');

  // Already done. Never buy a second number for the same workspace.
  if (org.twilio_subaccount_sid) {
    return {
      alreadyProvisioned: true,
      orgId,
      subaccountSid: org.twilio_subaccount_sid,
      phoneNumber: org.twilio_number,
      telephonyStatus: org.telephony_status,
    };
  }

  if (org.active === false) throw new Error('workspace is inactive - not provisioning');
  if (org.plan === 'internal') throw new Error('internal workspace uses the shared account');

  // Optional area-code preference. Mapping a ZIP to an area code needs a
  // lookup table we do not have, so this stays an explicit caller choice
  // rather than a bad guess - an unrelated area code hurts answer rates.
  const areaCode = String(opts.areaCode || '').replace(/\D/g, '');

  if (opts.dryRun) {
    return { dryRun: true, orgId, wouldBuyAreaCode: areaCode || 'any US local' };
  }

  const parent = twilio(PARENT_SID, PARENT_TOKEN);
  const created = {};

  try {
    // 1) Subaccount. Named so it is identifiable in the Twilio console.
    const sub = await parent.api.v2010.accounts.create({
      friendlyName: 'Aduna - ' + String(org.name || orgId).slice(0, 60),
    });
    created.subaccountSid = sub.sid;

    const subClient = twilio(PARENT_SID, PARENT_TOKEN, { accountSid: sub.sid });

    // 2) API key on the subaccount. The secret is returned exactly once.
    const key = await subClient.newKeys.create({ friendlyName: 'aduna-dialer' });
    if (!key || !key.secret) throw new Error('Twilio did not return an API key secret');
    created.apiKeySid = key.sid;
    created.apiKeySecret = key.secret;

    // 3) TwiML app so outbound browser calls route to our webhook.
    const app = await subClient.applications.create({
      friendlyName: 'Aduna Dialer Voice',
      voiceUrl: voiceBaseUrl() + '/api/twilio/voice',
      voiceMethod: 'POST',
    });
    created.twimlAppSid = app.sid;

    // 4) A phone number. THIS IS THE CHARGE.
    const searchOpts = { limit: 1, voiceEnabled: true };
    if (areaCode) searchOpts.areaCode = Number(areaCode);
    let available = await subClient.availablePhoneNumbers('US').local.list(searchOpts);
    if (!available.length && areaCode) {
      // Requested area code is exhausted - fall back rather than fail the whole
      // provision, and record what we actually got.
      available = await subClient.availablePhoneNumbers('US').local.list({ limit: 1, voiceEnabled: true });
    }
    if (!available.length) throw new Error('no US local numbers available right now');

    const bought = await subClient.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber,
      voiceApplicationSid: app.sid,
    });
    created.phoneNumber = bought.phoneNumber;

    // 5) Persist. Secret goes to the locked table, identifiers to orgs.
    const { error: secErr } = await sb.from('org_telephony_secrets').upsert({
      org_id: orgId,
      api_key_secret: created.apiKeySecret,
    }, { onConflict: 'org_id' });
    if (secErr) throw new Error('could not store the API secret: ' + secErr.message);

    const { error: updErr } = await sb.from('orgs').update({
      twilio_subaccount_sid: created.subaccountSid,
      twilio_api_key_sid: created.apiKeySid,
      twilio_twiml_app_sid: created.twimlAppSid,
      twilio_number: created.phoneNumber,
      telephony_status: 'ready',
    }).eq('id', orgId);
    if (updErr) throw new Error('could not save telephony details: ' + updErr.message);

    return {
      orgId,
      subaccountSid: created.subaccountSid,
      apiKeySid: created.apiKeySid,
      twimlAppSid: created.twimlAppSid,
      phoneNumber: created.phoneNumber,
      telephonyStatus: 'ready',
    };
  } catch (e) {
    // Leave a breadcrumb so a half-finished provision can be found and cleaned
    // up rather than silently costing money every retry.
    console.error('provisionOrg failed for', orgId, String(e && e.message || e), 'partial:', {
      subaccountSid: created.subaccountSid,
      apiKeySid: created.apiKeySid,
      twimlAppSid: created.twimlAppSid,
      phoneNumber: created.phoneNumber,
    });
    if (created.subaccountSid) {
      try {
        await sb.from('orgs').update({
          twilio_subaccount_sid: created.subaccountSid,
          telephony_status: 'provisioning',
        }).eq('id', orgId);
      } catch (e2) { /* best effort */ }
    }
    throw e;
  }
}

/**
 * Twilio credentials to use for a given org.
 * Falls back to the deployment's env credentials when the org has none, which
 * is exactly the behaviour that shipped before per-tenant provisioning - so
 * AIIS and any unprovisioned workspace are unaffected.
 */
async function credentialsForOrg(orgId) {
  const env = {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKey: process.env.TWILIO_API_KEY,
    apiSecret: process.env.TWILIO_API_SECRET,
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID,
    source: 'env',
  };
  if (!orgId) return env;

  try {
    const sb = admin();
    const { data: org } = await sb
      .from('orgs')
      .select('twilio_subaccount_sid, twilio_api_key_sid, twilio_twiml_app_sid')
      .eq('id', orgId)
      .maybeSingle();
    if (!org || !org.twilio_subaccount_sid || !org.twilio_api_key_sid) return env;

    const { data: sec } = await sb
      .from('org_telephony_secrets')
      .select('api_key_secret')
      .eq('org_id', orgId)
      .maybeSingle();
    if (!sec || !sec.api_key_secret) return env;

    return {
      accountSid: org.twilio_subaccount_sid,
      apiKey: org.twilio_api_key_sid,
      apiSecret: sec.api_key_secret,
      twimlAppSid: org.twilio_twiml_app_sid || env.twimlAppSid,
      source: 'subaccount',
    };
  } catch (e) {
    console.error('credentialsForOrg fell back to env:', e && e.message);
    return env;
  }
}

module.exports = { provisionOrg, credentialsForOrg, voiceBaseUrl };
