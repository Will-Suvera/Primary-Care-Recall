#!/usr/bin/env python3
"""Sync HubSpot "DPA Signed Onboard Ready" deals into the Notion Recall Practices DB.

Triggered by .github/workflows/notion-recall-sync.yml — a HubSpot workflow webhook
fires repository_dispatch the moment a deal enters the stage, and a 4-hourly
scheduled run reconciles anything a webhook missed.

For every deal currently in stage 4489053411 (pipeline 3277290730) that has no
row in the Notion DB (matched by ODS Code, falling back to a normalised name
match), create one: Stage=Onboarding, EHR from the deal, ODS/PCN/ICB columns
from practices_geocoded.json + the ODS API, and the "New Recall Practice"
template content copied into the page body (the Notion API cannot apply
templates natively). Existing rows are never modified — creation only.

Env: HUBSPOT_API_TOKEN, NOTION_API_TOKEN.  --dry-run prints without creating.
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HS_BASE = "https://api-eu1.hubapi.com"
PIPELINE_ID = "3277290730"
DPA_SIGNED_STAGE = "4489053411"  # "DPA Signed Onboard Ready" (label may be renamed; ID is stable)

NOTION_DB_ID = "506413ec202c433db739971a9f3830d6"          # Recall Practices
NOTION_MEETINGS_DB_ID = "cb96551db62b4d6f9eaa05f50995e9d7" # Partner Meeting Library
NOTION_TEMPLATE_PAGE = "39235d377c698070bfb1e87674db422f"  # "New Recall Practice" template
NOTION_VERSION = "2022-06-28"

GEOCODED = ROOT / "apps/tech-growth-map/public/data/practices_geocoded.json"
ODS_ICB_URL = ("https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations"
               "?Roles=RO318&Status=Active&Limit=200")

HS_TOKEN = os.environ.get("HUBSPOT_API_TOKEN", "")
NOTION_TOKEN = os.environ.get("NOTION_API_TOKEN", "")


def _request(url, method="GET", body=None, headers=None, retries=3):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            detail = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"{method} {url} -> {e.code}: {detail}") from e


def hs(method, endpoint, body=None):
    return _request(HS_BASE + endpoint, method, body, {"Authorization": f"Bearer {HS_TOKEN}"})


def notion(method, endpoint, body=None):
    return _request("https://api.notion.com/v1" + endpoint, method, body,
                    {"Authorization": f"Bearer {NOTION_TOKEN}", "Notion-Version": NOTION_VERSION})


def clean_deal_name(s):
    """Strip deal qualifiers ("PAID - X - Planner", "... - Free Trial ...") down to the practice name."""
    s = re.sub(r"^\s*PAID\b[\s-]*", "", s or "", flags=re.I)
    parts = re.split(r"\s+-\s+", s)
    qualifier = re.compile(r"^(planner|free trial\b.*|freemium\b.*|new deal\b.*|vc\b.*|pilot\b.*)$", re.I)
    while len(parts) > 1 and qualifier.match(parts[-1].strip()):
        parts.pop()
    return " - ".join(parts).strip()


def norm_name(s):
    """Match key for practice names across HubSpot dealnames and Notion titles."""
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    s = re.sub(r"\b(the|ltd|limited|surgery|surgeries|practice|practices|medical|"
               r"centre|center|health|group|gp|dr|planner|freemium)\b", " ", s)
    return " ".join(s.split())


def name_taken(n, names_seen):
    """True if a normalised name matches an existing row — equal, or token-subset
    either way ("primrose bank" ~ "primrose bank ewood") to survive naming drift."""
    if not n:
        return False
    toks = set(n.split())
    for seen in names_seen:
        st = set(seen.split())
        if n == seen or (toks and st and (toks <= st or st <= toks)):
            return True
    return False


# ---------- HubSpot: deals currently in DPA Signed Onboard Ready ----------

def fetch_stage_deals():
    deals, after = [], None
    while True:
        body = {"filterGroups": [{"filters": [
                    {"propertyName": "pipeline", "operator": "EQ", "value": PIPELINE_ID},
                    {"propertyName": "dealstage", "operator": "EQ", "value": DPA_SIGNED_STAGE}]}],
                "properties": ["dealname", "ehr_type"], "limit": 100}
        if after:
            body["after"] = after
        r = hs("POST", "/crm/v3/objects/deals/search", body)
        deals += r.get("results", [])
        after = r.get("paging", {}).get("next", {}).get("after")
        if not after:
            break
    # deal -> company -> ODS (same join as build_funnel_board.py)
    ids = [str(d["id"]) for d in deals]
    deal2company, comp2ods = {}, {}
    for i in range(0, len(ids), 100):
        assoc = hs("POST", "/crm/v4/associations/deals/companies/batch/read",
                   {"inputs": [{"id": x} for x in ids[i:i + 100]]})
        for r in assoc.get("results", []):
            tos = r.get("to", [])
            if tos:
                deal2company[str(r["from"]["id"])] = str(tos[0]["toObjectId"])
    comp_ids = list(set(deal2company.values()))
    comp_is_pcn = {}
    for i in range(0, len(comp_ids), 100):
        cr = hs("POST", "/crm/v3/objects/companies/batch/read",
                {"properties": ["ods_unique", "practice_code", "organisation_type"],
                 "inputs": [{"id": x} for x in comp_ids[i:i + 100]]})
        for r in cr.get("results", []):
            pr = r.get("properties", {})
            ods = (pr.get("ods_unique") or pr.get("practice_code") or "").strip().upper()
            if ods:
                comp2ods[str(r["id"])] = ods
            comp_is_pcn[str(r["id"])] = (pr.get("organisation_type") or "").strip().upper() == "PCN"
    out = []
    for d in deals:
        p = d.get("properties", {})
        cid = deal2company.get(str(d["id"]), "")
        out.append({"deal_id": str(d["id"]),
                    "name": clean_deal_name(p.get("dealname") or ""),
                    "ehr": (p.get("ehr_type") or "").strip(),
                    "ods": comp2ods.get(cid, ""),
                    "is_pcn": comp_is_pcn.get(cid, False)})
    return out


def fetch_pipeline_ods():
    """ODS codes of every practice with a deal anywhere in the Planner pipeline —
    used to decide which PCN members count as signed when a PCN-level deal lands."""
    ids = []
    # Planner pipeline + Client Success pipeline (signed practices can sit in
    # either — e.g. a PCN member whose own deal went straight to Client Success)
    for pipeline in (PIPELINE_ID, "2391616730"):
        after = None
        while True:
            body = {"filterGroups": [{"filters": [
                        {"propertyName": "pipeline", "operator": "EQ", "value": pipeline}]}],
                    "limit": 100}
            if after:
                body["after"] = after
            r = hs("POST", "/crm/v3/objects/deals/search", body)
            ids += [str(d["id"]) for d in r.get("results", [])]
            after = r.get("paging", {}).get("next", {}).get("after")
            if not after:
                break
    comp_ids = set()
    for i in range(0, len(ids), 100):
        assoc = hs("POST", "/crm/v4/associations/deals/companies/batch/read",
                   {"inputs": [{"id": x} for x in ids[i:i + 100]]})
        for r in assoc.get("results", []):
            comp_ids |= {str(t["toObjectId"]) for t in r.get("to", [])}
    out = set()
    comp_ids = list(comp_ids)
    for i in range(0, len(comp_ids), 100):
        cr = hs("POST", "/crm/v3/objects/companies/batch/read",
                {"properties": ["ods_unique", "practice_code"],
                 "inputs": [{"id": x} for x in comp_ids[i:i + 100]]})
        for r in cr.get("results", []):
            pr = r.get("properties", {})
            ods = (pr.get("ods_unique") or pr.get("practice_code") or "").strip().upper()
            if ods:
                out.add(ods)
    return out


def expand_pcn_deal(deal, enrich, signed):
    """A PCN-level deal covers whichever member practices have actually signed.
    Members come from the ODS ePCN data (pcn_name match on the deal/company name);
    "signed" = on the waitlist/live lists OR holding their own Planner-pipeline deal.
    Returns per-practice pseudo-deals; empty list means we couldn't expand safely."""
    n = norm_name(re.sub(r"\bpcn\b", "", deal["name"], flags=re.I))
    pcn_codes = {p["pcn_code"] for p in enrich.values()
                 if p.get("pcn_code") and norm_name(re.sub(r"\bpcn\b", "", p.get("pcn_name") or "", flags=re.I)) == n}
    if len(pcn_codes) != 1:
        return []
    code = pcn_codes.pop()
    members = [(ods, p) for ods, p in enrich.items() if p.get("pcn_code") == code]
    return [{"deal_id": deal["deal_id"], "name": p["name"].title(), "ehr": deal["ehr"],
             "ods": ods, "is_pcn": False}
            for ods, p in members if ods in signed]


# ---------- enrichment: ODS -> PCN / ICB ----------

def resolve_ods_by_name(name, pr, signed):
    """Fallback when the HubSpot company carries no ODS: accept a directory name
    match only if it is UNIQUE and the practice is on Suvera's signed/live lists.
    (Practice names repeat across England — "Riverside Medical" alone matches 14
    practices — so an unguarded fuzzy match would mislabel; blank is safer.)"""
    n = norm_name(name)
    hits = [ods for ods, p in pr.items() if norm_name(p["name"]) == n and ods in signed]
    return hits[0] if len(hits) == 1 else ""


def load_signed_set():
    d = ROOT / "apps/tech-growth-map/public/data"
    out = set()
    for f in ("waitlist_ods.json", "live_customers.json", "live_customers_full_planner.json"):
        out |= {x.upper() for x in json.loads((d / f).read_text())}
    return out


def load_enrichment():
    pr = {p["ods"].upper(): p for p in json.loads(GEOCODED.read_text())}
    icb_code = {}
    try:
        for o in _request(ODS_ICB_URL)["Organisations"]:
            name = re.sub(r"\s+", " ", o["Name"].upper().replace("INTEGRATED CARE BOARD", "ICB")).strip()
            icb_code[name] = o["OrgId"]
    except Exception as e:  # ICB codes are nice-to-have; don't fail the sync
        print(f"  WARN: ICB code lookup failed ({e}) — ICB ODS Code will be blank")
    return pr, icb_code


# ---------- Notion: existing rows, page creation, template copy ----------

def fetch_existing_rows():
    ods_seen, names_seen, after = set(), set(), None
    while True:
        body = {"page_size": 100}
        if after:
            body["start_cursor"] = after
        r = notion("POST", f"/databases/{NOTION_DB_ID}/query", body)
        for page in r.get("results", []):
            props = page.get("properties", {})
            ods = "".join(t.get("plain_text", "") for t in props.get("ODS Code", {}).get("rich_text", []))
            title = "".join(t.get("plain_text", "") for t in props.get("Practice Name", {}).get("title", []))
            if ods.strip():
                ods_seen.add(ods.strip().upper())
            if title.strip():
                names_seen.add(norm_name(title))
        after = r.get("next_cursor")
        if not r.get("has_more"):
            break
    return ods_seen, names_seen


def _sanitize_rich_text(items):
    out = []
    for t in items or []:
        if t.get("type") == "text":
            out.append({"type": "text", "text": t["text"], "annotations": t.get("annotations")})
        else:  # mentions/equations: degrade to plain text so creation never fails
            out.append({"type": "text", "text": {"content": t.get("plain_text", "")}})
    return out


def _strip_nulls(obj):
    """Notion rejects explicit nulls in create payloads (e.g. icon: null) — drop them."""
    if isinstance(obj, dict):
        return {k: _strip_nulls(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [_strip_nulls(x) for x in obj]
    return obj


def _copy_blocks(block_id, depth=0):
    """Read the template's blocks and rebuild them as creatable payloads."""
    if depth > 3:
        return []
    blocks, after = [], None
    while True:
        url = f"/blocks/{block_id}/children?page_size=100" + (f"&start_cursor={after}" if after else "")
        r = notion("GET", url)
        blocks += r.get("results", [])
        after = r.get("next_cursor")
        if not r.get("has_more"):
            break
    out = []
    for b in blocks:
        btype = b.get("type")
        if btype in (None, "unsupported", "child_page", "child_database"):
            continue
        payload = dict(b.get(btype) or {})
        if "rich_text" in payload:
            payload["rich_text"] = _sanitize_rich_text(payload["rich_text"])
        for drop in ("children",):
            payload.pop(drop, None)
        node = {"object": "block", "type": btype, btype: _strip_nulls(payload)}
        if b.get("has_children") and btype not in ("synced_block",):
            kids = _copy_blocks(b["id"], depth + 1)
            if kids:
                node[btype]["children"] = kids
        out.append(node)
    return out


def create_practice_page(deal, enrich, icb_code, template_blocks, dry_run):
    p = enrich.get(deal["ods"], {})
    icb = p.get("icb") or ""
    icb_ods = icb_code.get(re.sub(r"\s+", " ", icb.upper()).strip(), "") if icb else ""
    ehr = {"EMIS": "EMIS", "SYSTMONE": "SystmOne"}.get(deal["ehr"].upper().replace(" ", ""), "")

    def rt(v):
        return {"rich_text": [{"type": "text", "text": {"content": v}}]} if v else {"rich_text": []}

    props = {
        "Practice Name": {"title": [{"type": "text", "text": {"content": deal["name"]}}]},
        "Stage": {"select": {"name": "Onboarding"}},
        "ODS Code": rt(deal["ods"]),
        "PCN": rt(p.get("pcn_name") or ""),
        "PCN ODS Code": rt(p.get("pcn_code") or ""),
        "ICB": rt(icb),
        "ICB ODS Code": rt(icb_ods),
    }
    if ehr:
        props["EHR"] = {"select": {"name": ehr}}
    if p.get("patients"):
        props["List Size"] = rt(f"{p['patients']:,}")

    if dry_run:
        print(f"  DRY RUN would create: {deal['name']} ({deal['ods'] or 'no ODS'}) "
              f"EHR={ehr or '?'} PCN={p.get('pcn_name') or '?'}")
        return
    page = notion("POST", "/pages", {"parent": {"database_id": NOTION_DB_ID}, "properties": props})
    # Body content in chunks of <=100 blocks (API limit per append)
    for i in range(0, len(template_blocks), 100):
        notion("PATCH", f"/blocks/{page['id']}/children", {"children": template_blocks[i:i + 100]})
    print(f"  CREATED: {deal['name']} ({deal['ods'] or 'no ODS'}) -> {page.get('url')}")


# ---------- auto-link Partner Meeting Library pages to practice rows ----------

ODS_RE = re.compile(r"\b[A-Z]\d[0-9A-Z]{4,5}\b")


def _plain(prop, kind):
    return "".join(t.get("plain_text", "") for t in (prop or {}).get(kind, []))


def fetch_practice_rows():
    """Recall Practices rows: [{page_id, ods, name, pcn_name, pcn_code, icb}]."""
    rows, after = [], None
    while True:
        body = {"page_size": 100}
        if after:
            body["start_cursor"] = after
        r = notion("POST", f"/databases/{NOTION_DB_ID}/query", body)
        for pg in r.get("results", []):
            p = pg.get("properties", {})
            rows.append({"page_id": pg["id"],
                         "ods": _plain(p.get("ODS Code"), "rich_text").strip().upper(),
                         "name": _plain(p.get("Practice Name"), "title").strip(),
                         "pcn_name": _plain(p.get("PCN"), "rich_text").strip(),
                         "pcn_code": _plain(p.get("PCN ODS Code"), "rich_text").strip().upper(),
                         "icb": _plain(p.get("ICB"), "rich_text").strip()})
        after = r.get("next_cursor")
        if not r.get("has_more"):
            break
    return rows


def _strip_prefix(s):
    return re.sub(r"^\s*(planner demo|suvera demo|suvera support|suvera)\s*[:|]?\s*",
                  "", s or "", flags=re.I).strip()


def _pcn_norm(s):
    return norm_name(re.sub(r"\bpcn\b|\bprimary care network\b", "", s or "", flags=re.I))


def match_meeting_to_rows(title, practice_text, ods_text, rows):
    """Which practice rows does a meeting cover? Conservative by design — an
    ambiguous or contradicted match links nothing (prospect meetings dominate
    the library, and a wrong link is worse than a missing one)."""
    text = f"{title} | {practice_text} | {ods_text}"
    # 1. explicit ODS codes anywhere in the text
    codes = set(ODS_RE.findall(text.upper()))
    hits = [r for r in rows if r["ods"] and r["ods"] in codes]
    if hits:
        return hits, "ods"
    # 2. practice-name match on text segments; reject if the text names a
    #    different ICB than the row's (e.g. "Riverside Surgery (Cheshire...)"
    #    must not link the Sussex "Riverside Medical Practice" row)
    segs = [_strip_prefix(s) for s in re.split(r"[—–(),;/|]+|\s+-\s+", text) if s.strip()]
    cand = {r["page_id"]: r for s in segs if norm_name(s)
            for r in rows if norm_name(r["name"]) == norm_name(s)}
    if len(cand) == 1:
        row = next(iter(cand.values()))
        icb_mention = re.search(r"\b(NHS\s+)?([A-Za-z&,' ]+?)\s+ICB\b", text)
        if icb_mention and row["icb"]:
            if norm_name(icb_mention.group(2)) not in norm_name(row["icb"]):
                return [], "icb-mismatch"
        return [row], "name"
    if len(cand) > 1:
        return [], "ambiguous"
    # 3. PCN-level meeting -> every row in that PCN. Only when the meeting's
    #    SUBJECT (leading segment of the title or practice field) is the PCN
    #    itself — a practice meeting that merely mentions its PCN in brackets
    #    ("Lyndhurst Surgery (New Forest PCN)") must not fire this rule.
    subjects = [re.split(r"[—–(]|\s+-\s+", _strip_prefix(s))[0].strip()
                for s in (title, practice_text) if s]
    for subj in subjects:
        if not re.search(r"\bpcn\b|\bprimary care network\b", subj, re.I):
            continue
        n = _pcn_norm(subj)
        pcns = {r["pcn_code"] for r in rows if r["pcn_code"] and _pcn_norm(r["pcn_name"]) == n}
        if len(pcns) == 1:
            return [r for r in rows if r["pcn_code"] in pcns], "pcn"
    return [], "none"


def link_meetings(rows, enrich, icb_code, dry_run):
    """Link unlinked meeting pages to their practice rows (dual relation fills
    "Partner Calls" on the practice side); also fill blank ODS columns on the
    meeting when a single practice matched."""
    meetings, after = [], None
    while True:
        body = {"page_size": 100}
        if after:
            body["start_cursor"] = after
        r = notion("POST", f"/databases/{NOTION_MEETINGS_DB_ID}/query", body)
        meetings += r.get("results", [])
        after = r.get("next_cursor")
        if not r.get("has_more"):
            break
    linked = 0
    for m in meetings:
        p = m.get("properties", {})
        if (p.get("Recall Practice") or {}).get("relation"):
            continue  # already linked — never overwrite
        hits, how = match_meeting_to_rows(_plain(p.get("Meeting"), "title"),
                                          _plain(p.get("Practice"), "rich_text"),
                                          _plain(p.get("ODS Code"), "rich_text"), rows)
        if not hits:
            continue
        title = _plain(p.get("Meeting"), "title")[:60]
        if dry_run:
            print(f"  DRY RUN would link ({how}): '{title}' -> {[r['name'] for r in hits]}")
            linked += 1
            continue
        props = {"Recall Practice": {"relation": [{"id": r["page_id"]} for r in hits]}}
        if not _plain(p.get("ODS Code"), "rich_text").strip():
            def rt(v):
                return {"rich_text": [{"type": "text", "text": {"content": v}}]} if v else {"rich_text": []}
            ods_list = [r["ods"] for r in hits if r["ods"]]
            props["ODS Code"] = rt(", ".join(ods_list))
            if len(hits) == 1 and hits[0]["ods"] in enrich:
                g = enrich[hits[0]["ods"]]
                icb = g.get("icb") or ""
                props["PCN"] = rt(g.get("pcn_name") or "")
                props["PCN ODS Code"] = rt(g.get("pcn_code") or "")
                props["ICB"] = rt(icb)
                props["ICB ODS Code"] = rt(icb_code.get(re.sub(r"\s+", " ", icb.upper()).strip(), ""))
            elif hits and all(r["pcn_code"] == hits[0]["pcn_code"] for r in hits):
                props["PCN"] = rt(hits[0]["pcn_name"])
                props["PCN ODS Code"] = rt(hits[0]["pcn_code"])
        notion("PATCH", f"/pages/{m['id']}", {"properties": props})
        print(f"  LINKED ({how}): '{title}' -> {[r['name'] for r in hits]}")
        linked += 1
    if not linked:
        print("No new meeting links.")


def main():
    dry_run = "--dry-run" in sys.argv
    if not HS_TOKEN:
        sys.exit("HUBSPOT_API_TOKEN not set")
    if not NOTION_TOKEN:
        sys.exit("NOTION_API_TOKEN not set")

    deals = fetch_stage_deals()
    print(f"{len(deals)} deals in DPA Signed Onboard Ready")
    ods_seen, names_seen = fetch_existing_rows()
    print(f"{len(ods_seen)} ODS codes / {len(names_seen)} names already in Notion")
    enrich, icb_code = load_enrichment()

    missing = [d for d in deals
               if not (d["ods"] and d["ods"] in ods_seen)
               and not name_taken(norm_name(d["name"]), names_seen)]
    if not missing:
        print("Nothing to create — Notion is in sync.")
        link_meetings(fetch_practice_rows(), enrich, icb_code, dry_run)
        return

    signed = load_signed_set()

    # PCN-level deals expand to their signed member practices (one row each);
    # a PCN we can't safely expand falls through as a single umbrella row.
    expanded, pipeline_ods = [], None
    for d in missing:
        if d["is_pcn"] or (not d["ods"] and re.search(r"\bpcn\b", d["name"], re.I)):
            if pipeline_ods is None:
                pipeline_ods = fetch_pipeline_ods()
            members = expand_pcn_deal(d, enrich, signed | pipeline_ods)
            if members:
                print(f"  PCN deal '{d['name']}' -> {len(members)} signed member practice(s)")
                expanded += members
                continue
            print(f"  WARN: couldn't expand PCN deal '{d['name']}' — creating umbrella row")
        expanded.append(d)
    missing = [d for d in expanded
               if not (d["ods"] and d["ods"] in ods_seen)
               and not name_taken(norm_name(d["name"]), names_seen)]
    if not missing:
        print("Nothing to create after PCN expansion.")
    else:
        for d in missing:
            if not d["ods"]:
                d["ods"] = resolve_ods_by_name(d["name"], enrich, signed)
        template_blocks = [] if dry_run else _copy_blocks(NOTION_TEMPLATE_PAGE)
        if not dry_run:
            print(f"template: {len(template_blocks)} top-level blocks copied")
        for d in missing:
            create_practice_page(d, enrich, icb_code, template_blocks, dry_run)
            names_seen.add(norm_name(d["name"]))  # guard against duplicate dealnames in one run
        print(f"Done — {len(missing)} practice(s) {'would be' if dry_run else ''} created.")

    link_meetings(fetch_practice_rows(), enrich, icb_code, dry_run)


if __name__ == "__main__":
    main()
