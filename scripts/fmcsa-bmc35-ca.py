"""BMC-35 leads for California from FMCSA open data (Motus era) - v2, corrected 2026-09-14.

Sources (data.transportation.gov SODA, all refreshed daily ~10:40 UTC, no key needed):
  3uet-3z4i  Motus InsHist - All With History   cancelled / replaced policy filings (cancl_effective_date)
  c5y8-a4uz  Motus Insur - All With History     filings currently on file (effective_date, trans_date)
  inys-ebih  Motus Carrier - All With History   FMCSA's own bipd_file amount (0 = no liability on file) + authority status
  az4n-8mr2  Company Census File (MCS-150)      names, officers, phone, cell, email, fleet size, state

Lessons baked in:
  * InsHist holds ONLY cancelled/replaced policies, so a replacement can never be found there -
    look in the active table (c5y8-a4uz) instead.
  * Policy numbers are formatted differently between the two tables (S-LHMI2518-00 vs SLHMI251800):
    normalise to alphanumerics before deciding a row is "the cancelling policy itself".
  * TERM/REPL rows are mostly already-replaced; CANCEL rows are the real BMC-35 signal.
  * Most cancellation rows appear on/after their effective date, so the strongest daily lead is a
    carrier whose coverage lapsed in the last few days with bipd_file = 0.

Usage: python fmcsa-bmc35-ca.py out.csv [lookback_days=30] [lookahead_days=90]
"""
import csv, datetime, json, re, sys, time, urllib.parse, urllib.request

BASE = 'https://data.transportation.gov/resource/'
TODAY = datetime.date.today()
OUT = sys.argv[1] if len(sys.argv) > 1 else 'bmc35_ca.csv'
LOOKBACK = int(sys.argv[2]) if len(sys.argv) > 2 else 30
LOOKAHEAD = int(sys.argv[3]) if len(sys.argv) > 3 else 90

def ymd(d): return d.strftime('%Y%m%d')
def parse(s): return datetime.datetime.strptime(s, '%Y%m%d').date()
def norm(p): return re.sub(r'[^A-Z0-9]', '', (p or '').upper())

def soda(dataset, **params):
    rows, offset = [], 0
    params.setdefault('$limit', 50000)
    while True:
        params['$offset'] = offset
        url = BASE + dataset + '.json?' + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'aiis-lead-pull'}), timeout=180) as r:
                    batch = json.load(r); break
            except Exception:
                if attempt == 3: raise
                time.sleep(3 * (attempt + 1))
        rows += batch
        if len(batch) < params['$limit']: return rows
        offset += params['$limit']

def chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n): yield seq[i:i + n]

def in_list(vals): return ','.join("'" + v.replace("'", "''") + "'" for v in vals)

# 1. Every BIPD cancellation taking effect in the window (lapsed in the last LOOKBACK days, or pending).
lo, hi = ymd(TODAY - datetime.timedelta(days=LOOKBACK)), ymd(TODAY + datetime.timedelta(days=LOOKAHEAD))
canc = soda('3uet-3z4i', **{'$where': f"cancl_effective_date >= '{lo}' AND cancl_effective_date <= '{hi}' AND ins_type_code = '1'",
                            '$select': 'usdot_number,docket_number,policy_no,insurance_company_name,effective_date,cancl_effective_date,filing_status_reason,max_cov_amount'})
by_dot = {}
for r in canc:
    d = (r.get('usdot_number') or '').strip()
    if d and r.get('cancl_effective_date'): by_dot.setdefault(d, []).append(r)
print(f'BIPD cancellations {lo}..{hi} nationwide: {len(canc)} rows, {len(by_dot)} carriers')

# 2. Census = master registry; dot_number is numeric there (unquoted IN list). Keep California.
census = {}
for ch in chunks(sorted(by_dot), 150):
    ids = ','.join(d for d in ch if d.isdigit())
    if not ids: continue
    for r in soda('az4n-8mr2', **{'$where': f'dot_number in({ids})',
                                   '$select': 'dot_number,legal_name,dba_name,company_officer_1,company_officer_2,email_address,cell_phone,phone,power_units,total_drivers,phy_city,phy_state,phy_zip,docket1prefix,docket1'}):
        census.setdefault(str(r['dot_number']), r)
ca = sorted(d for d in by_dot if (census.get(d, {}).get('phy_state') or '').upper() == 'CA')
print(f'census found {len(census)}; California carriers: {len(ca)}')

# 3. What is on file now: active filings + FMCSA's own bipd_file amount / authority status.
active, carrier = {}, {}
for ch in chunks(ca, 100):
    inl = in_list(ch)
    for r in soda('c5y8-a4uz', **{'$where': f"usdot_number in({inl}) AND ins_type_code = '1'",
                                   '$select': 'usdot_number,policy_no,insurance_company_name,effective_date,trans_date,max_cov_amount'}):
        active.setdefault(r['usdot_number'], []).append(r)
    for r in soda('inys-ebih', **{'$where': f"usdot_number in({inl})",
                                   '$select': 'usdot_number,op_auth_status,bipd_file,min_cov_amount,docket_number'}):
        carrier.setdefault(r['usdot_number'], r)
print(f'active filings for {len(active)} carriers; carrier records for {len(carrier)}')

def fmt_date(s): return f'{s[:4]}-{s[4:6]}-{s[6:8]}' if s and len(s) == 8 else (s or '')
def phone(s):
    d = ''.join(ch for ch in (s or '') if ch.isdigit())
    if len(d) == 11 and d[0] == '1': d = d[1:]
    return f'({d[:3]}) {d[3:6]}-{d[6:]}' if len(d) == 10 else (s or '')
def money(s):
    try: return str(int(float(s)))
    except Exception: return ''

rows = []
for dot in ca:
    cs, cr = census.get(dot, {}), carrier.get(dot, {})
    cancels = sorted(by_dot[dot], key=lambda r: r['cancl_effective_date'])
    latest = cancels[-1]
    cdate = parse(latest['cancl_effective_date'])
    # rows in the active table that are the cancelling filing itself (same policy, same start +-3 days)
    def is_self(a):
        return any(norm(a.get('policy_no')) == norm(c.get('policy_no')) and c.get('effective_date') and a.get('effective_date')
                   and abs((parse(a['effective_date']) - parse(c['effective_date'])).days) <= 3 for c in cancels)
    others = [a for a in active.get(dot, []) if a.get('effective_date') and not is_self(a)]
    cover = [a for a in others if parse(a['effective_date']) <= max(cdate, TODAY)]
    later = [a for a in others if parse(a['effective_date']) > max(cdate, TODAY)]
    on_file = float(cr.get('bipd_file') or 0)
    if cover:
        rep = max(cover, key=lambda a: a['trans_date']); status = 'replaced'
    elif later:
        rep = min(later, key=lambda a: a['effective_date']); status = 'replacement starts later'
    else:
        rep = None
        if on_file == 0: status = 'uninsured now' if cdate <= TODAY else 'pending, nothing else on file'
        elif cdate <= TODAY: status = 'likely renewed (still on file)'
        else: status = 'pending, no replacement found'
    officers = [cs.get('company_officer_1', ''), cs.get('company_officer_2', '')]
    rows.append({
        'segment': 'lapsed' if cdate <= TODAY else 'pending',
        'status': status,
        'cancel_effective': cdate.isoformat(),
        'days_from_today': (cdate - TODAY).days,
        'fmcsa_bipd_on_file': money(cr.get('bipd_file')),
        'company': (cs.get('legal_name') or '').strip(),
        'dba': (cs.get('dba_name') or '').strip(),
        'owner': ' / '.join(o.strip() for o in officers if o and o.strip()),
        'email': (cs.get('email_address') or '').strip().lower(),
        'cell_phone': phone(cs.get('cell_phone')),
        'business_phone': phone(cs.get('phone')),
        'city': (cs.get('phy_city') or '').strip().title(),
        'zip': (cs.get('phy_zip') or '')[:5],
        'usdot': dot,
        'mc': (latest.get('docket_number') or cr.get('docket_number') or ((cs.get('docket1prefix') or '') + (cs.get('docket1') or ''))).strip(),
        'authority_status': cr.get('op_auth_status', ''),
        'power_units': cs.get('power_units', ''),
        'drivers': cs.get('total_drivers', ''),
        'cancelling_insurer': latest.get('insurance_company_name', ''),
        'reason': latest.get('filing_status_reason', ''),
        'bipd_limit': money(latest.get('max_cov_amount')),
        'replacement_insurer': rep.get('insurance_company_name', '') if rep else '',
        'replacement_effective': fmt_date(rep.get('effective_date')) if rep else '',
        'replacement_posted': fmt_date(rep.get('trans_date')) if rep else '',
    })

order = {'uninsured now': 0, 'pending, nothing else on file': 1, 'pending, no replacement found': 2, 'replacement starts later': 3, 'likely renewed (still on file)': 4, 'replaced': 5}
rows.sort(key=lambda r: (order[r['status']], r['cancel_effective']))
with open(OUT, 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

from collections import Counter
print()
for (seg, st), n in sorted(Counter((r['segment'], r['status']) for r in rows).items()): print(f'{n:5}  {seg:8} {st}')
hot = [r for r in rows if r['status'] == 'uninsured now']
print(f"\nuninsured now: {len(hot)} | with owner {sum(1 for r in hot if r['owner'])}, email {sum(1 for r in hot if r['email'])}, cell {sum(1 for r in hot if r['cell_phone'])}, any phone {sum(1 for r in hot if r['cell_phone'] or r['business_phone'])}")
print('wrote', OUT, len(rows), 'rows')
