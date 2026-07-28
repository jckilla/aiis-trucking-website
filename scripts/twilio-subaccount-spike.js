#!/usr/bin/env node
/**
 * Twilio subaccount spike — run this FIRST, before any per-tenant work.
 *
 * WHY THIS EXISTS
 * The Aduna Dialer is a browser softphone. That needs a Voice SDK Access Token,
 * and an Access Token must be signed with an API Key + Secret. For a per-customer
 * subaccount there are two possible answers and the docs do not say which:
 *
 *   (a) create an API Key ON THE SUBACCOUNT and sign with that   -> we must store
 *       a secret per tenant (secrets at rest, rotation, recovery), or
 *   (b) sign with the PARENT's API Key while scoping to the subaccount SID
 *       -> no per-tenant secrets at all, far simpler and safer.
 *
 * Which one is true decides the orgs schema, the provisioning code, and how all
 * eight api/twilio/* endpoints resolve credentials. Guessing and refactoring a
 * LIVE dialer on the guess is how you break production. So: measure first.
 *
 * WHAT IT DOES
 *   1. create a subaccount under the parent
 *   2. create an API key on the SUBACCOUNT            -> tests (a)
 *   3. mint an Access Token with the subaccount key   -> tests (a)
 *   4. mint an Access Token with the PARENT key,
 *      scoped to the subaccount                       -> tests (b)
 *   5. create a TwiML app on the subaccount
 *   6. optionally buy a number and place one real call (COSTS MONEY, off by default)
 *
 * SAFETY
 *   - Buying a number and placing a call are behind --spend. Without it this
 *     script never spends anything.
 *   - The subaccount it creates is named "ZZ SPIKE ..." and is closed again at
 *     the end unless --keep is passed. Closed subaccounts are auto-deleted by
 *     Twilio after 30 days.
 *   - Credentials come from the environment. Nothing is written to disk.
 *
 * USAGE
 *   set TWILIO_ACCOUNT_SID=AC...        (parent account SID)
 *   set TWILIO_API_KEY=SK...            (parent API key SID)
 *   set TWILIO_API_SECRET=...           (parent API key secret)
 *   set TWILIO_AUTH_TOKEN=...           (parent auth token - needed to create subaccounts)
 *   node scripts/twilio-subaccount-spike.js
 *   node scripts/twilio-subaccount-spike.js --spend --to +15551234567 --area 657
 */

const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };

const SPEND = has('--spend');
const KEEP = has('--keep');
const TO = val('--to', '');
const AREA = val('--area', '657');

const {
  TWILIO_ACCOUNT_SID: PARENT_SID,
  TWILIO_AUTH_TOKEN: PARENT_TOKEN,
  TWILIO_API_KEY: PARENT_KEY,
  TWILIO_API_SECRET: PARENT_SECRET,
} = process.env;

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${step}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  if (!PARENT_SID || !PARENT_TOKEN) {
    console.error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.');
    process.exit(1);
  }
  if (!PARENT_KEY || !PARENT_SECRET) {
    console.error('Missing TWILIO_API_KEY / TWILIO_API_SECRET (needed to test option b).');
    process.exit(1);
  }
  if (SPEND && !TO) {
    console.error('--spend requires --to +1XXXXXXXXXX (a number you can answer).');
    process.exit(1);
  }

  const parent = twilio(PARENT_SID, PARENT_TOKEN);
  console.log('\nTwilio subaccount spike');
  console.log('parent:', PARENT_SID);
  console.log('mode  :', SPEND ? 'WILL SPEND (buys a number, places one call)' : 'dry run, no spend\n');

  let sub = null;
  let subKey = null;

  // 1. Subaccount --------------------------------------------------------
  try {
    sub = await parent.api.v2010.accounts.create({
      friendlyName: 'ZZ SPIKE ' + new Date().toISOString().slice(0, 19),
    });
    record('create subaccount', true, sub.sid);
  } catch (e) {
    record('create subaccount', false, e.message);
    return finish(parent, null);
  }

  // 2. API key ON the subaccount  -> tests option (a) -------------------
  //    Authenticated as the parent, but targeting the subaccount.
  try {
    const subClient = twilio(PARENT_SID, PARENT_TOKEN, { accountSid: sub.sid });
    subKey = await subClient.newKeys.create({ friendlyName: 'aduna-spike' });
    record('create API key on subaccount', true, subKey.sid + ' (secret returned: ' + (subKey.secret ? 'yes' : 'NO') + ')');
  } catch (e) {
    record('create API key on subaccount', false, e.message);
  }

  // 3. Access Token signed with the SUBACCOUNT key -> option (a) --------
  if (subKey && subKey.secret) {
    try {
      const t = new AccessToken(sub.sid, subKey.sid, subKey.secret, { identity: 'spike_user', ttl: 600 });
      t.addGrant(new VoiceGrant({ incomingAllow: true }));
      const jwt = t.toJwt();
      record('access token via SUBACCOUNT key', typeof jwt === 'string' && jwt.split('.').length === 3, 'option (a) viable');
    } catch (e) {
      record('access token via SUBACCOUNT key', false, e.message);
    }
  }

  // 4. Access Token signed with the PARENT key, scoped to sub -> (b) ----
  //    If this works AND a call actually connects, we never store per-tenant
  //    secrets, which is a materially better security posture.
  try {
    const t = new AccessToken(sub.sid, PARENT_KEY, PARENT_SECRET, { identity: 'spike_user', ttl: 600 });
    t.addGrant(new VoiceGrant({ incomingAllow: true }));
    const jwt = t.toJwt();
    record('access token via PARENT key scoped to subaccount', typeof jwt === 'string' && jwt.split('.').length === 3,
      'option (b) MINTS — note: minting is not proof it AUTHENTICATES; only a real device registration proves that');
  } catch (e) {
    record('access token via PARENT key scoped to subaccount', false, e.message);
  }

  // 5. TwiML app on the subaccount --------------------------------------
  try {
    const subClient = twilio(PARENT_SID, PARENT_TOKEN, { accountSid: sub.sid });
    const app = await subClient.applications.create({
      friendlyName: 'Aduna Spike Voice',
      voiceUrl: 'https://app.adunadialer.com/api/twilio/voice',
      voiceMethod: 'POST',
    });
    record('create TwiML app on subaccount', true, app.sid);
  } catch (e) {
    record('create TwiML app on subaccount', false, e.message);
  }

  // 6. Number + real call (only with --spend) ----------------------------
  if (SPEND) {
    try {
      const subClient = twilio(PARENT_SID, PARENT_TOKEN, { accountSid: sub.sid });
      const avail = await subClient.availablePhoneNumbers('US').local.list({ areaCode: Number(AREA), limit: 1 });
      if (!avail.length) throw new Error('no numbers available in area code ' + AREA);
      const bought = await subClient.incomingPhoneNumbers.create({ phoneNumber: avail[0].phoneNumber });
      record('buy number on subaccount', true, bought.phoneNumber);

      const call = await subClient.calls.create({
        to: TO,
        from: bought.phoneNumber,
        twiml: '<Response><Say>Aduna Dialer subaccount spike succeeded.</Say></Response>',
      });
      record('place call from subaccount', true, call.sid);
    } catch (e) {
      record('buy number / place call', false, e.message);
    }
  } else {
    console.log('  SKIP  buy number + place call (pass --spend --to +1... to test for real)');
  }

  await finish(parent, sub);
}

async function finish(parent, sub) {
  if (sub && !KEEP) {
    try {
      await parent.api.v2010.accounts(sub.sid).update({ status: 'closed' });
      console.log('\n  cleaned up: subaccount closed (' + sub.sid + ')');
    } catch (e) {
      console.log('\n  WARNING could not close subaccount ' + sub.sid + ': ' + e.message);
    }
  } else if (sub) {
    console.log('\n  kept subaccount ' + sub.sid + ' (--keep)');
  }

  console.log('\n--- verdict ---');
  const a = results.find((r) => r.step === 'access token via SUBACCOUNT key');
  const b = results.find((r) => r.step === 'access token via PARENT key scoped to subaccount');
  if (b && b.ok) {
    console.log('Option (b) looks viable: parent key can sign for a subaccount.');
    console.log('If a real softphone registers with it, we never store per-tenant secrets.');
  }
  if (a && a.ok) {
    console.log('Option (a) works: per-subaccount API keys can be created and returned.');
    console.log('Costs us secret storage + rotation per tenant, but is the documented path.');
  }
  if ((!a || !a.ok) && (!b || !b.ok)) {
    console.log('NEITHER token path worked — per-tenant softphone needs a rethink before building.');
  }
  console.log('');
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('spike crashed:', e); process.exit(1); });
