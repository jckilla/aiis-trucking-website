// Twilio inbound-SMS webhook. Records opt-outs (STOP/UNSUBSCRIBE/etc.) back into the CRM
// as crm_leads.do_not_text=true, so every surface (dialer, reminders, email) honors them —
// not just the carrier. Point Twilio's 'A MESSAGE COMES IN' webhook (per number or on the
// Messaging Service) at this function's URL. verify_jwt=false (Twilio sends no JWT).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const FN_URL = 'https://cqijyhudfiteivejcgox.supabase.co/functions/v1/inbound-sms';
const STOP_WORDS  = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP', 'OPTIN']);

const xml = (inner = '') =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, { status: 200, headers: { 'Content-Type': 'text/xml' } });

// Validate Twilio's X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)).
async function validTwilioSig(token: string, url: string, params: Record<string, string>, sig: string): Promise<boolean> {
  try {
    if (!token || !sig) return false;
    let data = url;
    for (const k of Object.keys(params).sort()) data += k + params[k];
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return expected === sig;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return xml();

  const raw = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });

  const from = params.From || params.from || '';
  const firstWord = (params.Body || params.body || '').trim().toUpperCase().split(/\s+/)[0] || '';

  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const sigOk = await validTwilioSig(Deno.env.get('TWILIO_AUTH_TOKEN') || '', FN_URL, params, req.headers.get('x-twilio-signature') || '');

  if (STOP_WORDS.has(firstWord)) {
    // Opt-OUT is fail-safe (conservative) — always record it, even without a verified
    // signature, so an opt-out is never missed.
    await admin.rpc('crm_apply_sms_optout', { p_from: from, p_optout: true });
    return xml();
  }

  if (START_WORDS.has(firstWord)) {
    // Opt-IN CLEARS a suppression, so only honor it when the request is proven to be from
    // Twilio (valid signature). Otherwise ignore, to prevent forged re-subscription.
    if (sigOk) await admin.rpc('crm_apply_sms_optout', { p_from: from, p_optout: false });
    return xml();
  }

  return xml();
});
