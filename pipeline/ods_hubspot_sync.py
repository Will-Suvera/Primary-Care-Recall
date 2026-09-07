"""Keep HubSpot GP Practice / PCN companies aligned with NHS ODS (epraccur + ePCN core partners).

Runs weekly from .github/workflows/ods-hubspot-sync.yml. Policy agreed with Will 2026-09-07:
  * ODS is the source of truth: official names overwrite HubSpot names; ODS codes, PCN, ICB, status are corrected.
  * Active ODS GP practices missing from HubSpot are created and linked to their PCN and ICB.
  * Closed/dormant practices and PCNs no longer in ePCN are marked Inactive (never deleted).
  * Anything needing judgement (two records sharing a code, uncoded HubSpot records with no ODS match,
    ODS codes already held by another record) is NOT changed; it is written to ods_sync_review.json (artifact).
Usage: python pipeline/ods_hubspot_sync.py [--plan-only]   (HUBSPOT_API_TOKEN from env or .env)
"""
import csv, io, json, os, re, sys, time, collections, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'pipeline', '.ods_sync')
os.makedirs(OUT, exist_ok=True)
PLAN_ONLY = '--plan-only' in sys.argv
UA = {'User-Agent': 'Mozilla/5.0 (Suvera ODS sync)'}
EPRACCUR = 'https://www.odsdatasearchandexport.nhs.uk/api/getReport?report=epraccur'
EPCN = 'https://www.odsdatasearchandexport.nhs.uk/api/getReport?report=epcncorepartnerdetails'
TYPE = {'ICB': 2, 'PCN': 5}          # HubSpot user-defined association labels (company -> ICB / PCN), plus 450 unlabelled
UNIQUE = ('ods_unique', 'practice_code', 'pcn_unique')

def token():
    t = os.environ.get('HUBSPOT_API_TOKEN')
    if not t and os.path.exists(os.path.join(ROOT, '.env')):
        for line in open(os.path.join(ROOT, '.env')):
            if line.startswith('HUBSPOT_API_TOKEN'): t = line.split('=', 1)[1].strip().strip('"\'')
    if not t: sys.exit('HUBSPOT_API_TOKEN missing')
    return t
H = {'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json'}

def req(m, u, b=None, tries=6):
    for t in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request('https://api.hubapi.com' + u, data=json.dumps(b).encode() if b is not None else None, headers=H, method=m), timeout=90) as r:
                d = r.read(); return json.loads(d) if d else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:400]
            if e.code in (429, 500, 502, 503, 504): time.sleep(3 * (t + 1)); continue
            raise RuntimeError(f'{m} {u} -> {e.code}: {body}')
    raise RuntimeError('gave up ' + u)

def fetch_csv(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
        return list(csv.reader(io.StringIO(r.read().decode('utf-8', 'replace'))))

# ---------------- ODS ----------------
E = {}
for r in fetch_csv(EPRACCUR):
    if len(r) < 26 or r[25] != 'RO76' or not r[3]: continue        # RO76 = GP practice; col 4 = ICB (blank outside England)
    E[r[0]] = {'name': r[1].strip(), 'icb': r[3], 'addr': ', '.join(x for x in r[4:8] if x), 'city': r[7] or r[6], 'zip': r[9].strip(), 'status': r[12], 'sicbl': r[14]}
if len(E) < 6000: sys.exit(f'epraccur looks truncated ({len(E)} GP practices) - aborting')
PCNM, PCN = {}, {}
for r in fetch_csv(EPCN):
    if len(r) < 10 or not re.match(r'^U\d{5}$', r[4]) or r[9].strip(): continue   # current core members only
    PCNM[r[0]] = (r[4], r[5].strip()); PCN.setdefault(r[4], {'name': r[5].strip(), 'members': []})['members'].append(r[0])
if len(PCN) < 1000: sys.exit(f'ePCN looks truncated ({len(PCN)} PCNs) - aborting')
for v in PCN.values():
    ic = collections.Counter(E[m]['icb'] for m in v['members'] if m in E and E[m]['icb']); v['icb'] = ic.most_common(1)[0][0] if ic else ''

# ---------------- HubSpot ----------------
PROPS = 'name,organisation_type,practice_code,ods_unique,nhs_code_unique,pcn_code,pcn_name,pcn_unique,ics_code,sub_icb_loc_ods_code,company_status,zip,address,city,num_associated_contacts'
C = []; after = None
while True:
    d = req('GET', f'/crm/v3/objects/companies?limit=100&properties={PROPS}' + (f'&after={after}' if after else '')); C += d['results']
    after = (d.get('paging') or {}).get('next', {}).get('after')
    if not after: break
CI = {c['id']: c for c in C}
def g(c, k): return (c['properties'].get(k) or '').strip()
def pcode(c):
    for k in ('practice_code', 'ods_unique', 'nhs_code_unique'):
        v = g(c, k).upper()
        if re.match(r'^[A-Z]\d{5}$', v): return v
def ucode(c):
    for k in ('pcn_unique', 'pcn_code', 'ods_unique'):
        v = g(c, k).upper()
        if re.match(r'^U\d{5}$', v): return v
gp = [c for c in C if g(c, 'organisation_type') == 'GP Practice']
pcns = [c for c in C if g(c, 'organisation_type') == 'PCN']
icb_by_code = {}
for c in C:
    if g(c, 'organisation_type') == 'ICB' and g(c, 'ics_code') and g(c, 'company_status') != 'Inactive': icb_by_code.setdefault(g(c, 'ics_code').upper(), c['id'])
pcn_by_code = collections.defaultdict(list)
for c in pcns:
    k = ucode(c)
    if k: pcn_by_code[k].append(c['id'])
def ncontacts(i): return int(g(CI[i], 'num_associated_contacts') or 0)

changes, review = [], []
def ch(kind, obj, i, name, field, old, new, ev): changes.append({'kind': kind, 'object': obj, 'id': i, 'name': name, 'field': field, 'old': old, 'new': new, 'evidence': ev})

# practices: one HubSpot record per code (duplicates -> review, not merged automatically)
bycode = collections.defaultdict(list)
for c in gp:
    k = pcode(c)
    if k: bycode[k].append(c['id'])
for k, ids in list(bycode.items()):
    if len(ids) > 1: review.append({'id': ids, 'name': [g(CI[i], 'name') for i in ids], 'why': f'{len(ids)} practice companies share ODS code {k}; merge by hand (keep the one with more contacts)'}); bycode[k] = [max(ids, key=ncontacts)]
for c in gp:
    if not pcode(c): review.append({'id': c['id'], 'name': g(c, 'name'), 'why': f'GP Practice company with no ODS code (zip {g(c, "zip") or "-"}, {ncontacts(c["id"])} contacts)'})
want_link = {}
for code, ids in bycode.items():
    hid = ids[0]; c = CI[hid]; o = E.get(code)
    if not o: review.append({'id': hid, 'name': g(c, 'name'), 'why': f'code {code} is not an English GP practice (RO76) in epraccur'}); continue
    pcn = PCNM.get(code, ('', ''))
    want = {'name': o['name'], 'practice_code': code, 'ods_unique': code, 'pcn_code': pcn[0], 'pcn_name': pcn[1], 'ics_code': o['icb'], 'sub_icb_loc_ods_code': o['sicbl'], 'company_status': 'Active' if o['status'] == 'ACTIVE' else 'Inactive', 'zip': o['zip'], 'address': o['addr'], 'city': o['city']}
    for f, v in want.items():
        cur = g(c, f)
        if f in ('address', 'city') and cur: continue
        if cur != (v or ''): ch('company.update', 'GP Practice', hid, g(c, 'name'), f, cur, v, 'ODS')
    want_link[hid] = {}
    if pcn[0]:
        if pcn_by_code.get(pcn[0]): want_link[hid][pcn_by_code[pcn[0]][0]] = 'PCN'
        else: review.append({'id': hid, 'name': g(c, 'name'), 'why': f'ePCN member of {pcn[0]} {pcn[1]} but no HubSpot PCN company carries that code'})
    if o['icb']:
        if icb_by_code.get(o['icb']): want_link[hid][icb_by_code[o['icb']]] = 'ICB'
        else: review.append({'id': hid, 'name': g(c, 'name'), 'why': f'ICB {o["icb"]} has no HubSpot company'})
for code, o in E.items():
    if o['status'] != 'ACTIVE' or code in bycode: continue
    pcn = PCNM.get(code, ('', ''))
    ch('company.create', 'GP Practice', None, o['name'], '*', None, {'name': o['name'], 'organisation_type': 'GP Practice', 'practice_code': code, 'ods_unique': code, 'pcn_code': pcn[0], 'pcn_name': pcn[1], 'ics_code': o['icb'], 'sub_icb_loc_ods_code': o['sicbl'], 'company_status': 'Active', 'zip': o['zip'], 'address': o['addr'], 'city': o['city'], '_links': {**({pcn_by_code[pcn[0]][0]: 'PCN'} if pcn[0] and pcn_by_code.get(pcn[0]) else {}), **({icb_by_code[o['icb']]: 'ICB'} if icb_by_code.get(o['icb']) else {})}}, 'active ODS GP practice missing from HubSpot')
# PCNs
for code, v in PCN.items():
    ids = pcn_by_code.get(code, [])
    if not ids:
        ch('company.create', 'PCN', None, v['name'], '*', None, {'name': v['name'], 'organisation_type': 'PCN', 'pcn_unique': code, 'pcn_code': code, 'ods_unique': code, 'ics_code': v['icb'], 'company_status': 'Active', '_links': {icb_by_code[v['icb']]: 'ICB'} if icb_by_code.get(v['icb']) else {}}, 'ePCN network missing from HubSpot'); continue
    if len(ids) > 1: review.append({'id': ids, 'name': [g(CI[i], 'name') for i in ids], 'why': f'{len(ids)} PCN companies share {code}; merge by hand'})
    hid = max(ids, key=ncontacts); c = CI[hid]
    for f, val in {'name': v['name'], 'pcn_unique': code, 'pcn_code': code, 'ods_unique': code, 'ics_code': v['icb'], 'company_status': 'Active'}.items():
        if g(c, f) != val: ch('company.update', 'PCN', hid, g(c, 'name'), f, g(c, f), val, 'ePCN')
    want_link[hid] = {icb_by_code[v['icb']]: 'ICB'} if icb_by_code.get(v['icb']) else {}
for c in pcns:
    k = ucode(c)
    if k and k not in PCN and g(c, 'company_status') != 'Inactive': ch('company.update', 'PCN', c['id'], g(c, 'name'), 'company_status', g(c, 'company_status'), 'Inactive', 'PCN code no longer in ePCN')
    if not k: review.append({'id': c['id'], 'name': g(c, 'name'), 'why': 'PCN company with no U-code'})
# associations diff
ids = list(want_link); cur = {}
for i in range(0, len(ids), 100):
    r = req('POST', '/crm/v4/associations/companies/companies/batch/read', {'inputs': [{'id': x} for x in ids[i:i + 100]]})
    for x in r.get('results', []): cur[str(x['from']['id'])] = [str(t['toObjectId']) for t in x['to']]
    time.sleep(0.1)
for hid, want in want_link.items():
    have = cur.get(hid, [])
    for to in have:
        tt = g(CI[to], 'organisation_type') if to in CI else ''
        if tt in ('PCN', 'ICB') and to not in want: ch('assoc.remove', g(CI[hid], 'organisation_type'), hid, g(CI[hid], 'name'), tt, to, None, 'not the ODS ' + tt)
    for to, lab in want.items():
        if to not in have: ch('assoc.add', g(CI[hid], 'organisation_type'), hid, g(CI[hid], 'name'), lab, None, to, 'ODS ' + lab)
json.dump(changes, open(os.path.join(OUT, 'ods_sync_plan.json'), 'w'), indent=1); json.dump(review, open(os.path.join(OUT, 'ods_sync_review.json'), 'w'), indent=1)
summary = collections.Counter((x['kind'], x['object']) for x in changes)
print('PLAN', dict(summary), '| review items', len(review))
if PLAN_ONLY: sys.exit(0)
# ---------------- apply ----------------
LOG = open(os.path.join(OUT, 'ods_sync_log.jsonl'), 'a')
def log(**kw): kw['ts'] = time.strftime('%Y-%m-%dT%H:%M:%S'); LOG.write(json.dumps(kw) + '\n')
byid = collections.defaultdict(dict)
for x in changes:
    if x['kind'] == 'company.update': byid[str(x['id'])][x['field']] = x['new'] or ''
holders = {}
for prop in UNIQUE:
    vals = sorted({v for i in byid for f, v in byid[i].items() if f == prop and v})
    for i in range(0, len(vals), 100):
        sr = req('POST', '/crm/v3/objects/companies/search', {'filterGroups': [{'filters': [{'propertyName': prop, 'operator': 'IN', 'values': vals[i:i + 100]}]}], 'properties': [prop, 'name'], 'limit': 100})
        for r in sr.get('results', []): holders[(prop, r['properties'][prop])] = (r['id'], r['properties'].get('name'))
        time.sleep(0.1)
for i in list(byid):
    for f in list(byid[i]):
        h = holders.get((f, byid[i][f]))
        if h and str(h[0]) != i: review.append({'id': i, 'name': g(CI[i], 'name'), 'why': f'wanted {f}={byid[i][f]} but it is already on {h[1]} ({h[0]})'}); byid[i].pop(f)
    if not byid[i]: byid.pop(i)
ids = list(byid)
for i in range(0, len(ids), 100):
    chunk = ids[i:i + 100]
    r = req('POST', '/crm/v3/objects/companies/batch/update', {'inputs': [{'id': c, 'properties': byid[c]} for c in chunk]})
    if r.get('errors'): raise RuntimeError('update errors: ' + json.dumps(r['errors'])[:500])
    for c in chunk: log(kind='update', id=c, props=byid[c])
    time.sleep(0.15)
for x in [x for x in changes if x['kind'] == 'company.create']:
    p = {a: b for a, b in x['new'].items() if not a.startswith('_')}
    r = req('POST', '/crm/v3/objects/companies', {'properties': p}); nid = r['id']
    for tid, lab in x['new']['_links'].items():
        req('PUT', f'/crm/v4/objects/companies/{nid}/associations/companies/{tid}', [{'associationCategory': 'USER_DEFINED', 'associationTypeId': TYPE[lab]}, {'associationCategory': 'HUBSPOT_DEFINED', 'associationTypeId': 450}])
    log(kind='create', newid=nid, name=x['name'], props=p); time.sleep(0.2)
def batch(items, path):
    for i in range(0, len(items), 100):
        r = req('POST', path, {'inputs': items[i:i + 100]})
        if r.get('errors'): raise RuntimeError(path + ': ' + json.dumps(r['errors'])[:500])
        time.sleep(0.15)
batch([{'from': {'id': str(x['id'])}, 'to': [{'id': str(x['old'])}]} for x in changes if x['kind'] == 'assoc.remove'], '/crm/v4/associations/companies/companies/batch/archive')
batch([{'from': {'id': str(x['id'])}, 'to': {'id': str(x['new'])}, 'types': [{'associationCategory': 'USER_DEFINED', 'associationTypeId': TYPE[x['field']]}, {'associationCategory': 'HUBSPOT_DEFINED', 'associationTypeId': 450}]} for x in changes if x['kind'] == 'assoc.add'], '/crm/v4/associations/companies/companies/batch/create')
for x in changes:
    if x['kind'].startswith('assoc'): log(kind=x['kind'], id=x['id'], to=x['new'] or x['old'], label=x['field'])
json.dump(review, open(os.path.join(OUT, 'ods_sync_review.json'), 'w'), indent=1)
print('APPLIED', dict(summary), '| review items', len(review))
