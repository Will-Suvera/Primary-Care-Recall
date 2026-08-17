#!/usr/bin/env python3
"""Build funnel_board.json — data layer for the single vertical Funnel Movement board.

Joins:
  outputs/planner_deals.json   (fresh HubSpot deals: stage + hs_v2_date_entered_* + ehr + owner)
  attribution.json             (ODS, company_id, Notion practice_visit, source, icb, tier, pcn)
  public/data/recalls.json     (FY activation + per-practice monthly recalls)
  + live deal->company->ODS and future HubSpot meetings (graceful if scope missing)

Also reconstructs a WEEK-BY-WEEK funnel from the stage-entry timestamps (no stored history needed).
Output: apps/primary-care-tech-overview/public/data/funnel_board.json
"""
import json, os, re, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api-eu1.hubapi.com"
NOW = datetime.now(timezone.utc)

# Deals for signed, paying contracts are named "PAID - <practice> - Planner".
# Tolerant of spacing and of a hyphen/en-dash/em-dash/colon separator so a
# hand-typed rename in HubSpot still registers.
PAID_PREFIX_RE = re.compile(r"^\s*PAID\b[\s\-–—:]*", re.IGNORECASE)

def get_token():
    t = os.environ.get("HUBSPOT_API_TOKEN", "").strip()
    if t: return t
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith("HUBSPOT_API_TOKEN"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""
TOKEN = get_token()

def hs(method, endpoint, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + endpoint, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def parse(s):
    if not s: return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
    except Exception:
        return None

def days_between(a, b):
    return (b - a).total_seconds() / 86400.0 if a and b else None

# ---------- load sources ----------
planner = json.loads((ROOT / "outputs/planner_deals.json").read_text())
# attribution.json is best-effort — its generator (refresh_attribution.py) is
# continue-on-error in CI, and the file is no longer committed. Tolerate a
# missing/empty file so the board still builds (just without source/ICB/tier
# enrichment) instead of hard-crashing the deploy.
try:
    attr = json.loads((ROOT / "apps/primary-care-tech-overview/public/data/attribution.json").read_text())
except (FileNotFoundError, ValueError):
    print("  WARN: attribution.json missing/unreadable — building without attribution enrichment")
    attr = {}
recalls = json.loads((ROOT / "apps/tech-growth-map/public/data/recalls.json").read_text())

# ---------- onboarding checklist from the Google Sheet (read-only published CSV) ----------
# "DPA Signed Onboard Ready" is not one step — it's this implementation checklist.
# (column name in SaaS tab, set of values that count as DONE). Anything else non-empty = in-progress.
ONBOARD_STEPS = [
    ("EMIS Notified",              "emis_notified",        {"yes"}),
    ("IM1 User created",           "im1_user_created",     {"yes"}),
    ("Sharing agreement accepted", "sharing_agreement",    {"yes"}),
    ("Patient Data Sync",          "patient_data_sync",    {"yes"}),
    ("Practice on dashboard",      "practice_on_dashboard",{"yes"}),
    ("HeroHealth",                 "herohealth",           {"set up"}),
    ("Onboarding Call",            "onboarding_call",      {"held"}),
    ("Appt Config",                "appt_config",          {"uploaded"}),
    # Bloods automation (whitelisting) deliberately sits BEFORE the recall
    # session: the session is the finale, so anything still blocking it —
    # like whitelisting — should surface as the next action (Will, 2026-08-17).
    ("Bloods automation",          "bloods_automation",    {"done"}),
    ("Recall Session",             "recall_session",       {"held"}),
]
GSHEET_SAAS = ("https://docs.google.com/spreadsheets/d/e/2PACX-1vRa6zIwdwnNSfjjU_gVYdZ7Pm6Sy6"
               "XWsyVe0gR6AZP55IzeVW9qisAUb0Hvo4Nr7qdGhWLnK1l4SDnl/pub?output=csv&gid=0")

def load_onboarding_steps():
    """Returns (steps, notes, pending, ehr):
       steps:   ods -> [{step, state}] where state ∈ done|pending|todo
       notes:   ods -> free-text from the sheet's "Notes" column (read-only)
       pending: rows with a practice name but NO usable ODS — the ODS cell is
                hand-typed and has been wiped by sheet edits before (Fakenham,
                2026-08-11), so these are resolved later by name against
                HubSpot deals / the NHS directory rather than dropped.
       ehr:     ods -> the sheet's EHR column (fallback when the HubSpot deal
                has no ehr_type)."""
    import csv, io
    out, notes_out, pending, ehr_out = {}, {}, [], {}
    try:
        req = urllib.request.Request(GSHEET_SAAS, headers={"User-Agent": "SuveraReadOnly/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = list(csv.reader(io.StringIO(r.read().decode("utf-8-sig"))))
        hdr = rows[0]
        idx = {h.strip(): i for i, h in enumerate(hdr)}
        ods_i = idx.get("ODS Code", 6)
        notes_i = idx.get("Notes")
        name_i = idx.get("GP Practice", 0)
        status_i = idx.get("Status", 8)
        ehr_i = idx.get("EHR")
        for row in rows[1:]:
            ods = (row[ods_i].strip().upper() if len(row) > ods_i else "")
            name = (row[name_i].strip() if len(row) > name_i else "")
            if not ods and not name:
                continue
            steps = []
            for col, key, done_vals in ONBOARD_STEPS:
                v = (row[idx[col]].strip() if col in idx and idx[col] < len(row) else "")
                vl = v.lower()
                if vl in done_vals:
                    state = "done"
                elif vl.startswith("na") or vl.startswith("n/a"):
                    state = "na"          # explicitly not-applicable (e.g. "NA (S1)" for SystmOne)
                else:
                    state = "pending" if v else "todo"
                steps.append({"step": col, "key": key, "state": state, "value": v})
            note = (row[notes_i].strip() if notes_i is not None and notes_i < len(row) else "")
            ehr = (row[ehr_i].strip() if ehr_i is not None and ehr_i < len(row) else "")
            if ods:
                out[ods] = steps
                if note:
                    notes_out[ods] = note
                if ehr:
                    ehr_out[ods] = ehr
            else:
                status = (row[status_i].strip() if len(row) > status_i else "")
                pending.append({"name": name, "status": status, "steps": steps,
                                "note": note, "ehr": ehr})
        print(f"  onboarding checklist: {len(out)} practices from sheet ({len(notes_out)} with notes, "
              f"{len(pending)} rows without ODS held for name-matching)")
    except Exception as e:
        print(f"  WARN: could not load onboarding sheet ({e})")
    return out, notes_out, pending, ehr_out

onboarding_by_ods, onboarding_notes_by_ods, onboarding_pending, sheet_ehr_by_ods = load_onboarding_steps()

# Stage IDs + keys are STABLE; labels are live from HubSpot (carried for display only).
# All logic keys off `key`, never the label — so a HubSpot rename flows through cleanly.
STAGES = [(s["id"], s.get("key") or s["label"], s["label"]) for s in planner["stage_order"]]
DROP_ID = planner["dropped_stage"]["id"]
ID2KEY = {sid: key for sid, key, _ in STAGES}
KEY2LABEL = {key: lab for _, key, lab in STAGES}
KEY2ID = {key: sid for sid, key, _ in STAGES}
DPA_SIGNED_ID = KEY2ID.get("dpa_signed")  # for "days since DPA signed" (independent of current stage)
KEYS = [key for _, key, _ in STAGES]
STAGE_IDS = [sid for sid, _, _ in STAGES]

# "Activated" = meaningfully recalling this FY. A handful of practices have
# 1-4 FY recalls — one-off test recalls fired during setup (some aren't even
# live yet); counting them as "recalling" overstated the cohort. The observed
# distribution has a clean break: 1,1,1,1,2,2,3,4 then 8,14,17,22...
MIN_ACTIVE_RECALLS = 5
_rec = recalls.get("recalls", {}) if isinstance(recalls.get("recalls"), dict) else {}
_fy = _rec.get("fy_by_practice", {}) or {}
_fy_count = lambda v: (v.get("fy_to_date", 0) if isinstance(v, dict) else v) or 0
recalling_ods = set(k.upper() for k, v in _fy.items() if _fy_count(v) >= MIN_ACTIVE_RECALLS)
# recently-active set still respects the FY threshold (it exists to catch
# practices recalling right now, not to re-admit test blips)
recalling_ods |= set(x.upper() for x in recalls.get("active_ods_recent", [])
                     if _fy_count(_fy.get(x.upper()) or _fy.get(x.lower()) or _fy.get(x, 0)) >= MIN_ACTIVE_RECALLS)
recalls_by_ods_month = _rec.get("by_ods_month", {}) or {}
_bl = recalls.get("bloods", {}) if isinstance(recalls.get("bloods"), dict) else {}
# bloods has no plain by_ods_month — derive per-month totals from the clinician
# breakdown ({ods: {month: {clinician: n, _total: N}}}) so we can chart bloods/month too.
_bl_clin = _bl.get("by_ods_month_clinician", {}) or {}
bloods_by_ods_month = {
    ods.upper(): {m: (v.get("_total", 0) if isinstance(v, dict) else v) for m, v in (months or {}).items()}
    for ods, months in _bl_clin.items()
}
# Per-week series (Monday-of-week) — present but only surfaced when weekly_available.
recalls_by_ods_week = {k.upper(): v for k, v in (_rec.get("by_ods_week", {}) or {}).items()}
bloods_by_ods_week = {k.upper(): v for k, v in (_bl.get("by_ods_week", {}) or {}).items()}
WEEKLY_AVAILABLE = bool(recalls.get("weekly_available", False))
fy_recalls_by_ods = {k.upper(): (v.get("fy_to_date", 0) if isinstance(v, dict) else v) for k, v in _fy.items()}
fy_bloods_by_ods = {k.upper(): (v.get("fy_to_date", 0) if isinstance(v, dict) else v)
                    for k, v in (_bl.get("fy_by_practice", {}) or {}).items()}
recalls_tm_by_ods = {k.upper(): (v.get("this_month", 0) if isinstance(v, dict) else 0) for k, v in _fy.items()}
bloods_tm_by_ods = {k.upper(): (v.get("this_month", 0) if isinstance(v, dict) else 0)
                    for k, v in (_bl.get("fy_by_practice", {}) or {}).items()}
CUR_MONTH = NOW.strftime("%Y-%m")
_fy_start_year = NOW.year if NOW.month >= 4 else NOW.year - 1   # UK FY starts 1 April
_FY_START = f"{_fy_start_year}-04"

def metric_stats(by_month, fy_map, ods):
    """FY-to-date total + average per active month since April for a metric."""
    if not ods:
        return 0, 0
    bom = {m: c for m, c in (by_month.get(ods, {}) or {}).items() if m >= _FY_START}
    total = sum(bom.values()) or fy_map.get(ods, 0)
    n = len([1 for c in bom.values() if c > 0])
    return total, (round(total / n) if n else 0)

def pct_of_list(x, patients):
    return round(x / patients * 100, 1) if patients and x else None

# maps from attribution.json
dealname2ods, companyid2ods, ods2p = {}, {}, {}
for p in attr.get("practices", []):
    ods = (p.get("ods") or "").upper()
    if not ods: continue
    ods2p[ods] = p
    if p.get("company_id"): companyid2ods[str(p["company_id"])] = ods
    for d in p.get("deals", []):
        if d.get("dealname"):
            dealname2ods[d["dealname"].strip().lower()] = ods

# ---------- authoritative deal -> company -> ODS join ----------
deal_id2ods = {}
try:
    deal_ids = [str(d["_id"]) for d in planner["deals"] if d.get("_id")]
    deal2company = {}
    for i in range(0, len(deal_ids), 100):
        assoc = hs("POST", "/crm/v4/associations/deals/companies/batch/read",
                   {"inputs": [{"id": x} for x in deal_ids[i:i+100]]})
        for r in assoc.get("results", []):
            tos = r.get("to", [])
            if tos: deal2company[str(r["from"]["id"])] = str(tos[0]["toObjectId"])
    comp_ids = list(set(deal2company.values()))
    comp2ods = {}
    for i in range(0, len(comp_ids), 100):
        cr = hs("POST", "/crm/v3/objects/companies/batch/read",
                {"properties": ["ods_unique", "practice_code"],
                 "inputs": [{"id": x} for x in comp_ids[i:i+100]]})
        for r in cr.get("results", []):
            pr = r.get("properties", {})
            ods = (pr.get("ods_unique") or pr.get("practice_code") or "").strip().upper()
            if ods: comp2ods[str(r["id"])] = ods
    for did, cid in deal2company.items():
        if cid in comp2ods: deal_id2ods[did] = comp2ods[cid]
    print(f"  deal->company->ODS resolved for {len(deal_id2ods)}/{len(deal_ids)} deals")
except Exception as e:
    print(f"  WARN: deal->company->ODS join failed ({e}); using dealname match only")

# ---------- future HubSpot meetings (next-step signal) ----------
# Classify a HubSpot meeting from its title (Will's rule, 2026-06-27):
#  - "onboarding" → the Calendly Planner-Onboarding booking ("… Planner Onboarding …").
#  - "meeting"    → everything else.
# Recall / implementation sessions are NOT inferred from meeting titles — they
# come exclusively from the Notion "Recalling lunches log" (practice_visits.json).
def meeting_kind(title):
    if "planner onboarding" in (title or "").lower(): return "onboarding"
    return "meeting"

# Bucket for the detail-page session lists (distinct from the calendar): an
# onboarding call, a recall-session meeting (shown via Notion, so excluded from
# "other"), or any other meeting (listed under "Other meetings").
def session_bucket(title):
    t = (title or "").lower()
    if "planner onboarding" in t: return "onboarding"
    if "recall" in t: return "recall"
    return "other"

def _earliest_meeting(store, key, iso, title):
    """Keep the soonest future meeting per ods/deal, carrying its title + kind."""
    cur = store.get(key)
    if cur is None or iso < cur["date"]:
        store[key] = {"date": iso, "title": title or None, "kind": meeting_kind(title)}

future_meetings, future_meetings_by_deal, owners, owner_emails, hs_ok = {}, {}, {}, {}, True
# Onboarding-call sessions (past + future) per ods/deal — a practice can have more
# than one. Drives the detail page's "Onboarding sessions" list (Will, 2026-06-27).
onb_sessions_by_ods, onb_sessions_by_deal = {}, {}
other_meetings_by_ods, other_meetings_by_deal = {}, {}   # non-onboarding, non-recall meetings (listed on the detail page)
try:
    now_iso = NOW.isoformat()
    # Pull recent past + all future meetings so past onboarding calls are captured.
    past_ms = str(int((NOW - timedelta(days=400)).timestamp() * 1000))
    after, mids = None, {}
    while True:
        body = {"filterGroups": [{"filters": [
                    {"propertyName": "hs_meeting_start_time", "operator": "GTE", "value": past_ms}]}],
                "properties": ["hs_meeting_start_time", "hs_meeting_title"], "limit": 100}
        if after: body["after"] = after
        resp = hs("POST", "/crm/v3/objects/meetings/search", body)
        for m in resp.get("results", []):
            mids[m["id"]] = {"ts": m["properties"].get("hs_meeting_start_time"),
                             "title": m["properties"].get("hs_meeting_title") or ""}
        after = resp.get("paging", {}).get("next", {}).get("after")
        if not after: break
    ids = list(mids.keys())

    def _record(meta, iso, ods=None, did=None):
        # the soonest FUTURE meeting drives next_step; onboarding calls (past +
        # future) are collected into a list for the detail page.
        if iso >= now_iso:
            if ods is not None: _earliest_meeting(future_meetings, ods, iso, meta.get("title"))
            if did is not None: _earliest_meeting(future_meetings_by_deal, did, iso, meta.get("title"))
        key = ods if ods is not None else did
        b = session_bucket(meta.get("title"))
        if b == "onboarding":
            (onb_sessions_by_ods if ods is not None else onb_sessions_by_deal).setdefault(key, []).append(iso)
        elif b == "other":
            (other_meetings_by_ods if ods is not None else other_meetings_by_deal).setdefault(key, []).append(iso)

    for i in range(0, len(ids), 100):
        assoc = hs("POST", "/crm/v4/associations/meetings/companies/batch/read",
                   {"inputs": [{"id": x} for x in ids[i:i+100]]})
        for r in assoc.get("results", []):
            meta = mids.get(str(r.get("from", {}).get("id"))) or {}
            pdt = parse(meta.get("ts"))
            if not pdt:
                continue
            iso = pdt.isoformat()
            for to in r.get("to", []):
                ods = companyid2ods.get(str(to.get("toObjectId")))
                if ods:
                    _record(meta, iso, ods=ods)
    # also key meetings by DEAL — catches deals whose company has no ODS code
    for i in range(0, len(ids), 100):
        assoc = hs("POST", "/crm/v4/associations/meetings/deals/batch/read",
                   {"inputs": [{"id": x} for x in ids[i:i+100]]})
        for r in assoc.get("results", []):
            meta = mids.get(str(r.get("from", {}).get("id"))) or {}
            pdt = parse(meta.get("ts"))
            if not pdt:
                continue
            iso = pdt.isoformat()
            for to in r.get("to", []):
                _record(meta, iso, did=str(to.get("toObjectId")))
    for store in (onb_sessions_by_ods, onb_sessions_by_deal, other_meetings_by_ods, other_meetings_by_deal):
        for k in list(store):
            store[k] = sorted(set(store[k]))
    print(f"  meetings: {len(future_meetings)} future ods · onboarding sessions for "
          f"{len(onb_sessions_by_ods)} ods / {len(onb_sessions_by_deal)} deals")
except Exception as e:
    hs_ok = False
    print(f"  WARN: could not pull meetings ({e})")
try:
    for o in hs("GET", "/crm/v3/owners?limit=200").get("results", []):
        owners[str(o["id"])] = f"{o.get('firstName','')} {o.get('lastName','')}".strip()
        if o.get("email"):
            owner_emails[str(o["id"])] = o["email"]  # owner's login email, for "last chased by"
except Exception as e:
    print(f"  WARN: could not pull owners ({e})")

# ---------- last email per deal (needs `sales-email-read` scope on the Private App) ----------
# Graceful: if the token lacks the scope (403), we fall back to the sidecar
# outputs/deal_last_email.json (populated via the connected HubSpot app) so the
# feature still shows. Add `sales-email-read` to the Private App for daily auto-pull.
last_email = {}    # deal_id(str) -> {subject, date, direction}  (most recent; drives days_since_email)
last_emails = {}   # deal_id(str) -> [ up to 8 most-recent {subject, ts, direction, by} ]
DIR_LABEL = {"EMAIL": "sent", "INCOMING_EMAIL": "received", "FORWARDED_EMAIL": "fwd"}
def pull_last_emails():
    deal_ids = [str(d["_id"]) for d in planner["deals"] if d.get("_id")]
    d2e = {}
    for i in range(0, len(deal_ids), 100):
        a = hs("POST", "/crm/v4/associations/deals/emails/batch/read",
               {"inputs": [{"id": x} for x in deal_ids[i:i+100]]})
        for r in a.get("results", []):
            d2e[str(r["from"]["id"])] = [str(t["toObjectId"]) for t in r.get("to", [])]
    all_emails = sorted({e for v in d2e.values() for e in v})
    eprops = {}
    for i in range(0, len(all_emails), 100):
        er = hs("POST", "/crm/v3/objects/emails/batch/read",
                {"properties": ["hs_timestamp", "hs_email_subject", "hs_email_direction", "hubspot_owner_id", "hs_email_text"],
                 "inputs": [{"id": x} for x in all_emails[i:i+100]]})
        for e in er.get("results", []):
            eprops[str(e["id"])] = e.get("properties", {})
    for did, eids in d2e.items():
        items = []
        for eid in eids:
            p = eprops.get(eid)
            if not p or not p.get("hs_timestamp"):
                continue
            _body = " ".join((p.get("hs_email_text") or "").split())  # collapse whitespace
            items.append({"subject": p.get("hs_email_subject") or "(no subject)",
                          "ts": p["hs_timestamp"],
                          "direction": DIR_LABEL.get(p.get("hs_email_direction"), "email"),
                          "by": owners.get(str(p.get("hubspot_owner_id"))) or None,
                          "body": _body[:800] or None})
        if not items:
            continue
        items.sort(key=lambda x: x["ts"], reverse=True)
        last_emails[did] = items[:8]   # recent emails from any person on this deal (UI shows what's available)
        b = items[0]
        last_email[did] = {"subject": b["subject"], "date": b["ts"], "direction": b["direction"]}
try:
    pull_last_emails()
    print(f"  last email pulled for {len(last_email)} deals (via token)")
except Exception as e:
    print(f"  WARN: last-email via token failed ({getattr(e,'code',e)}) — add `sales-email-read` scope; trying sidecar")
sidecar = ROOT / "outputs/deal_last_email.json"
if sidecar.exists():
    try:
        sc = json.loads(sidecar.read_text())
        for did, v in sc.items():
            if did.startswith("_"):
                continue
            last_email.setdefault(str(did), v)   # token wins; sidecar fills gaps
        print(f"  last email sidecar merged ({len(sc)} deals) -> total {len(last_email)}")
    except Exception as e:
        print(f"  WARN: bad sidecar ({e})")

# ---------- stale thresholds ----------
# keyed by stable stage key (not label)
STALE = {"waitlist": 30, "demo_booked": 10, "demo_held": 14, "dpa_sent": 10, "dpa_signed": 21, "live": 21}

def why(key, days_in, recalling, fy_total=0, avg=0, pct=None, bl_total=0, bl_pct=None):
    d = f"{days_in:.0f}d" if days_in is not None else "?"
    if key == "live":
        if fy_total > 0 or bl_total > 0:
            r = f"{fy_total:,} recalls" + (f" ({pct}%)" if pct is not None else "")
            b = f"{bl_total:,} bloods" + (f" ({bl_pct}%)" if bl_pct is not None else "")
            return f"{r} · {b}"
        return f"0 recalls this FY · live {d}"
    return {
        "waitlist":    f"On signed-up list {d}, no demo booked",
        "demo_booked": "Demo booked, awaiting the call",
        "demo_held":   f"Demo held {d} ago, no proposal sent",
        "dpa_sent":    f"Proposal sent {d} ago, not signed",
        "dpa_signed":  f"DPA signed {d} ago, no go-live booked",
    }.get(key, f"In {KEY2LABEL.get(key, key)} {d}")

# ---------- practice visits (Notion) — read the normalised file DIRECTLY ----------
# Gives the full per-practice visit history (completed + confirmed + proposed),
# fresh from `ingest_practice_visits.py`, without a heavy attribution rebuild.
# Shape: {ods: {status, date, history:[{date,status,problems,...}], ...}}
try:
    _pv = json.loads((ROOT / "apps/primary-care-tech-overview/public/data/practice_visits.json").read_text())
    pv_by_ods = {k.upper(): v for k, v in _pv.items()}
except Exception:
    pv_by_ods = {}
TODAY = NOW.date().isoformat()

def _visit_list(ods):
    """All dated visits for an ODS, oldest→newest: [{date, status, problems, times, attendees}]."""
    v = pv_by_ods.get(ods) if ods else None
    if not v:
        return []
    hist = v.get("history") or [v]
    out, seen = [], set()
    for h in hist:
        d = (h.get("date") or "")[:10] or None
        sig = (d, h.get("status"))
        if sig in seen:                 # dedup same-date/same-status (name-variant dupes)
            continue
        seen.add(sig)
        out.append({"date": d, "status": h.get("status"), "problems": h.get("problems") or None,
                    "times": h.get("times"), "attendees": h.get("attendees") or []})
    return sorted(out, key=lambda x: x["date"] or "")

# next_step = the next BOOKED touchpoint: a future *Confirmed* Notion visit, else a
# future HubSpot meeting. (Proposed/To-Contact visits are surfaced separately via the
# visits list — they are NOT a firm booking, so they don't clear the "stale" flag.)
def _meeting_step(m):
    return {"type": "Meeting", "date": m["date"], "source": "HubSpot",
            "meeting_kind": m.get("kind", "meeting"), "title": m.get("title")}

def next_step_for(ods, key=None, deal_id=None):
    if ods:
        conf = [v for v in _visit_list(ods) if v["date"] and v["date"] >= TODAY and v["status"] == "scheduled"]
        if conf:
            return {"type": "Visit", "date": conf[0]["date"], "source": "Notion"}
        if ods in future_meetings:
            return _meeting_step(future_meetings[ods])
    if deal_id and str(deal_id) in future_meetings_by_deal:
        return _meeting_step(future_meetings_by_deal[str(deal_id)])
    return {"type": "Demo", "date": None} if key == "demo_booked" else None

def visit_info(ods):
    """Headline visit for the detail: most recent past visit, else the soonest upcoming."""
    visits = _visit_list(ods)
    if not visits:
        return None
    past = [v for v in visits if v["date"] and v["date"] <= TODAY]
    chosen = past[-1] if past else visits[0]
    return {"date": chosen["date"], "status": chosen["status"], "problems": chosen["problems"]}

# The onboarding sheet is the operational source of truth for "live" — HubSpot
# deal stages lag behind it (e.g. a practice marked Live + recalling while its
# deal still sits in dpa_signed). Loaded here so per-deal rows can be promoted.
def _live_sheet(fn):
    try:
        return set(x.upper() for x in json.loads((ROOT / "apps/tech-growth-map/public/data" / fn).read_text()))
    except Exception:
        return set()
SHEET_LIVE = _live_sheet("live_customers.json") | _live_sheet("live_customers_full_planner.json")

# Per-deal ODS pins where both automatic routes resolve wrongly:
#  - 443250439387 "Farnham Road Medical Group": its HubSpot company association
#    points at Holmwood Corner's company (H84042); the practice is K81075 (Slough).
#  - 496792727769 "Oakleaf Medical Practice": attribution joined it under
#    neighbouring Amaanah (Y01068); Oakleaf is Y02794 (Birmingham B8 3SW).
DEAL_ODS_OVERRIDES = {
    "443250439387": "K81075",
    "496792727769": "Y02794",
    # Great Barr Medical Centre: deal hangs off a duplicate HubSpot company with
    # no ODS; the coded twin "Great Barr Practice" (same B43 7HB postcode) is M88015.
    "496997502166": "M88015",
    # Arden House Medical Practice: company association points at Didsbury
    # Medical Centre (P84678); the practice is C81634 (New Mills, Derbyshire) —
    # confirmed by Will 2026-06-11 and matching the onboarding sheet.
    "475293008107": "C81634",
    # St Neots HC (OneMedical): the HubSpot company join resolves to L82050, which
    # actually belongs to the sister practice Rosedean House. St Neots is Y02769 —
    # confirmed by Will 2026-06-30 and matching the onboarding sheet.
    "500923670764": "Y02769",
    # Rosedean House (OneMedical): company join resolves to no ODS; it's L82050 —
    # the code St Neots was mistakenly borrowing (freed by the override above).
    # Confirmed by Will 2026-06-30, matches the onboarding sheet.
    "501204035828": "L82050",
}

# Last-ditch ODS fallback for deals with no company code and no attribution
# match: exact normalised-name match against the ODS directory, only when the
# name maps to exactly one practice (and never a BCSS pseudo-practice).
import re as _re
def _norm_name(s):
    return _re.sub(r"[^a-z0-9]+", "", (s or "").lower())
_geo_names = {}
_geo_by_ods = {}   # ODS -> full NHS-directory record (pcn_name, icb, patients, …)
try:
    for _gp in json.loads((ROOT / "apps/tech-growth-map/public/data/practices_geocoded.json").read_text()):
        if "bcss" in (_gp.get("name") or "").lower():
            continue
        _geo_names.setdefault(_norm_name(_gp["name"]), []).append(_gp["ods"].upper())
        _geo_by_ods[_gp["ods"].upper()] = _gp
except Exception:
    pass
def geo_name_fallback(dealname):
    cands = _geo_names.get(_norm_name(dealname.replace(" - Planner", "")))
    return cands[0] if cands and len(cands) == 1 else None

# ---------- failsafe: tracker rows whose ODS cell is blank ----------
# The sheet's ODS Code cell is the hub's join key and it's hand-typed — an
# edit wiped Fakenham's on 2026-08-11 and its checklist vanished. Rows held
# back by load_onboarding_steps() are resolved here by practice name:
# HubSpot deal names first (they carry a company-verified ODS), then a
# unique match in the NHS directory. Ambiguous names stay unresolved and are
# surfaced as a data warning rather than silently dropped.
_deal_norm2ods = {}
for _d in planner["deals"]:
    _nm = PAID_PREFIX_RE.sub("", (_d.get("dealname") or ""), count=1).replace(" - Planner", "").strip()
    _o = deal_id2ods.get(str(_d.get("_id"))) or dealname2ods.get((_d.get("dealname") or "").strip().lower())
    if _nm and _o:
        _deal_norm2ods.setdefault(_norm_name(_nm), set()).add(_o)

onb_fallback_matched, onb_fallback_actionable, onb_unresolved = [], [], []
for _row in onboarding_pending:
    _n = _norm_name(_row["name"])
    _ods, _how = None, None
    _cands = _deal_norm2ods.get(_n)
    if _cands and len(_cands) == 1:
        _ods, _how = next(iter(_cands)), "HubSpot deal"
    else:
        _g = _geo_names.get(_n)
        if _g and len(_g) == 1:
            _ods, _how = _g[0], "NHS directory"
    _active = (_row.get("status") or "").strip().lower() in ("live", "in progress")
    if _ods and _ods not in onboarding_by_ods:
        onboarding_by_ods[_ods] = _row["steps"]
        if _row.get("note"):
            onboarding_notes_by_ods[_ods] = _row["note"]
        if _row.get("ehr"):
            sheet_ehr_by_ods.setdefault(_ods, _row["ehr"])
        onb_fallback_matched.append(f"{_row['name']} -> {_ods} (via {_how})")
        if _active:
            onb_fallback_actionable.append(f"{_row['name']} -> {_ods}")
    elif not _ods and _active:
        onb_unresolved.append(_row["name"])
if onb_fallback_matched:
    print(f"  onboarding fallback: {len(onb_fallback_matched)} sheet row(s) without ODS matched by name: "
          + "; ".join(onb_fallback_matched))
if onb_unresolved:
    print(f"  WARN: {len(onb_unresolved)} In-Progress tracker row(s) have no ODS and no name match: "
          + ", ".join(onb_unresolved))

# Sheet EHR values are shorthand — normalise to the HubSpot ehr_type labels
# the dashboard's badges/logic key on.
_SHEET_EHR_MAP = {"s1": "SystmOne", "systmone": "SystmOne", "tpp": "SystmOne",
                  "emis": "EMIS", "medicus": "Medicus"}
def sheet_ehr(ods):
    v = (sheet_ehr_by_ods.get(ods) or "").strip()
    return _SHEET_EHR_MAP.get(v.lower(), v) if v else None

def to_amount(v):
    """Parse a HubSpot deal `amount` into a float, or None if blank/unparseable."""
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

# ---------- per-deal rows ----------
rows = []
skipped_blank = 0
promoted_live = []
for d in planner["deals"]:
    cur = d.get("dealstage")
    key = ID2KEY.get(cur)
    if cur == DROP_ID or key is None:
        continue
    label = KEY2LABEL.get(key, key)   # live display label
    entry = parse(d.get(f"hs_v2_date_entered_{cur}"))
    days_in = days_between(entry, NOW)
    # days since DPA signed — measured from when the deal entered the DPA-signed
    # stage, NOT the current stage (live practices passed through it earlier).
    _dpa = days_between(parse(d.get(f"hs_v2_date_entered_{DPA_SIGNED_ID}")) if DPA_SIGNED_ID else None, NOW)
    days_since_dpa = round(_dpa) if _dpa is not None else None
    name = d.get("dealname", "")
    # "PAID - <practice> - Planner": the PAID prefix on the deal NAME is how a
    # genuinely signed, paying contract is flagged in HubSpot (the `contract_type`
    # property is not used for this — it stays empty/"Planner"). Strip it before
    # anything else touches `name`: the ODS join below matches on the deal name,
    # and an unstripped prefix would stop a paid practice resolving to its ODS.
    is_paid = bool(PAID_PREFIX_RE.match(name))
    if is_paid:
        name = PAID_PREFIX_RE.sub("", name, count=1)
    # Junk guard: a 2026-05-21 channel-partner bulk import created 13 deals
    # literally named " - Planner" (no practice). They carry no company and the
    # name->ODS fallback mis-attributes them all to one ODS. Skip them.
    if not name.replace(" - Planner", "").strip():
        skipped_blank += 1
        continue
    ods = (DEAL_ODS_OVERRIDES.get(str(d.get("_id")))
           or deal_id2ods.get(str(d.get("_id"))) or dealname2ods.get(name.strip().lower())
           or geo_name_fallback(name))
    p = ods2p.get(ods, {})
    # Deals missing from the attribution export (e.g. brand-new practices) still get
    # PCN / ICB / list size — fall back to the NHS practice directory, keyed by the
    # ODS resolved from the HubSpot company join above.
    geo = _geo_by_ods.get(ods, {}) if ods else {}
    recalling = ods in recalling_ods if ods else False
    if ods and ods in SHEET_LIVE and key != "live":
        promoted_live.append(f"{name.replace(' - Planner', '').strip()} ({ods}: {key} -> live)")
        key, label = "live", KEY2LABEL.get("live", "live")

    # next step booked? — only FUTURE visits/meetings count (past "scheduled" visits = completed)
    next_step = next_step_for(ods, key, deal_id=d.get("_id"))

    thr = STALE.get(key, 30)
    stale = (days_in is not None and days_in > thr) and next_step is None and not (key == "live" and recalling)

    # last-email recency + "needs a chase" flag (won/near-won deals stalling)
    le = last_email.get(str(d.get("_id")))
    days_since_email = round(days_between(parse(le["date"]), NOW)) if le and le.get("date") else None
    # last 3 emails (any person) on the deal — for the practice page's contact trail
    le3 = []
    for em in last_emails.get(str(d.get("_id")), []):
        dt = parse(em["ts"])
        le3.append({"subject": em["subject"], "direction": em["direction"], "by": em.get("by"),
                    "body": em.get("body"),
                    "date": dt.date().isoformat() if dt else None,
                    "days_ago": round(days_between(dt, NOW)) if dt else None})
    # last touch of ANY kind from HubSpot deal properties (email/call/meeting/note)
    _lc = parse(d.get("notes_last_contacted")) or parse(d.get("hs_lastactivitydate"))
    last_contact = _lc.date().isoformat() if _lc else None
    days_since_contact = round(days_between(_lc, NOW)) if _lc else None
    CHASE_STAGES = {"demo_held", "dpa_sent", "dpa_signed"}
    needs_chase = key in CHASE_STAGES and stale

    # time taken in each completed stage transition (for tooltip)
    durations = []
    for j in range(len(STAGES) - 1):
        a_ = parse(d.get(f"hs_v2_date_entered_{STAGES[j][0]}"))
        b_ = parse(d.get(f"hs_v2_date_entered_{STAGES[j+1][0]}"))
        if a_ and b_ and b_ >= a_:
            durations.append({"step": f"{STAGES[j][2]}→{STAGES[j+1][2]}",
                              "days": round((b_ - a_).total_seconds() / 86400)})

    # full stage timeline: when each stage was entered + gap from the previous reached stage
    stage_timeline, _prev_dt = [], None
    for sid, _skey, slabel in STAGES:
        sdt = parse(d.get(f"hs_v2_date_entered_{sid}"))
        if not sdt:
            continue
        gap = round((sdt - _prev_dt).total_seconds() / 86400) if _prev_dt and sdt >= _prev_dt else None
        stage_timeline.append({"stage": slabel, "date": sdt.date().isoformat(),
                               "gap_days": gap, "current": sid == cur})
        _prev_dt = sdt
    patients = p.get("patients") or geo.get("patients")
    rec_months = dict(recalls_by_ods_month.get(ods, {}) if ods else {})
    recalls_tm = recalls_tm_by_ods.get(ods, rec_months.get(CUR_MONTH, 0)) if ods else 0
    if (rec_months or recalls_tm) and CUR_MONTH not in rec_months:  # always show current month for active practices
        rec_months[CUR_MONTH] = recalls_tm                          # (even 0 → "gone quiet this month")
    rbm_recent = {m: rec_months[m] for m in sorted(rec_months)[-6:]}
    bloods_tm = bloods_tm_by_ods.get(ods, 0) if ods else 0
    bl_months = dict(bloods_by_ods_month.get(ods, {}) if ods else {})
    if (bl_months or bloods_tm) and CUR_MONTH not in bl_months:
        bl_months[CUR_MONTH] = bloods_tm
    blm_recent = {m: bl_months[m] for m in sorted(bl_months)[-6:]}
    fy_total, recalls_avg = metric_stats(recalls_by_ods_month, fy_recalls_by_ods, ods)
    bl_total, bloods_avg = metric_stats(bloods_by_ods_month, fy_bloods_by_ods, ods)
    fy_pct = pct_of_list(fy_total, patients)
    bl_pct = pct_of_list(bl_total, patients)
    pctm = lambda rec: ({m: round(c / patients * 100, 1) for m, c in rec.items()} if patients else {})

    # EHR: HubSpot deal property first, tracker sheet's EHR column as fallback
    # (resolved after `ods` exists — see the sheet_ehr helper above).
    ehr = d.get("ehr_type") or (sheet_ehr(ods) if ods else None) or "Unknown"
    onb_steps = onboarding_by_ods.get(ods) if ods else None
    # SystmOne (TPP) practices need no EMIS notification or sharing agreement —
    # blank those steps as N/A so they don't count as outstanding (Will, 2026-06-27).
    if onb_steps and ("systm" in ehr.lower() or ehr.strip().lower() == "s1"):
        onb_steps = [dict(s, state="na", value=(s["value"] or "N/A · SystmOne"))
                     if s["key"] in ("emis_notified", "sharing_agreement") and s["state"] != "done" else s
                     for s in onb_steps]

    rows.append({
        "deal_id": d.get("_id"), "name": name.replace(" - Planner", ""), "ods": ods,
        "paid": is_paid,
        "stage": key, "stage_label": label, "ehr": ehr,
        "days_in_stage": round(days_in) if days_in is not None else None,
        "days_since_dpa": days_since_dpa,
        "owner": owners.get(str(d.get("hubspot_owner_id"))) or None,
        "owner_email": owner_emails.get(str(d.get("hubspot_owner_id"))) or None,
        "next_step": next_step, "recalling": recalling, "stale": stale,
        "fy_recalls": fy_total, "recalls_avg_mo": recalls_avg, "fy_recalls_pct": fy_pct,
        "fy_bloods": bl_total, "bloods_avg_mo": bloods_avg, "fy_bloods_pct": bl_pct,
        "recalls_this_month": recalls_tm, "bloods_this_month": bloods_tm,
        "recalls_this_month_pct": pct_of_list(recalls_tm, patients),
        "recalls_by_month": rbm_recent, "recalls_pct_by_month": pctm(rbm_recent),
        "bloods_by_month": blm_recent,
        "recalls_by_week": {w: c for w, c in sorted((recalls_by_ods_week.get(ods, {}) or {}).items())[-8:]} if ods else {},
        "bloods_by_week": {w: c for w, c in sorted((bloods_by_ods_week.get(ods, {}) or {}).items())[-8:]} if ods else {},
        "why": why(key, days_in, recalling, fy_total, recalls_avg, fy_pct, bl_total, bl_pct),
        "source": p.get("source"), "icb": p.get("icb") or geo.get("icb"), "patients": patients,
        # A PAID deal always shows as the paying tier, whatever the tiers file says
        # (the sheet/tiers file defaults everyone to Freemium and lags reality).
        "tier": ("Gold" if is_paid else p.get("tier")),
        "pcn_name": p.get("pcn_name") or geo.get("pcn_name"), "amount": to_amount(d.get("amount")),
        "stage_durations": durations, "stage_timeline": stage_timeline,
        "onboarding": onb_steps,
        "onboarding_sessions": (onb_sessions_by_ods.get(ods) if ods else None) or onb_sessions_by_deal.get(str(d.get("_id"))) or [],
        "other_meetings": (other_meetings_by_ods.get(ods) if ods else None) or other_meetings_by_deal.get(str(d.get("_id"))) or [],
        "sheet_notes": onboarding_notes_by_ods.get(ods) if ods else None,
        "last_email": le, "days_since_email": days_since_email, "last_emails": le3,
        "last_contact": last_contact, "days_since_contact": days_since_contact,
        "needs_chase": needs_chase,
    })

# Dedupe deals that share an ODS (e.g. two HubSpot deals for the same practice):
# keep the furthest-along stage; tie-break on longest time in stage, then deal id.
_rank = {k: i for i, k in enumerate(KEYS)}
_by_ods = {}
for r in rows:
    if not r.get("ods"):
        continue
    _by_ods.setdefault(r["ods"], []).append(r)
dropped_dups = []
for ods, group in _by_ods.items():
    if len(group) < 2:
        continue
    group.sort(key=lambda r: (-_rank.get(r["stage"], -1), -(r["days_in_stage"] or 0), str(r["deal_id"])))
    for r in group[1:]:
        dropped_dups.append(f"{r['name']} ({ods}, deal {r['deal_id']})")
        rows.remove(r)
if skipped_blank or dropped_dups or promoted_live:
    print(f"  hygiene: skipped {skipped_blank} blank-name deals · "
          f"dropped {len(dropped_dups)} ODS duplicates {dropped_dups or ''} · "
          f"promoted to live (sheet) {promoted_live or 'none'}")

# ---------- signed & paid revenue / ARR ----------
# "Signed & paid" = a genuinely signed, paying contract. HubSpot deal `amount`
# is NOT a reliable signal for this: as of 2026-06 almost every deal carries a
# *quote/list* price (incl. Freemium practices and deals still in the pipeline),
# so `amount > 0` no longer means "paying". Everyone else who is live is on
# Freemium (£0 today).
# >>> Paying customers are flagged in HubSpot by renaming the deal to
# >>> "PAID - <practice> - Planner" (see PAID_PREFIX_RE). Nothing to edit here:
# >>> rename the deal and the next build picks it up.
signed_rows = sorted(
    (r for r in rows if r.get("paid") and (r.get("amount") or 0) > 0),
    key=lambda r: -(r["amount"] or 0))
# A PAID deal with no amount is a data-entry slip — it would silently under-report
# ARR, so say so rather than dropping it on the floor.
for r in rows:
    if r.get("paid") and not (r.get("amount") or 0) > 0:
        print(f"  WARN: '{r['name']}' is flagged PAID but has no deal amount — excluded from ARR")
current_arr = round(sum(r["amount"] for r in signed_rows), 2)
revenue = {
    "current_arr": current_arr,
    "currency": "GBP",
    "source": "HubSpot Planner pipeline · signed & paid = deals named \"PAID - …\" (HubSpot amounts elsewhere are quotes, not commitments)",
    "deal_count": len(signed_rows),
    "deals": [{"name": r["name"], "ods": r.get("ods"), "stage": r["stage"], "amount": r["amount"]}
              for r in signed_rows],
}
print(f"  revenue: £{current_arr:,.0f} signed ARR across {len(signed_rows)} paying deal(s) "
      f"{[r['name'] for r in signed_rows] or 'none'}")

# ---------- week-by-week funnel reconstructed from stage-entry timestamps ----------
def reached_as_of(cutoff):
    out = []
    for i in range(len(STAGES)):
        c = 0
        for d in planner["deals"]:
            for sid in STAGE_IDS[i:]:
                e = parse(d.get(f"hs_v2_date_entered_{sid}"))
                if e and e <= cutoff:
                    c += 1
                    break
        out.append(c)
    return out

# Operational recallers per week (recalls feed, VC tier excluded — VC practices
# aren't part of the Planner sales motion): a practice counts from the month of
# its first recall. HubSpot's "recalling" stage entry dates are unreliable.
try:
    _tiers_wk = json.loads((ROOT / "apps/tech-growth-map/public/data/practice_tiers.json").read_text())
except Exception:
    _tiers_wk = {}
def _tier_of(o):
    v = _tiers_wk.get(o)
    return (v.get("tier") if isinstance(v, dict) else v) or None
first_recall_month = {}
for _o, _months in recalls_by_ods_month.items():
    _pos = [m for m, c in _months.items() if c]
    # same activation threshold as recalling_ods — test blips don't count
    if _pos and _tier_of(_o) != "VC" and sum(_months.values()) >= MIN_ACTIVE_RECALLS:
        first_recall_month[_o] = min(_pos)

weekly = []
for w in range(7, -1, -1):                       # 7 weeks ago .. now
    cutoff = NOW - timedelta(days=7 * w)
    r = reached_as_of(cutoff)
    conv = {KEYS[i]: (round(r[i] / r[i-1] * 100) if i > 0 and r[i-1] else None) for i in range(len(STAGES))}
    reached = {KEYS[i]: r[i] for i in range(len(STAGES))}
    cm = cutoff.strftime("%Y-%m")
    rec_n = sum(1 for m in first_recall_month.values() if m <= cm)
    # denominator = today's functionally-live universe (sheet Live ∪ recallers),
    # so the series reads as an activation curve of the current live cohort.
    _live_universe = len(SHEET_LIVE | recalling_ods) or None
    reached["recalling"] = rec_n
    conv["recalling"] = round(rec_n / _live_universe * 100) if _live_universe else None
    weekly.append({"week": cutoff.date().isoformat(), "reached": reached, "conv": conv})
conv_now = weekly[-1]["conv"]
conv_prev = weekly[-2]["conv"] if len(weekly) > 1 else {}
ever = [weekly[-1]["reached"][k] for k in KEYS]

# ---------- per-stage aggregates ----------
def agg(key):
    sub = [r for r in rows if r["stage"] == key]
    return {"count": len(sub), "stale": sum(1 for r in sub if r["stale"]),
            "no_next": sum(1 for r in sub if r["next_step"] is None and not (key == "live" and r["recalling"]))}

stages_out = []
for i, key in enumerate(KEYS):
    a = agg(key)
    cn, cp = conv_now.get(key), conv_prev.get(key)
    stages_out.append({
        "key": key, "label": KEY2LABEL.get(key, key), "in_stage": a["count"], "ever_reached": ever[i],
        "conv_from_prev": cn, "conv_delta_1w": (cn - cp) if cn is not None and cp is not None else None,
        "stale": a["stale"], "no_next_step": a["no_next"],
    })
live_rows = [r for r in rows if r["stage"] == "live"]
recalling_ct = sum(1 for r in live_rows if r["recalling"])
stages_out.append({
    "key": "recalling", "label": "Recalling", "in_stage": recalling_ct, "ever_reached": recalling_ct,
    "conv_from_prev": round(recalling_ct / len(live_rows) * 100) if live_rows else None,
    "conv_delta_1w": None, "stale": 0, "no_next_step": 0, "is_activation": True})

# ---------- recalling cohort (ODS-based, from recalls.json — matches the Omni feed) ----------
# The Implementation tab uses THIS, not the HubSpot-deal funnel, so it shows EVERY
# live/recalling practice (incl. VC + Sheet-Live practices without a matched Planner deal).
geo = json.loads((ROOT / "apps/tech-growth-map/public/data/practices_geocoded.json").read_text())
ods_info = {p["ods"].upper(): p for p in geo}
try:
    _tiers = json.loads((ROOT / "apps/tech-growth-map/public/data/practice_tiers.json").read_text())
except Exception:
    _tiers = {}
def _tier(o):
    v = _tiers.get(o)
    return (v.get("tier") if isinstance(v, dict) else v) or None
def _sheet(fn):
    try: return set(x.upper() for x in json.loads((ROOT / "apps/tech-growth-map/public/data" / fn).read_text()))
    except Exception: return set()
sheet_live = _sheet("live_customers.json") | _sheet("live_customers_full_planner.json")
owner_by_ods = {r["ods"]: r.get("owner") for r in rows if r.get("ods") and r.get("owner")}
pipeline_ods = {r["ods"] for r in rows if r.get("ods")}
# ODS of practices with a PAID deal — used to override the tier label in the
# recalling / live-not-recalling lists (same rule as the deals themselves).
paid_ods = {r["ods"] for r in rows if r.get("paid") and r.get("ods")}

# ---------- per-practice journey: HubSpot stage dates + go-live + first recall ----------
# Lets the Implementation detail render a horizontal lifecycle (signup → live → first recall).
LIVE_ID = next((sid for sid, k, _ in STAGES if k == "live"), None)
go_live_by_ods, stage_timeline_by_ods = {}, {}
for d in planner["deals"]:
    o = deal_id2ods.get(str(d.get("_id")))
    if not o:
        continue
    gl = parse(d.get(f"hs_v2_date_entered_{LIVE_ID}")) if LIVE_ID else None
    if gl:
        iso = gl.date().isoformat()
        if o not in go_live_by_ods or iso < go_live_by_ods[o]:
            go_live_by_ods[o] = iso
for r in rows:
    o = r.get("ods")
    if o and r.get("stage_timeline") and (
        o not in stage_timeline_by_ods or len(r["stage_timeline"]) > len(stage_timeline_by_ods[o])):
        stage_timeline_by_ods[o] = r["stage_timeline"]

def first_recall_month(ods):
    months = [m for m, c in (recalls_by_ods_month.get(ods, {}) or {}).items() if c]
    return min(months) if months else None

recalling_practices = []
for ods, fyv in fy_recalls_by_ods.items():
    if not fyv or fyv < MIN_ACTIVE_RECALLS:   # test blips (1-4 FY recalls) aren't "recalling"
        continue
    info = ods_info.get(ods, {})
    pat = info.get("patients")
    fy_total, recalls_avg = metric_stats(recalls_by_ods_month, fy_recalls_by_ods, ods)
    bl_total, bloods_avg = metric_stats(bloods_by_ods_month, fy_bloods_by_ods, ods)
    rbm = {m: c for m, c in sorted((recalls_by_ods_month.get(ods, {}) or {}).items())[-6:]}
    blm = {m: c for m, c in sorted((bloods_by_ods_month.get(ods, {}) or {}).items())[-6:]}
    recalling_practices.append({
        "ods": ods,
        "name": info.get("name") or (ods2p.get(ods, {}) or {}).get("name") or ods,
        "patients": pat, "tier": ("Gold" if ods in paid_ods else (_tier(ods) or (ods2p.get(ods, {}) or {}).get("tier"))),
        "icb": info.get("icb"), "pcn_name": info.get("pcn_name"),
        "fy_recalls": fy_total, "fy_recalls_pct": pct_of_list(fy_total, pat), "recalls_avg_mo": recalls_avg,
        "recalls_this_month": recalls_tm_by_ods.get(ods, 0),
        "fy_bloods": bl_total, "fy_bloods_pct": pct_of_list(bl_total, pat),
        "bloods_this_month": bloods_tm_by_ods.get(ods, 0),
        "recalls_by_month": rbm, "bloods_by_month": blm,
        "recalls_by_week": {w: c for w, c in sorted((recalls_by_ods_week.get(ods, {}) or {}).items())[-8:]},
        "bloods_by_week": {w: c for w, c in sorted((bloods_by_ods_week.get(ods, {}) or {}).items())[-8:]},
        "live": ods in sheet_live,
        "in_pipeline": ods in pipeline_ods,
        "owner": owner_by_ods.get(ods),
        "source": (ods2p.get(ods, {}) or {}).get("source"),
        "stage_timeline": stage_timeline_by_ods.get(ods),
        "go_live": go_live_by_ods.get(ods),
        "first_recall_month": first_recall_month(ods),
        "next_step": next_step_for(ods), "last_visit": visit_info(ods), "visits": _visit_list(ods),
    })
recalling_practices.sort(key=lambda x: (-(x["fy_recalls_pct"] or 0), -(x["fy_recalls"] or 0)))

# ---------- live but NOT recalling (the activation gap) ----------
# Implementation team's first-recall worklist: practices that are functionally
# live (Google Sheet Status=Live, or at the HubSpot "Full Functionality Live"
# stage) but have recalled nothing this FY. Longest-live-without-recall first.
live_days_by_ods = {r["ods"]: r["days_in_stage"] for r in rows
                    if r["stage"] == "live" and r.get("ods")}
live_ods_all = set(sheet_live) | {r["ods"] for r in live_rows if r.get("ods")}
live_not_recalling = []
for ods in sorted(live_ods_all - recalling_ods):
    info = ods_info.get(ods, {})
    pat = info.get("patients")
    bl_total, bloods_avg = metric_stats(bloods_by_ods_month, fy_bloods_by_ods, ods)
    blm = {m: c for m, c in sorted((bloods_by_ods_month.get(ods, {}) or {}).items())[-6:]}
    live_not_recalling.append({
        "ods": ods,
        "name": info.get("name") or (ods2p.get(ods, {}) or {}).get("name") or ods,
        "patients": pat, "tier": ("Gold" if ods in paid_ods else (_tier(ods) or (ods2p.get(ods, {}) or {}).get("tier"))),
        "icb": info.get("icb"), "pcn_name": info.get("pcn_name"),
        "fy_recalls": 0, "fy_recalls_pct": None, "recalls_avg_mo": 0, "recalls_this_month": 0,
        "fy_bloods": bl_total, "fy_bloods_pct": pct_of_list(bl_total, pat),
        "bloods_this_month": bloods_tm_by_ods.get(ods, 0),
        "recalls_by_month": {}, "bloods_by_month": blm,
        "recalls_by_week": {},
        "bloods_by_week": {w: c for w, c in sorted((bloods_by_ods_week.get(ods, {}) or {}).items())[-8:]},
        "live": ods in sheet_live, "in_pipeline": ods in pipeline_ods,
        "live_days": live_days_by_ods.get(ods),
        "owner": owner_by_ods.get(ods),
        "source": (ods2p.get(ods, {}) or {}).get("source"),
        "stage_timeline": stage_timeline_by_ods.get(ods),
        "go_live": go_live_by_ods.get(ods),
        "first_recall_month": None,
        "next_step": next_step_for(ods), "last_visit": visit_info(ods), "visits": _visit_list(ods),
    })
live_not_recalling.sort(key=lambda x: (-(x["live_days"] or 0), -(x["patients"] or 0)))

# ============ insight layer (computed from the data already joined above) ============

_PREV_MONTH = (NOW.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")

# --- per-recaller extras: bloods attach, gone-quiet, penetration vs cohort median ---
_pcts = sorted(p["fy_recalls_pct"] for p in recalling_practices if p.get("fy_recalls_pct"))
recalling_median_pct = _pcts[len(_pcts) // 2] if _pcts else None
for p in recalling_practices:
    fr, fb_ = p.get("fy_recalls") or 0, p.get("fy_bloods") or 0
    p["bloods_attach_pct"] = round(fb_ / fr * 100) if fr else None
    p["no_bloods"] = fr >= MIN_ACTIVE_RECALLS and fb_ == 0
    rbm = p.get("recalls_by_month") or {}
    p["gone_quiet"] = bool(rbm.get(_PREV_MONTH)) and not rbm.get(CUR_MONTH)
    p["pct_vs_median"] = (round(p["fy_recalls_pct"] / recalling_median_pct, 1)
                          if p.get("fy_recalls_pct") and recalling_median_pct else None)

# --- patient reach + FY run-rate projection ---
patient_reach = sum(p.get("patients") or 0 for p in recalling_practices)
_cohort_by_month = {}
for p in recalling_practices:
    for m, c in (p.get("recalls_by_month") or {}).items():
        _cohort_by_month[m] = _cohort_by_month.get(m, 0) + c
_complete = sorted(m for m in _cohort_by_month if m < CUR_MONTH and m >= _FY_START)
_pace = (sum(_cohort_by_month[m] for m in _complete[-3:]) / len(_complete[-3:])) if _complete else 0
_fy_end_year = _fy_start_year + 1
_months_left = (_fy_end_year - NOW.year) * 12 + (3 - NOW.month)   # full months after this one, to March
fy_total_recalls = sum(p.get("fy_recalls") or 0 for p in recalling_practices)
# project: FY so far + remainder of the current month (pace minus what's already in)
# + pace for each full month left through March.
_cur_so_far = _cohort_by_month.get(CUR_MONTH, 0)
fy_projection = round(fy_total_recalls + max(0, _pace - _cur_so_far) + _pace * max(_months_left, 0))

# --- lead source -> activation (which channels produce practices that USE the product) ---
_src_agg = {}
for r in rows:
    src = (r.get("source") or "Unknown").strip() or "Unknown"
    a = _src_agg.setdefault(src, {"source": src, "signed": 0, "live": 0, "recalling": 0, "practices": []})
    a["signed"] += 1
    if r["stage"] == "live":
        a["live"] += 1
    if r.get("recalling"):
        a["recalling"] += 1
    a["practices"].append({"name": r["name"], "stage": r["stage_label"], "ods": r.get("ods")})
for a in _src_agg.values():
    a["practices"].sort(key=lambda p: (p["name"] or "").lower())
source_activation = sorted(_src_agg.values(), key=lambda a: -a["signed"])

# --- PCN warm-expansion targets: unsigned practices whose PCN already has a live/recalling member ---
def _set_file(fn):
    try:
        return set(x.upper() for x in json.loads((ROOT / "apps/tech-growth-map/public/data" / fn).read_text()))
    except Exception:
        return set()
_signed_universe = (_set_file("waitlist_ods.json") | _set_file("onboarding_ods.json")
                    | set(sheet_live) | recalling_ods | pipeline_ods)
_active_ods = recalling_ods | set(sheet_live)
_pcn_members = {}
for _p in geo:
    if _p.get("pcn_code"):
        _pcn_members.setdefault(_p["pcn_code"], []).append(_p)
pcn_targets = []
for _code, members in _pcn_members.items():
    active = [m for m in members if m["ods"].upper() in _active_ods]
    if not active:
        continue
    unsigned = [m for m in members if m["ods"].upper() not in _signed_universe]
    if not unsigned:
        continue
    pcn_targets.append({
        "pcn_name": active[0].get("pcn_name") or _code, "pcn_code": _code,
        "active": [{"ods": m["ods"].upper(), "name": m["name"]} for m in active],
        "targets": sorted(({"ods": m["ods"].upper(), "name": m["name"], "patients": m.get("patients")}
                           for m in unsigned), key=lambda t: -(t["patients"] or 0)),
    })
pcn_targets.sort(key=lambda g: (-len(g["active"]), -len(g["targets"])))
pcn_targets = pcn_targets[:15]

# --- recurring blockers mined from the Notion visit "Problems" notes ---
_BLOCKER_TAGS = [
    ("Booking links", ("booking link",)),
    ("Lab / bloods whitelisting", ("whitelist", "lab", "blood")),
    ("Appointment config", ("appointment", "appt")),
    ("EMIS / IM1 access", ("emis", "im1")),
    ("Questionnaires / ICB forms", ("questionnaire", "icb", "ecf")),
]
_blocker_counts = {label: [] for label, _ in _BLOCKER_TAGS}
_blocker_other = []
for _ods, _v in (pv_by_ods or {}).items():
    for _vis in ([_v] + (_v.get("history") or [])):
        note = (_vis.get("problems") or "").strip()
        if not note or note.lower() in ("n/a", "none", "-"):
            continue
        nm = _vis.get("practice_name") or (ods_info.get(_ods, {}) or {}).get("name") or _ods
        entry = {"practice": nm, "ods": _ods, "date": _vis.get("date"), "note": note[:220]}
        hit = False
        low = note.lower()
        for label, kws in _BLOCKER_TAGS:
            if any(k in low for k in kws):
                if entry not in _blocker_counts[label]:
                    _blocker_counts[label].append(entry)
                hit = True
        if not hit and entry not in _blocker_other:
            _blocker_other.append(entry)
blockers = ([{"tag": label, "count": len(es), "examples": es[:6]}
             for label, es in _blocker_counts.items() if es]
            + ([{"tag": "Other", "count": len(_blocker_other), "examples": _blocker_other[:6]}]
               if _blocker_other else []))
blockers.sort(key=lambda b: -b["count"])

# --- velocity: median days DPA-signed -> live, and live -> first recall ---
def _median(xs):
    xs = sorted(xs)
    return round(xs[len(xs) // 2]) if xs else None
_d2l, _l2r = [], []
for p in recalling_practices + live_not_recalling:
    tl = {t["stage"]: t["date"] for t in (p.get("stage_timeline") or [])}
    dpa = next((v for k, v in tl.items() if "DPA Signed" in k), None)
    gl = p.get("go_live")
    if dpa and gl and gl >= dpa:
        _d2l.append((parse(gl) - parse(dpa)).days)
    frm = p.get("first_recall_month")
    if gl and frm and f"{frm}-01" >= gl[:10]:
        _l2r.append((parse(f"{frm}-15") - parse(gl)).days)
velocity = {"dpa_to_live_median_days": _median(_d2l), "live_to_first_recall_median_days": _median(_l2r),
            "n_dpa_to_live": len(_d2l), "n_live_to_recall": len(_l2r)}

# --- this-week digest: stage moves, new recallers, gone-quiet, stale by owner ---
_moves = sorted((r for r in rows if r.get("days_in_stage") is not None and r["days_in_stage"] <= 7),
                key=lambda r: r["days_in_stage"])
_new_recallers = [p["name"] for p in recalling_practices if p.get("first_recall_month") == CUR_MONTH]
_quiet = [p["name"] for p in recalling_practices if p.get("gone_quiet")]
_owner_stale = {}
for r in rows:
    if r.get("stale"):
        _owner_stale[r.get("owner") or "Unassigned"] = _owner_stale.get(r.get("owner") or "Unassigned", 0) + 1
this_week = {
    "stage_moves": [{"name": m["name"], "stage": m["stage_label"], "days_ago": m["days_in_stage"]} for m in _moves[:12]],
    "stage_moves_total": len(_moves),
    "new_recallers": _new_recallers,
    "gone_quiet": _quiet,
    "stale_by_owner": sorted(({"owner": o, "count": c} for o, c in _owner_stale.items()), key=lambda x: -x["count"])[:5],
}

# --- data warnings (source divergence etc.) surfaced on the board itself ---
data_warnings = []
if promoted_live:
    data_warnings.append(f"{len(promoted_live)} HubSpot deal(s) lag the Live sheet: " + "; ".join(promoted_live))
if dropped_dups:
    data_warnings.append(f"{len(dropped_dups)} duplicate deal(s) hidden: " + "; ".join(dropped_dups))
if skipped_blank:
    data_warnings.append(f"{skipped_blank} blank junk deal(s) skipped (channel-partner import 21 May) — archive them in HubSpot")
if onb_fallback_actionable:
    data_warnings.append(f"{len(onb_fallback_actionable)} active tracker row(s) missing an ODS code were matched by name — "
                         "fill the ODS Code cell to make it permanent: " + "; ".join(onb_fallback_actionable))
if onb_unresolved:
    data_warnings.append(f"{len(onb_unresolved)} In-Progress tracker row(s) have no ODS code and no name match — "
                         "their checklists are invisible until the ODS Code cell is filled: " + ", ".join(onb_unresolved))

# --- KPI history: tiny daily snapshot appended on every build (drives WoW deltas) ---
_dest = ROOT / "apps/primary-care-tech-overview/public/data/funnel_board.json"
kpi_history = []
try:
    kpi_history = json.loads(_dest.read_text()).get("kpi_history") or []
except Exception:
    pass
_today = NOW.date().isoformat()
kpi_history = [h for h in kpi_history if h.get("date") != _today]
kpi_history.append({
    "date": _today,
    "act_now": sum(1 for r in rows if r.get("stale")),
    "booked": sum(1 for r in rows if r.get("next_step")),
    "waitlist": sum(1 for r in rows if r["stage"] == "waitlist"),
    "lnr": len(live_not_recalling), "recalling": len(recalling_practices),
    "fy_recalls": fy_total_recalls,
    "fy_bloods": sum(p.get("fy_bloods") or 0 for p in recalling_practices),
})
kpi_history = kpi_history[-120:]

out = {
    "generated_at": NOW.isoformat(),
    "current_month": CUR_MONTH,
    "next_step_source": "notion_visits + hubspot_meetings" if hs_ok else "notion_visits + demo_booked (meetings unavailable)",
    "stale_thresholds": STALE,
    "stages": stages_out, "weekly": weekly, "deals": rows,
    "recalling_practices": recalling_practices,
    "live_not_recalling": live_not_recalling,
    "weekly_available": WEEKLY_AVAILABLE,
    "recalling_median_pct": recalling_median_pct,
    "patient_reach": patient_reach,
    "revenue": revenue,
    "fy_projection": fy_projection,
    "monthly_pace": round(_pace),
    "source_activation": source_activation,
    "pcn_targets": pcn_targets,
    "blockers": blockers,
    "velocity": velocity,
    "this_week": this_week,
    "data_warnings": data_warnings,
    "kpi_history": kpi_history,
}
dest = ROOT / "apps/primary-care-tech-overview/public/data/funnel_board.json"
dest.write_text(json.dumps(out, indent=2))
unmapped = sum(1 for r in rows if not r["ods"])
print(f"Wrote {len(rows)} active deals · {len(stages_out)} stages · {len(weekly)} weekly snapshots -> {dest.relative_to(ROOT)}")
print(f"  deal->ODS coverage: {len(rows)-unmapped}/{len(rows)} mapped")
print(f"  implementation: {len(recalling_practices)} recalling · {len(live_not_recalling)} live-not-recalling")
for s in stages_out:
    print(f"  {s['label']:<12} in={s['in_stage']:>3}  conv={s['conv_from_prev']}  Δ1w={s['conv_delta_1w']}  stale={s['stale']}")
