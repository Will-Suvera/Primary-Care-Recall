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
    for i in range(0, len(comp_ids), 100):
        cr = hs("POST", "/crm/v3/objects/companies/batch/read",
                {"properties": ["ods_unique", "practice_code"],
                 "inputs": [{"id": x} for x in comp_ids[i:i + 100]]})
        for r in cr.get("results", []):
            pr = r.get("properties", {})
            ods = (pr.get("ods_unique") or pr.get("practice_code") or "").strip().upper()
            if ods:
                comp2ods[str(r["id"])] = ods
    out = []
    for d in deals:
        p = d.get("properties", {})
        out.append({"deal_id": str(d["id"]),
                    "name": clean_deal_name(p.get("dealname") or ""),
                    "ehr": (p.get("ehr_type") or "").strip(),
                    "ods": comp2ods.get(deal2company.get(str(d["id"]), ""), "")})
    return out


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
        node = {"object": "block", "type": btype, btype: payload}
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

    missing = [d for d in deals
               if not (d["ods"] and d["ods"] in ods_seen)
               and not name_taken(norm_name(d["name"]), names_seen)]
    if not missing:
        print("Nothing to create — Notion is in sync.")
        return

    enrich, icb_code = load_enrichment()
    signed = load_signed_set()
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


if __name__ == "__main__":
    main()
