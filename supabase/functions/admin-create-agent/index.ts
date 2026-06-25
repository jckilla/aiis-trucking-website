// Supabase Edge Function: admin-create-agent
// Master-only. Creates a cold-calling agent login (auth user + profile).
// Uses the service-role key (auto-injected) so it never runs in the browser.
// Deploy: Supabase Dashboard > Edge Functions > Deploy new function (name: admin-create-agent)
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ALLOWED = ['https://fleet.ins2day.com', 'http://localhost:3000'];
function corsHeaders(origin: string): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Vary': 'Origin',
  };
  // production + this project's own Vercel preview deployments only (no open *.vercel.app)
  if (ALLOWED.includes(origin) || /^https:\/\/aiis-trucking-website[a-z0-9-]*\.vercel\.app$/.test(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) Verify the caller and that they are a master
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers });
  }
  const caller = userData.user;
  let isMaster = (caller.app_metadata as Record<string, unknown> | null)?.role === 'master';
  if (!isMaster) {
    const { data: prof } = await admin.from('profiles').select('role').eq('id', caller.id).single();
    isMaster = prof?.role === 'master';
  }
  if (!isMaster) {
    return new Response(JSON.stringify({ error: 'Master access required' }), { status: 403, headers });
  }

  // 2) Validate input
  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const full_name = String(body.full_name || '').trim();
  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'email and password are required' }), { status: 400, headers });
  }
  if (password.length < 8) {
    return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400, headers });
  }

  // 3) Create the agent (role baked into app_metadata so RLS sees it from first login)
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: 'agent' },
    user_metadata: { full_name },
  });
  if (createErr) {
    return new Response(JSON.stringify({ error: createErr.message }), { status: 400, headers });
  }

  // 4) Ensure the profile reflects name/role/active. Upsert in case the signup
  //    trigger has not committed yet (race) — never leave a half-created agent.
  const { error: profErr } = await admin.from('profiles')
    .upsert({ id: created.user!.id, email, full_name: full_name || email, role: 'agent', active: true }, { onConflict: 'id' });
  if (profErr) {
    return new Response(JSON.stringify({ ok: true, id: created.user!.id, email, warning: 'profile sync failed: ' + profErr.message }), { headers });
  }

  return new Response(JSON.stringify({ ok: true, id: created.user!.id, email }), { headers });
});
