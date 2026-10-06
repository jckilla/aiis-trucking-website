// Supabase Edge Function: fmcsa-daily-leads
// Pulls California trucking leads from FMCSA open data (data.transportation.gov, refreshed daily
// ~03:40 Pacific) into the AIIS dialer. Triggered by pg_cron at 16:00 and 17:00 UTC; the function
// itself only runs when it is 9 AM in Los Angeles, so the schedule survives daylight-saving changes.
//
//   A) New authority   MC application pending + no liability insurance on file  -> LIST_NEW
//   B) BMC-35 lapsed   liability cancelled, FMCSA shows $0 on file (still in the
//                      30-day revocation window or already revoked)             -> LIST_LAPSED
//   C) BMC-35 pending  cancellation coming, no replacement filing found         -> LIST_SOON
//   D) Uninsured now   authority ACTIVE but $0 liability on file, or authority revoked FOR an
//                      insurance cancellation - no cancellation date needed     -> LIST_UNINSURED
//   E) Underinsured    liability on file but BELOW the carrier's own federal minimum -> LIST_UNDER
//   F) Hygiene         leads in those lists that FMCSA now shows insured / granted / replaced /
//                      cured are moved out so nobody keeps calling them.
//
// D and E came out of a 2026-10-06 survey of the source: they are invisible to A/B/C because they
// need no cancellation record (D) and because A/B/C only ever look at bipd_file = 0 (E).
//
// Data notes (learned the hard way):
//   * InsHist (3uet-3z4i) holds ONLY cancelled/replaced policies. Replacements live in the active
//     table (c5y8-a4uz). Policy numbers are formatted differently between the two -> normalise.
//   * The Motus Carrier table (inys-ebih) carries FMCSA's own `bipd_file` amount: 0 = nothing on file.
//     A carrier can hold several dockets, so "uninsured" means EVERY docket reads 0.
//   * Census (az4n-8mr2) has owners, cell, email; dot_number is numeric there (unquoted IN list).
//
// Auth: pg_cron sends `x-cron-secret`, checked against private.job_secrets through the
// service-role-only RPC job_secret_ok(). The secret is generated inside Postgres and never leaves it.
// Body (JSON, optional): { apps_lookback_days: 7, canc_lookback_days: 7, canc_ahead_days: 90,
//                          dry_run: false, force: false, skip_standing: false }
//   force         - run even if it is not 9 AM in Los Angeles
//   skip_standing - skip the D/E standing pools (they are a full-state scan, ~20 s)
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ORG = '00000000-0000-0000-0000-0000000000a1';
const REP: string | null = null; // unassigned: the dialer shows unassigned leads to every rep, so Jack and Kail both work these lists (2026-09-15)
const STATE = 'CA';
const LIST_NEW = 'New Authority CA - Needs Insurance';
const LIST_NEW_CLOSED = 'New Authority CA - Closed';
const LIST_LAPSED = 'BMC-35 CA Lapsed - Uninsured';
const LIST_SOON = 'BMC-35 CA Cancelling Soon';
const LIST_REPLACED = 'BMC-35 - Already Replaced';
const LIST_UNINSURED = 'CA Uninsured Now - No Liability On File';
const LIST_UNINSURED_CLOSED = 'CA Uninsured Now - Now Insured';
const LIST_UNDER = 'Underinsured CA - Below Federal Minimum';
const LIST_UNDER_CLOSED = 'Underinsured CA - Cured';
const SODA = 'https://data.transportation.gov/resource/';
const UA = 'aiis-dialer-fmcsa-daily';

type Row = Record<string, string>;
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// ---------- helpers ----------
function laParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || '';
  return { y: +g('year'), m: +g('month'), d: +g('day'), h: +g('hour') % 24 };
}
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
const parse8 = (s: string) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const fmt8 = (s: string) => (s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || '');
const norm = (p: string) => (p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const digits10 = (p: string) => {
  let d = (p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : '';
};
const fmtPhone = (p: string) => {
  const d = digits10(p);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '';
};
const money = (s: string) => {
  const n = parseFloat(s || '');
  return isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '';
};
const amount = (s: string) => { const n = parseFloat(s || ''); return isFinite(n) ? n : 0; };
const segment = (units: number) =>
  units <= 1 ? 'owner_operator' : units <= 9 ? 'small_fleet' : units <= 49 ? 'commercial_lines' : 'enterprise';
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const inList = (v: string[]) => v.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
const MOTOR_CARRIER = /motor carrier/i;
const PROPERTY = /motor carrier of property/i;
// FMCSA's own wording when an authority is suspended for want of an insurance filing
const INS_CAUSE = /insurance|BOC-3|filing cancellation/i;

async function soda(ds: string, params: Record<string, string>): Promise<Row[]> {
  const out: Row[] = [];
  const limit = 50000;
  for (let offset = 0; ; offset += limit) {
    const q = new URLSearchParams({ ...params, $limit: String(limit), $offset: String(offset) });
    let batch: Row[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${SODA}${ds}.json?${q}`, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error(`${ds} HTTP ${r.status}`);
        batch = await r.json();
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
    out.push(...batch);
    if (batch.length < limit) return out;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: okSecret } = await admin.rpc('job_secret_ok', {
    p_job: 'fmcsa-daily-leads', p_secret: req.headers.get('x-cron-secret') || '',
  });
  if (okSecret !== true) return json({ error: 'forbidden' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const appsLookback = Number(body.apps_lookback_days ?? 7);
  const cancLookback = Number(body.canc_lookback_days ?? 7);
  const cancAhead = Number(body.canc_ahead_days ?? 90);
  const dryRun = body.dry_run === true;
  const force = body.force === true;
  const skipStanding = body.skip_standing === true;

  const la = laParts();
  if (!force && la.h !== 9) return json({ skipped: `LA hour is ${la.h}, runs at 9` });
  const today = new Date(Date.UTC(la.y, la.m - 1, la.d));
  const T = ymd(today), TODAY = iso(today);
  const summary: Record<string, unknown> = { date: TODAY, dry_run: dryRun, apps_lookback_days: appsLookback, canc_lookback_days: cancLookback };
  const started = Date.now();

  try {
    // ---- 1. Every California authority record. One carrier can hold several dockets, so keep them all:
    //         "uninsured" is only true when EVERY docket reads $0 on file.
    const carriers = new Map<string, Row>();
    const authRows = new Map<string, Row[]>();
    for (const r of await soda('inys-ebih', {
      $select: 'usdot_number,docket_number,legal_name,bus_city,bus_zip_code,bus_telno,op_auth_status,op_auth_type,bipd_file,min_cov_amount',
      $where: `bus_state_code='${STATE}'`,
    })) {
      if (!carriers.has(r.usdot_number)) carriers.set(r.usdot_number, r);
      authRows.set(r.usdot_number, [...(authRows.get(r.usdot_number) || []), r]);
    }
    summary.ca_carrier_records = carriers.size;

    // ---- 2. New authority applicants (pending + nothing on file) with an application date in the window
    const appDate = new Map<string, string>();
    for (const r of await soda('yu5v-wbh6', {
      $select: 'usdot_number,status_change_date,reason',
      $where: `op_auth_status='Pending' AND status_change_date >= '${ymd(addDays(today, -appsLookback))}'`,
    })) {
      const cur = appDate.get(r.usdot_number);
      const initial = r.reason === 'Initial Status';
      if (!cur || initial || r.status_change_date > cur) appDate.set(r.usdot_number, r.status_change_date);
    }
    // Motor carriers only: brokers and freight forwarders need a $75K BMC-84 bond, not truck liability.
    const isMotorCarrier = (t: string) => MOTOR_CARRIER.test(t || '');
    const newAuth: Row[] = [];
    for (const [dot, c] of carriers) {
      if (c.op_auth_status === 'Pending' && amount(c.bipd_file) === 0 && appDate.has(dot) && isMotorCarrier(c.op_auth_type)) newAuth.push({ ...c, applied: appDate.get(dot)! });
    }
    summary.new_authority_candidates = newAuth.length;

    // ---- 3. BMC-35 cancellations in the window, California only
    const canc = await soda('3uet-3z4i', {
      $select: 'usdot_number,docket_number,policy_no,insurance_company_name,effective_date,cancl_effective_date,filing_status_reason,max_cov_amount',
      $where: `ins_type_code='1' AND cancl_effective_date >= '${ymd(addDays(today, -cancLookback))}' AND cancl_effective_date <= '${ymd(addDays(today, cancAhead))}'`,
    });
    const byDot = new Map<string, Row[]>();
    for (const r of canc) {
      if (!carriers.has(r.usdot_number) || !r.cancl_effective_date) continue;
      byDot.set(r.usdot_number, [...(byDot.get(r.usdot_number) || []), r]);
    }
    summary.ca_cancellation_carriers = byDot.size;

    const lapsed: Row[] = [], pendingDots: string[] = [];
    for (const [dot, rows] of byDot) {
      const latest = rows.reduce((a, b) => (a.cancl_effective_date > b.cancl_effective_date ? a : b));
      const c = carriers.get(dot)!;
      if (latest.cancl_effective_date <= T) {
        if (amount(c.bipd_file) === 0) lapsed.push({ ...latest, ...c, cancel: latest.cancl_effective_date });
      } else pendingDots.push(dot);
    }

    // ---- 3b. Standing pools that need no cancellation record at all.
    //      D) uninsured now: every docket $0 on file, and either an ACTIVE authority (non-compliant
    //         today) or an authority FMCSA suspended for want of an insurance filing.
    //      E) underinsured: a filing exists but is below the carrier's own federal minimum.
    const uninsured: Row[] = [], revoked: Row[] = [], under: Row[] = [];
    if (!skipStanding) {
      const inactiveCands: string[] = [];
      for (const [dot, rows] of authRows) {
        const mc = rows.filter((r) => isMotorCarrier(r.op_auth_type));
        if (!mc.length) continue;
        const live = mc.filter((r) => ['Active', 'Inactive', 'Pending'].includes(r.op_auth_status));
        if (!live.length) continue;
        const need = Math.max(...live.map((r) => amount(r.min_cov_amount)), 0);
        if (rows.every((r) => amount(r.bipd_file) === 0) && need > 0) {
          if (live.some((r) => r.op_auth_status === 'Active')) {
            uninsured.push({ ...carriers.get(dot)!, kind_need: String(need) });
          } else if (live.some((r) => r.op_auth_status === 'Inactive')) {
            inactiveCands.push(dot);
          }
          // pending-only carriers are already covered by branch A
        }
        for (const r of mc) {
          const f = amount(r.bipd_file), m = amount(r.min_cov_amount);
          if (['Active', 'Pending'].includes(r.op_auth_status) && PROPERTY.test(r.op_auth_type || '')
              && f > 0 && f < m && m < 5_000_000) {
            const prev = under.find((u) => u.usdot_number === dot);
            if (!prev) under.push({ ...r, legal_name: carriers.get(dot)!.legal_name, bus_city: carriers.get(dot)!.bus_city, bus_zip_code: carriers.get(dot)!.bus_zip_code, bus_telno: carriers.get(dot)!.bus_telno });
            else if (m - f > amount(prev.min_cov_amount) - amount(prev.bipd_file)) Object.assign(prev, r);
          }
        }
      }
      // why did the inactive ones go inactive? only an insurance cause makes them a buyer today
      const inactReason = new Map<string, Row>();
      for (const part of chunk(inactiveCands, 100)) {
        for (const r of await soda('yu5v-wbh6', {
          $select: 'usdot_number,status_change_date,reason',
          $where: `op_auth_status='Inactive' AND usdot_number in(${inList(part)})`,
        })) {
          const cur = inactReason.get(r.usdot_number);
          if (!cur || (r.status_change_date || '') > (cur.status_change_date || '')) inactReason.set(r.usdot_number, r);
        }
      }
      for (const dot of inactiveCands) {
        const r = inactReason.get(dot);
        if (r && INS_CAUSE.test(r.reason || '')) {
          const live = (authRows.get(dot) || []).filter((x) => isMotorCarrier(x.op_auth_type));
          revoked.push({ ...carriers.get(dot)!, kind_need: String(Math.max(...live.map((x) => amount(x.min_cov_amount)), 0)), inactive_reason: r.reason || '', inactive_date: r.status_change_date || '' });
        }
      }
    }
    summary.lapsed_candidates = lapsed.length;
    summary.uninsured_active_candidates = uninsured.length;
    summary.revoked_candidates = revoked.length;
    summary.underinsured_candidates = under.length;

    // ---- 4. Current BIPD filings. A carrier holding one is NOT uninsured - but the policy that was
    //      cancelled can still sit in the active table until its cancel date, so ignore those.
    const needFilings = [...new Set([...pendingDots, ...uninsured.map((r) => r.usdot_number), ...revoked.map((r) => r.usdot_number), ...under.map((r) => r.usdot_number)])];
    const active = new Map<string, Row[]>();
    for (const part of chunk(needFilings, 100)) {
      for (const r of await soda('c5y8-a4uz', {
        $select: 'usdot_number,policy_no,insurance_company_name,effective_date,trans_date,max_cov_amount',
        $where: `ins_type_code='1' AND usdot_number in(${inList(part)})`,
      })) active.set(r.usdot_number, [...(active.get(r.usdot_number) || []), r]);
    }
    // full cancellation history for the standing pools (for the "self" test and for the pitch)
    const history = new Map<string, Row[]>();
    const needHistory = [...new Set([...uninsured.map((r) => r.usdot_number), ...revoked.map((r) => r.usdot_number)])];
    for (const part of chunk(needHistory, 100)) {
      for (const r of await soda('3uet-3z4i', {
        $select: 'usdot_number,policy_no,insurance_company_name,cancl_effective_date',
        $where: `ins_type_code='1' AND usdot_number in(${inList(part)})`,
      })) history.set(r.usdot_number, [...(history.get(r.usdot_number) || []), r]);
    }

    const replacedInfo = new Map<string, Row>(); // dot -> replacement row
    const soon: Row[] = [];
    for (const dot of pendingDots) {
      const rows = byDot.get(dot)!;
      const latest = rows.reduce((a, b) => (a.cancl_effective_date > b.cancl_effective_date ? a : b));
      const isSelf = (a: Row) => rows.some((c) => norm(a.policy_no) === norm(c.policy_no) && c.effective_date && a.effective_date &&
        Math.abs(parse8(a.effective_date).getTime() - parse8(c.effective_date).getTime()) <= 3 * 86400_000);
      const others = (active.get(dot) || []).filter((a) => a.effective_date && !isSelf(a));
      const cover = others.filter((a) => a.effective_date <= latest.cancl_effective_date);
      if (cover.length) replacedInfo.set(dot, cover.reduce((a, b) => (a.trans_date > b.trans_date ? a : b)));
      else if (others.length) replacedInfo.set(dot, others.reduce((a, b) => (a.effective_date < b.effective_date ? a : b)));
      else soon.push({ ...latest, ...carriers.get(dot)!, cancel: latest.cancl_effective_date });
    }
    summary.cancelling_soon_candidates = soon.length;

    // a standing-pool carrier with a filing that is not merely one of its own cancelled policies is insured
    const stillUninsured = (dot: string) => {
      const cancelled = new Set((history.get(dot) || []).map((c) => norm(c.policy_no)));
      return !(active.get(dot) || []).some((f) => !cancelled.has(norm(f.policy_no)));
    };

    // ---- 5. Dedupe against the CRM (USDOT, then phone). One carrier, one lead: if a carrier qualifies
    //      for more than one pool this run, the earlier (hotter) pool wins.
    const ranked = [
      ...lapsed.map((r) => ({ kind: 'lapsed', r })),
      ...soon.map((r) => ({ kind: 'soon', r })),
      ...newAuth.map((r) => ({ kind: 'new', r })),
      ...revoked.filter((r) => stillUninsured(r.usdot_number)).map((r) => ({ kind: 'revoked', r })),
      ...uninsured.filter((r) => stillUninsured(r.usdot_number)).map((r) => ({ kind: 'uninsured', r })),
      ...under.map((r) => ({ kind: 'under', r })),
    ];
    const seenDot = new Set<string>();
    const candidates = ranked.filter((c) => {
      if (seenDot.has(c.r.usdot_number)) return false;
      seenDot.add(c.r.usdot_number);
      return true;
    });
    const existingDots = new Set<string>();
    for (const part of chunk([...seenDot], 300)) {
      const { data, error } = await admin.from('crm_leads').select('dot_number').eq('org_id', ORG).in('dot_number', part);
      if (error) throw new Error('crm dot lookup: ' + error.message);
      for (const d of data || []) existingDots.add(d.dot_number);
    }
    let fresh = candidates.filter((c) => !existingDots.has(c.r.usdot_number));

    // ---- 6. Census details (owners, cell, email, fleet, and the signs of life the standing pools need)
    const census = new Map<string, Row>();
    for (const part of chunk([...new Set(fresh.map((c) => c.r.usdot_number))].filter((d) => /^\d+$/.test(d)), 150)) {
      for (const r of await soda('az4n-8mr2', {
        $select: 'dot_number,legal_name,dba_name,company_officer_1,company_officer_2,email_address,cell_phone,phone,power_units,total_drivers,phy_city,phy_zip,phy_state,status_code',
        $where: `dot_number in(${part.join(',')})`,
      })) if (!census.has(String(r.dot_number))) census.set(String(r.dot_number), r);
    }
    const phoneOf = (c: { r: Row }) => {
      const cs: Row = census.get(c.r.usdot_number) || {};
      return { phone: fmtPhone(c.r.bus_telno || cs.phone || cs.cell_phone), cell: fmtPhone(cs.cell_phone) };
    };
    const phones = [...new Set(fresh.flatMap((c) => { const p = phoneOf(c); return [digits10(p.phone), digits10(p.cell)].filter(Boolean); }))];
    const existingPhones = new Set<string>();
    for (const part of chunk(phones, 2000)) {
      const { data, error } = await admin.rpc('crm_existing_phone_digits', { p_org: ORG, p_phones: part });
      if (error) throw new Error('crm phone lookup: ' + error.message);
      for (const p of (data || []) as string[]) existingPhones.add(p);
    }
    fresh = fresh.filter((c) => { const p = phoneOf(c); return !(digits10(p.phone) && existingPhones.has(digits10(p.phone))) && !(digits10(p.cell) && existingPhones.has(digits10(p.cell))); });
    summary.already_in_crm = candidates.length - fresh.length;

    // ---- 7. Build and insert the new leads
    const STANDING = new Set(['uninsured', 'revoked', 'under']);
    const dropped: Record<string, number> = {};
    const rows = fresh.map((c) => {
      const r = c.r, cs: Row = census.get(r.usdot_number) || {};
      const units = parseInt(cs.power_units || '0', 10) || 0;
      const drivers = cs.total_drivers || '?';
      const owners = [cs.company_officer_1, cs.company_officer_2].map((o) => (o || '').trim()).filter(Boolean);
      const p = phoneOf(c);
      const mc = r.docket_number || '';
      // The standing pools are a whole-state scan rather than a dated event, so they carry quality
      // gates the dated pools do not need: a reachable phone, a live census record, a CA address and
      // at least one truck. Without these they are mostly dissolved shells.
      if (STANDING.has(c.kind)) {
        if (!p.phone) { dropped['no phone'] = (dropped['no phone'] || 0) + 1; return null; }
        if ((cs.status_code || '') !== 'A') { dropped['census not active'] = (dropped['census not active'] || 0) + 1; return null; }
        if ((cs.phy_state || '').toUpperCase() !== STATE) { dropped['census not CA'] = (dropped['census not CA'] || 0) + 1; return null; }
        if (units < 1) { dropped['no power units'] = (dropped['no power units'] || 0) + 1; return null; }
      }
      let list = '', source = '', tags: string[] = [], note = '';
      if (c.kind === 'new') {
        const days = Math.round((today.getTime() - parse8(r.applied).getTime()) / 86400_000);
        list = LIST_NEW; source = 'FMCSA New Authority (CA)'; tags = ['new-authority', `new-authority-${TODAY}`];
        const need = amount(r.min_cov_amount) > 0 ? `needs ${money(r.min_cov_amount)} liability (BMC-91X) filed to activate` : 'liability filing required to activate (limit not yet set)';
        note = `NEW MC APPLICATION ${fmt8(r.applied)} (${days} days ago as of ${TODAY}): authority PENDING, no insurance on file - ${need}. ${r.op_auth_type || ''}. MC ${mc || 'n/a'}, USDOT ${r.usdot_number}, ${units || '?'} power units, ${drivers} drivers.`;
      } else if (c.kind === 'lapsed') {
        list = LIST_LAPSED; source = 'FMCSA BMC-35 (CA)'; tags = ['bmc35-lapsed', `bmc35-lapsed-${TODAY}`];
        const auth = r.op_auth_status === 'Inactive' ? 'INACTIVE (revoked/deactivated - needs insurance filed to reinstate)'
          : r.op_auth_status === 'Active' ? 'Active (revocation clock running)' : r.op_auth_status || 'unknown';
        note = `BMC-35 ${TODAY}: liability (BIPD) coverage CANCELLED effective ${fmt8(r.cancel)} by ${r.insurance_company_name || 'insurer not listed'}. FMCSA shows $0 liability on file - UNINSURED NOW. Authority: ${auth}. MC ${mc || 'n/a'}, USDOT ${r.usdot_number}, limit ${money(r.max_cov_amount) || '?'}, ${units || '?'} power units, ${drivers} drivers.`;
      } else if (c.kind === 'soon') {
        list = LIST_SOON; source = 'FMCSA BMC-35 (CA)'; tags = ['bmc35', `bmc35-${TODAY}`];
        note = `BMC-35 ${TODAY}: liability (BIPD) filing by ${r.insurance_company_name || 'insurer not listed'} ends ${fmt8(r.cancel)}; no new liability filing found (FMCSA shows ${money(r.bipd_file) || '$0'} on file until then). Authority: ${r.op_auth_status || 'unknown'}. MC ${mc || 'n/a'}, USDOT ${r.usdot_number}, limit ${money(r.max_cov_amount) || '?'}, ${units || '?'} power units, ${drivers} drivers.`;
      } else if (c.kind === 'uninsured' || c.kind === 'revoked') {
        list = LIST_UNINSURED; source = 'FMCSA Uninsured (CA)';
        const hist = history.get(r.usdot_number) || [];
        const last = hist.reduce((a, b) => ((a?.cancl_effective_date || '') > (b.cancl_effective_date || '') ? a : b), null as Row | null);
        const since = last?.cancl_effective_date ? `Last liability policy cancelled ${fmt8(last.cancl_effective_date)}${last.insurance_company_name ? ' by ' + last.insurance_company_name : ''} (${Math.round((today.getTime() - parse8(last.cancl_effective_date).getTime()) / 86400_000)} days ago).` : 'No liability policy has ever been recorded for this carrier.';
        if (c.kind === 'revoked') {
          tags = ['uninsured-now', 'revoked-needs-filing', `uninsured-${TODAY}`];
          note = `AUTHORITY SUSPENDED FOR WANT OF INSURANCE (FMCSA reason: "${(r.inactive_reason || '').trim()}", ${fmt8(r.inactive_date || '')}). Filing ${money(r.kind_need)} liability (BMC-91X) is what puts them back on the road. ${since} MC ${mc || 'n/a'}, USDOT ${r.usdot_number}, ${units || '?'} power units, ${drivers} drivers.`;
        } else {
          tags = ['uninsured-now', 'active-no-filing', `uninsured-${TODAY}`];
          note = `AUTHORITY ACTIVE WITH NO LIABILITY ON FILE as of ${TODAY}: FMCSA shows $0 liability (BIPD) while this authority requires ${money(r.kind_need)} - non-compliant right now and facing revocation. ${since} MC ${mc || 'n/a'}, USDOT ${r.usdot_number}, ${units || '?'} power units, ${drivers} drivers.`;
        }
      } else {
        const filed = amount(r.bipd_file), need = amount(r.min_cov_amount);
        // a filing in the active table that already meets the minimum means the gap is cured
        const best = Math.max(...(active.get(r.usdot_number) || []).map((f) => amount(f.max_cov_amount)), 0);
        if (best >= need) { dropped['underinsured already cured'] = (dropped['underinsured already cured'] || 0) + 1; return null; }
        list = LIST_UNDER; source = 'FMCSA Underinsured (CA)';
        tags = ['underinsured', filed <= 300000 ? 'underinsured-severe' : 'underinsured-standard', `underinsured-${TODAY}`];
        note = `UNDERINSURED ON FILE WITH FMCSA as of ${TODAY}: liability filed at ${money(r.bipd_file)} but this authority requires ${money(r.min_cov_amount)} - a ${money(String(need - filed))} shortfall, which is grounds for suspension. ${r.op_auth_type || ''}, authority ${r.op_auth_status || '?'}. MC ${mc || 'n/a'}, USDOT ${r.usdot_number}, ${units || '?'} power units, ${drivers} drivers.`;
      }
      return {
        org_id: ORG, company_name: (r.legal_name || cs.legal_name || '').trim() || `USDOT ${r.usdot_number}`,
        dba_name: (cs.dba_name || '').trim() || null,
        contact_name: owners[0] || null, contact_name_2: owners[1] || null,
        phone: p.phone || null, cell_phone: p.cell || null, email: (cs.email_address || '').trim().toLowerCase() || null,
        city: (r.bus_city || cs.phy_city || '').trim() || null, state: STATE, zip: (r.bus_zip_code || cs.phy_zip || '').slice(0, 5) || null,
        dot_number: r.usdot_number, power_units: units, trucks: units, segment: segment(units), stage: 'prospect',
        source, call_list: list, assigned_to: REP, lead_score: 0, notes: note, tags, preferred_contact: 'phone',
      };
    }).filter((r) => r !== null) as Record<string, unknown>[];
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.call_list as string] = (counts[r.call_list as string] || 0) + 1;
    summary.inserted = counts;
    if (Object.keys(dropped).length) summary.dropped_quality_gate = dropped;
    if (!dryRun) {
      for (const part of chunk(rows, 200)) {
        const { error } = await admin.from('crm_leads').insert(part);
        if (error) throw new Error('insert: ' + error.message);
      }
    }

    // ---- 8. Hygiene: move leads FMCSA now shows as insured / granted / replaced / cured
    const moves: { id: number; from: string; to: string; note: string }[] = [];
    const lists = [LIST_NEW, LIST_LAPSED, LIST_SOON, LIST_UNINSURED, LIST_UNDER];
    const stillPending = new Set(pendingDots);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('crm_leads').select('id,dot_number,call_list,stage')
        .eq('org_id', ORG).in('call_list', lists).in('stage', ['prospect', 'lead']).range(from, from + 999);
      if (error) throw new Error('hygiene read: ' + error.message);
      for (const l of data || []) {
        const c = l.dot_number ? carriers.get(l.dot_number) : undefined;
        if (!c) continue;
        const onFile = amount(c.bipd_file);
        if (l.call_list === LIST_NEW) {
          if (onFile > 0 || c.op_auth_status !== 'Pending') {
            const why = onFile > 0 ? `liability now on file (${money(c.bipd_file)}) - insured elsewhere` : `application no longer pending (${c.op_auth_status})`;
            moves.push({ id: l.id, from: l.call_list, to: LIST_NEW_CLOSED, note: `FMCSA ${TODAY}: ${why}; authority ${c.op_auth_status}.` });
          }
        } else if (l.call_list === LIST_LAPSED) {
          if (onFile > 0) moves.push({ id: l.id, from: l.call_list, to: LIST_REPLACED, note: `FMCSA ${TODAY}: liability back on file (${money(c.bipd_file)}) - insured elsewhere; authority ${c.op_auth_status}.` });
        } else if (l.call_list === LIST_UNINSURED) {
          // the whole premise of this list is $0 on file; the moment that changes they are someone else's
          // client. Check every docket, not just the first - that is how the pool was defined.
          const anyFiled = Math.max(...(authRows.get(l.dot_number!) || []).map((r) => amount(r.bipd_file)), 0);
          if (anyFiled > 0) moves.push({ id: l.id, from: l.call_list, to: LIST_UNINSURED_CLOSED, note: `FMCSA ${TODAY}: liability now on file (${money(String(anyFiled))}) - insured elsewhere; authority ${c.op_auth_status}.` });
        } else if (l.call_list === LIST_UNDER) {
          const authAll = authRows.get(l.dot_number!) || [];
          const short = authAll.some((r) => { const f = amount(r.bipd_file), m = amount(r.min_cov_amount); return f > 0 && f < m; });
          if (!short) moves.push({ id: l.id, from: l.call_list, to: LIST_UNDER_CLOSED, note: `FMCSA ${TODAY}: the filing shortfall is gone (now ${money(c.bipd_file)} on file against ${money(c.min_cov_amount)} required).` });
        } else if (l.call_list === LIST_SOON) {
          const rep = replacedInfo.get(l.dot_number!);
          if (rep) moves.push({ id: l.id, from: l.call_list, to: LIST_REPLACED, note: `FMCSA ${TODAY}: ALREADY REPLACED - new liability filing by ${rep.insurance_company_name || 'unknown insurer'} effective ${fmt8(rep.effective_date)}.` });
          else if (onFile === 0) moves.push({ id: l.id, from: l.call_list, to: LIST_LAPSED, note: `FMCSA ${TODAY}: the cancellation took effect and $0 liability is on file - UNINSURED NOW; authority ${c.op_auth_status}.` });
          else if (!stillPending.has(l.dot_number!)) moves.push({ id: l.id, from: l.call_list, to: LIST_REPLACED, note: `FMCSA ${TODAY}: cancel date passed and FMCSA still shows ${money(c.bipd_file)} on file - likely renewed; authority ${c.op_auth_status}.` });
        }
      }
      if (!data || data.length < 1000) break;
    }
    summary.moved = moves.reduce((acc: Record<string, number>, m) => { const k = `${m.from} -> ${m.to}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    if (!dryRun) {
      for (const m of moves) {
        const { data: cur } = await admin.from('crm_leads').select('notes').eq('id', m.id).single();
        const { error } = await admin.from('crm_leads').update({
          call_list: m.to, notes: m.note + '\n' + (cur?.notes || ''), updated_at: new Date().toISOString(),
        }).eq('id', m.id).eq('call_list', m.from);
        if (error) throw new Error('hygiene update: ' + error.message);
      }
    }

    summary.seconds = Math.round((Date.now() - started) / 1000);
    await admin.from('fmcsa_daily_runs').insert({ params: body, summary, error: null });
    return json({ ok: true, ...summary });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    summary.seconds = Math.round((Date.now() - started) / 1000);
    await admin.from('fmcsa_daily_runs').insert({ params: body, summary, error: msg });
    return json({ ok: false, error: msg, ...summary }, 500);
  }
});
