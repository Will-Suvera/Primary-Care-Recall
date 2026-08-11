#!/usr/bin/env python3
"""
Automated data refresh for the GP Practice Growth Dashboard.

Fetches and updates:
1. All active GP practices in England from NHS ODS API (filtered to real GP practices)
2. Geocodes postcodes via postcodes.io
3. Waitlist ODS codes from HubSpot list 1535 (the segment surfaced at
   https://app-eu1.hubspot.com/contacts/143576889/objectLists/1535)
4. Expands PCN contacts to their constituent GP practices

Requires:
    HUBSPOT_API_TOKEN env var (set in .env file or repo secrets)

Usage:
    python3 refresh_data.py              # Full refresh (practices + waitlist)
    python3 refresh_data.py --waitlist   # Waitlist only (faster, runs in CI every 5 min)
    python3 refresh_data.py --practices  # Practices only
    python3 refresh_data.py --tiers      # Planner Growth Dashboard tier map only
"""

import json
import os
import re
import time
import sys
import urllib.request
import urllib.error
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "apps" / "tech-growth-map" / "public" / "data"
HUBSPOT_BASE = "https://api.hubapi.com"

# Google Sheets published CSV URL for the onboarding tracker.
# Column G (idx 6) = Status, Column H (idx 7) = ODS Code.
# Practices with Status = "Live" are merged into live_customers.json.
GSHEET_BASE = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vRa6zIwdwnNSfjjU_gVYdZ7Pm6Sy6XWsyVe0gR6AZP55IzeVW9"
    "qisAUb0Hvo4Nr7qdGhWLnK1l4SDnl/pub?output=csv"
)
GSHEET_SAAS_URL = GSHEET_BASE + "&gid=0"           # SaaS tab
GSHEET_VC_URL = GSHEET_BASE + "&gid=993386637"     # VC practices tab

# Manual name -> ODS overrides for ambiguous practice names. Used by both
# the VC sheet parser and the Omni recall name-matcher. Lowercase keys.
# Two practices in practices_geocoded.json are called "Twyford Surgery":
# J82116 (SO21 1QY, Winchester Rural South PCN) and K81070 (RG10 9JA,
# Phoenix PCN, Reading). The auto-matcher would always pick the later
# one (K81070), so any sheet/CSV that just says "Twyford" or "Twyford
# Surgery" needs to be pinned to J82116.
VC_NAME_OVERRIDES = {
    "twyford": "J82116",
    "twyford surgery": "J82116",
    # Two ALMA ROAD SURGERY entries (J82074 Romsey, J82122 Southampton).
    # The Live customer is J82074 — confirmed by Will 2026-06-11; the HubSpot
    # deal's company also carries J82074. (An earlier inference picked J82122.)
    "alma road": "J82074",
    "alma road surgery": "J82074",
    # Wootton Vale (Bedford) = ODS Y00560. Omni logs it as "Wootton Vale And
    # Shortstown Surgery"; the NHS/Live record is "Wootton Vale Healthy Living
    # Centre" — neither auto-matches, so pin every variant to Y00560.
    "wootton vale": "Y00560",
    "wootton vale and shortstown surgery": "Y00560",
    "wootton vale healthy living centre": "Y00560",
    # Confirmed by Will (2026-06-08): Omni names that don't auto-match the ODS directory.
    "lodge highfield redbourn": "E82014",
    "lodge highfield": "E82014",
    # Two "Ashville Surgery" (E85719, P84038) — the recalling one is P84038.
    "ashville surgery": "P84038",
    "ashville": "P84038",
    # Omni logs "Wistaria Milford Surgeries"; ODS name is "WISTARIA & MILFORD
    # SURGERIES" (J82139) — the "&" stops the substring match.
    "wistaria milford surgeries": "J82139",
    "wistaria and milford surgeries": "J82139",
    # The Lodge (Lodge, Highfield & Redbourn, St Albans) = E82014 — confirmed
    # against HubSpot ods_unique. A bare "Lodge" sheet row used to substring-
    # match A99876 "NEWTON LODGE - BCSS INPATIENT UNIT" (a screening pseudo-
    # practice) and sat wrongly in live_customers for weeks.
    "lodge": "E82014",
    "the lodge": "E82014",
    "the lodge partnership": "E82014",
}


def resolve_vc_name(practice_name, name_to_ods):
    """Resolve a VC-tab practice name to an ODS code.

    Order: manual override -> exact name match -> substring scan. The
    substring fallback skips NHS screening pseudo-practices (BCSS inpatient
    units, A99xxx codes) — they sort early in practices_geocoded.json and a
    short sheet name like "Lodge" would otherwise hit them first.
    """
    pname = practice_name.lower().strip()
    ods = VC_NAME_OVERRIDES.get(pname) or name_to_ods.get(pname)
    if ods:
        return ods
    for full_name, code in name_to_ods.items():
        if "bcss" in full_name:
            continue
        if pname in full_name:
            return code
    return None

# Omni exports → Google Sheets (scheduled daily from Omni)
# The original monthly recalls sheet stopped receiving Omni deliveries on
# 2026-08-01. It stays as the FROZEN ARCHIVE for months before RECALLS_CUTOVER
# (it holds Jul 2025 – May 2026, incl. FY Apr+May); the live feed is the new
# per-day sheet below, spliced in from RECALLS_CUTOVER onwards.
GSHEET_RECALLS_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vTDYmEyNiaLeSgJTfHy1OFoAH5X48yy3N7baiyCYd5nnFGToGi9GqTpKNqs-Oj2EC8oG4"
    "iTVSZENZMV/pub?output=csv&gid=0&single=true"
)
# "Planner recalls per day" — daily-grain Omni delivery (same "Recall At" lens,
# same 3 columns: date, practice name, count). Data starts 2026-06-01.
GSHEET_RECALLS_DAILY_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1IKGhc_BAsUQNq5Omfx9OHk9OEk-INJDOVloNLUI6F24/export?format=csv&gid=1271494859"
)
RECALLS_CUTOVER = "2026-06"  # archive strictly before; daily feed from here on
GSHEET_BLOODS_URL = (
    # Authoritative Omni → Sheet bloods export — feeds both the tech-growth
    # map and the Planner Growth Dashboard. Replaced 2026-05-25 (prior sheet
    # was missing Fernlea + 11 other recalling practices).
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vTIi4r8AyilSDdeJE2ak1BpKJca2wo5t1Gn6xMOyGzsXIBKTY0Y0ViKJIH0RS69kmrrTgMLGtXCc2S9"
    "/pub?output=csv"
)

# Refuse to overwrite waitlist_ods.json if the new file would be more than
# this fraction smaller than the existing one. Stops a partial HubSpot
# response from silently erasing real waitlist entries.
WAITLIST_SHRINK_LIMIT = 0.10  # 10%

# HTTP retry config for HubSpot calls.
HUBSPOT_MAX_RETRIES = 3
HUBSPOT_BACKOFF_BASE = 1.5  # seconds; doubles each attempt


def load_live_customers():
    """Load live customer ODS codes (single source of truth, includes full-planner tier)."""
    with open(DATA_DIR / "live_customers.json") as f:
        return set(json.load(f))


LIVE_CUSTOMER_ODS = load_live_customers()


def load_env():
    """Load .env file if present."""
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip())


def http_get_json(url):
    """GET a URL and return parsed JSON. Used for the public NHS ODS API."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


# ============================================================
# NHS ODS API - Practice Data
# ============================================================

def fetch_ods_practices():
    """Fetch all active GP practices from the NHS ODS API."""
    print("=== Fetching GP Practices from ODS API ===")
    all_orgs = []
    offset = 0
    page = 1

    while True:
        url = (
            "https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations"
            f"?PrimaryRoleId=RO177&Status=Active&Limit=1000&Offset={offset}"
        )
        print(f"  Page {page} (offset {offset})...")
        try:
            data = http_get_json(url)
        except urllib.error.HTTPError as e:
            print(f"  ODS API HTTP {e.code}: {e.read().decode()[:200]}")
            raise
        except urllib.error.URLError as e:
            print(f"  ODS API connection error: {e}")
            raise

        orgs = data.get("Organisations", [])
        all_orgs.extend(orgs)

        if len(orgs) < 1000:
            break
        offset += 1000
        page += 1

    print(f"  Total fetched: {len(all_orgs)}")
    return all_orgs


def geocode_postcodes(postcodes):
    """Bulk geocode postcodes using postcodes.io API."""
    print(f"\n=== Geocoding {len(postcodes)} Postcodes ===")
    postcode_coords = {}
    batch_size = 100

    for i in range(0, len(postcodes), batch_size):
        batch = postcodes[i:i + batch_size]
        batch_num = i // batch_size + 1

        payload = json.dumps({"postcodes": batch}).encode()
        req = urllib.request.Request(
            "https://api.postcodes.io/postcodes",
            data=payload,
            headers={"Content-Type": "application/json"},
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
            for result in data.get("result", []):
                if result.get("result"):
                    r = result["result"]
                    postcode_coords[result["query"]] = {
                        "lat": r["latitude"],
                        "lng": r["longitude"],
                        "country": r.get("country", ""),
                    }
        except Exception as e:
            print(f"  Error batch {batch_num}: {e}")

        if batch_num % 20 == 0:
            print(f"  {len(postcode_coords)} geocoded...")
        time.sleep(0.1)

    print(f"  Geocoded: {len(postcode_coords)}")
    return postcode_coords


def _load_pipeline_ods():
    """Union of full-planner + onboarding + waitlist ODS sets, uppercased.
    Used to whitelist Y/W codes into practices_geocoded.json so signed
    customers with non-standard codes still render on the map."""
    pipeline = set()
    for filename in ("live_customers_full_planner.json", "onboarding_ods.json", "waitlist_ods.json"):
        path = DATA_DIR / filename
        if path.exists():
            try:
                with open(path) as f:
                    pipeline.update(c.upper() for c in json.load(f))
            except Exception:
                pass
    return pipeline


def build_practices_dataset(practices, postcode_coords):
    """Build filtered England-only GP practice dataset.

    Default excludes Y/W codes (specials / Welsh practices), but keeps any
    Y/W code that appears in our pipeline so signed-up customers using
    non-standard codes render on the map.
    """
    print("\n=== Building England GP Practice Dataset ===")

    england_coords = {
        k: v for k, v in postcode_coords.items() if v["country"] == "England"
    }
    pipeline_ods = _load_pipeline_ods()

    result = []
    kept_yw = 0
    for p in practices:
        ods = p["OrgId"]
        pc = p.get("PostCode", "").strip()

        if ods.startswith("Y") or ods.startswith("W"):
            if ods.upper() not in pipeline_ods:
                continue
            kept_yw += 1

        if pc in england_coords:
            result.append({
                "ods": ods,
                "name": p["Name"],
                "postcode": pc,
                "lat": england_coords[pc]["lat"],
                "lng": england_coords[pc]["lng"],
            })

    print(f"  England GP practices: {len(result)} (incl {kept_yw} Y/W codes from pipeline)")
    return result


def refresh_practices():
    """Full practices refresh pipeline."""
    practices = fetch_ods_practices()

    unique_postcodes = list(set(
        p.get("PostCode", "").strip()
        for p in practices if p.get("PostCode", "")
    ))
    postcode_coords = geocode_postcodes(unique_postcodes)

    dataset = build_practices_dataset(practices, postcode_coords)

    output_path = DATA_DIR / "practices_geocoded.json"
    with open(output_path, "w") as f:
        json.dump(dataset, f)
    print(f"\n  Saved {len(dataset)} practices to {output_path}")
    return dataset


# ============================================================
# HubSpot API - Waitlist Data
# ============================================================

def hubspot_request(method, endpoint, data=None):
    """Make an authenticated HubSpot API request with retry on 429/5xx."""
    token = os.environ.get("HUBSPOT_API_TOKEN", "")
    if not token or token == "your-hubspot-private-app-token-here":
        print("ERROR: Set HUBSPOT_API_TOKEN in .env file or repo secrets")
        sys.exit(1)

    url = f"{HUBSPOT_BASE}{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    if data:
        payload = json.dumps(data).encode()
    else:
        payload = None

    last_error = None
    for attempt in range(1, HUBSPOT_MAX_RETRIES + 1):
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else ""
            # Retry on 429 (rate limit) and 5xx (server). Fail fast on 4xx.
            if e.code == 429 or 500 <= e.code < 600:
                last_error = f"HTTP {e.code}: {body[:200]}"
                if attempt < HUBSPOT_MAX_RETRIES:
                    delay = HUBSPOT_BACKOFF_BASE * (2 ** (attempt - 1))
                    print(f"  HubSpot {last_error} — retry {attempt}/{HUBSPOT_MAX_RETRIES} after {delay:.1f}s")
                    time.sleep(delay)
                    continue
            print(f"  HubSpot API error {e.code}: {body[:200]}")
            raise
        except urllib.error.URLError as e:
            last_error = f"URLError: {e}"
            if attempt < HUBSPOT_MAX_RETRIES:
                delay = HUBSPOT_BACKOFF_BASE * (2 ** (attempt - 1))
                print(f"  HubSpot {last_error} — retry {attempt}/{HUBSPOT_MAX_RETRIES} after {delay:.1f}s")
                time.sleep(delay)
                continue
            raise

    raise RuntimeError(f"HubSpot request failed after {HUBSPOT_MAX_RETRIES} attempts: {last_error}")


WAITLIST_LIST_ID = "1535"  # HubSpot list ID for the waitlist


def fetch_waitlist_contacts():
    """Fetch all contacts from HubSpot waitlist list (ID 1535)."""
    print(f"\n=== Fetching Waitlist from HubSpot List {WAITLIST_LIST_ID} ===")

    # Step 1: Get all contact IDs from the list
    contact_ids = []
    after = None
    while True:
        endpoint = f"/crm/v3/lists/{WAITLIST_LIST_ID}/memberships"
        if after:
            endpoint += f"?after={after}"
        result = hubspot_request("GET", endpoint)
        contact_ids.extend(m["recordId"] for m in result.get("results", []))
        after = result.get("paging", {}).get("next", {}).get("after")
        if not after:
            break
        time.sleep(0.1)

    print(f"  List members: {len(contact_ids)}")

    # Step 2: Fetch contact details in batches
    contacts = []
    batch_size = 100
    for i in range(0, len(contact_ids), batch_size):
        batch = contact_ids[i:i + batch_size]
        body = {
            "inputs": [{"id": cid} for cid in batch],
            "properties": ["firstname", "lastname", "email", "company"]
        }
        result = hubspot_request("POST", "/crm/v3/objects/contacts/batch/read", body)
        contacts.extend(result.get("results", []))
        time.sleep(0.2)

    # Filter out internal Suvera contacts and obvious test data.
    # Note: gmail/hotmail are NOT filtered here any more — many real GPs sign
    # up with personal emails. Move filtering into the HubSpot list filter
    # itself for the ideal long-term solution (see docs/hubspot-list-filter.md).
    real_contacts = []
    skip_email_substrings = {"@suvera.co", "@suvera.com", "@searchhog"}
    skip_names = {"test", "sdf", "wer", "qwer", "234", "wee"}

    for c in contacts:
        props = c.get("properties", {})
        email = (props.get("email") or "").lower()
        firstname = (props.get("firstname") or "").lower().strip()
        if any(s in email for s in skip_email_substrings):
            continue
        if firstname in skip_names:
            continue
        real_contacts.append(c)

    print(f"  Real contacts (excl internal Suvera/test): {len(real_contacts)}")
    return real_contacts


def get_contact_company_associations(contact_ids):
    """
    Get company associations for contacts using the v4 batch endpoint.
    Replaces the old per-contact loop (saves ~15s per refresh).
    """
    associations = {}
    if not contact_ids:
        return associations

    batch_size = 100
    for i in range(0, len(contact_ids), batch_size):
        batch = contact_ids[i:i + batch_size]
        body = {"inputs": [{"id": str(cid)} for cid in batch]}
        try:
            result = hubspot_request(
                "POST",
                "/crm/v4/associations/contact/company/batch/read",
                body,
            )
            for entry in result.get("results", []):
                from_id = int(entry.get("from", {}).get("id", 0))
                to_ids = [int(t["toObjectId"]) for t in entry.get("to", [])]
                if from_id and to_ids:
                    associations[from_id] = to_ids
        except Exception as e:
            print(f"  Error fetching association batch {i // batch_size + 1}: {e}")
        time.sleep(0.2)

    return associations


def get_companies_by_ids(company_ids):
    """Fetch company details by IDs in batches."""
    companies = {}
    batch_size = 100

    for i in range(0, len(company_ids), batch_size):
        batch = company_ids[i:i + batch_size]
        body = {
            "inputs": [{"id": str(cid)} for cid in batch],
            "properties": ["name", "practice_code", "ods_unique", "organisation_type"]
        }

        try:
            result = hubspot_request("POST", "/crm/v3/objects/companies/batch/read", body)
            for comp in result.get("results", []):
                companies[int(comp["id"])] = comp.get("properties", {})
        except Exception as e:
            print(f"  Error fetching company batch: {e}")
        time.sleep(0.2)

    return companies


def search_company_by_name(name):
    """Search for a company by name and return its ODS code."""
    body = {
        "query": name,
        "properties": ["name", "practice_code", "ods_unique"],
        "limit": 5,
    }

    try:
        result = hubspot_request("POST", "/crm/v3/objects/companies/search", body)
        for comp in result.get("results", []):
            props = comp.get("properties", {})
            ods = props.get("ods_unique") or props.get("practice_code")
            if ods:
                return ods
    except Exception:
        pass
    return None


# Whitelist: only count practices whose organisation_type explicitly says
# they are a GP practice. Stops federation/PCN/ICB child orgs from inflating
# the waitlist by accident.
GP_PRACTICE_ORG_TYPES = {
    "gp practice", "gp_practice", "gp surgery", "gp", "general practice",
}


def is_gp_practice(props):
    org_type = (props.get("organisation_type") or "").strip().lower()
    return org_type in GP_PRACTICE_ORG_TYPES


def expand_pcn_to_practices(pcn_company_id):
    """Find GP practices associated with a PCN company (whitelist by org type)."""
    ods_codes = []
    try:
        result = hubspot_request(
            "GET",
            f"/crm/v4/objects/companies/{pcn_company_id}/associations/companies"
        )
        child_ids = [r["toObjectId"] for r in result.get("results", [])]

        if child_ids:
            companies = get_companies_by_ids(child_ids)
            for props in companies.values():
                ods = props.get("ods_unique") or props.get("practice_code")
                if ods and is_gp_practice(props):
                    ods_codes.append(ods)
    except Exception as e:
        print(f"  Error expanding PCN {pcn_company_id}: {e}")

    return ods_codes


# ============================================================
# Schema validation
# ============================================================

def is_valid_ods(code):
    """True iff code looks like a real ODS code (3-10 alphanumerics)."""
    return isinstance(code, str) and 3 <= len(code.strip()) <= 10 and code.strip().isalnum()


def validate_waitlist_schema(codes):
    """Schema-check the waitlist before we write it to disk."""
    if not isinstance(codes, list):
        raise ValueError(f"waitlist must be a list, got {type(codes).__name__}")
    if len(codes) < 50:
        raise ValueError(
            f"waitlist suspiciously small ({len(codes)} codes) — refusing to write. "
            f"This usually means HubSpot returned a partial response."
        )
    for c in codes:
        if not isinstance(c, str):
            raise ValueError(f"waitlist entry must be string, got {type(c).__name__}: {c!r}")
        if not (3 <= len(c) <= 10):
            raise ValueError(f"ODS code looks malformed (length): {c!r}")
        if not c.isalnum():
            raise ValueError(f"ODS code looks malformed (non-alnum): {c!r}")


def write_waitlist_safely(new_codes, output_path):
    """
    Write waitlist_ods.json with two safety nets:
      1. Schema validation
      2. Refuse to overwrite if the new file would be >WAITLIST_SHRINK_LIMIT smaller
    """
    sorted_codes = sorted(set(new_codes))
    validate_waitlist_schema(sorted_codes)

    if output_path.exists():
        with open(output_path) as f:
            existing = json.load(f)
        if isinstance(existing, list) and len(existing) > 0:
            shrink = (len(existing) - len(sorted_codes)) / len(existing)
            if shrink > WAITLIST_SHRINK_LIMIT:
                raise RuntimeError(
                    f"Refusing to overwrite waitlist: new file would be "
                    f"{shrink:.1%} smaller ({len(existing)} → {len(sorted_codes)}). "
                    f"Likely a partial HubSpot response. Investigate before forcing."
                )

    with open(output_path, "w") as f:
        json.dump(sorted_codes, f, indent=2)


def refresh_waitlist():
    """Full waitlist refresh pipeline."""
    contacts = fetch_waitlist_contacts()
    contact_ids = [int(c["id"]) for c in contacts]

    # Get company associations for all contacts (batched)
    print(f"\n=== Fetching Company Associations ({len(contact_ids)} contacts) ===")
    associations = get_contact_company_associations(contact_ids)
    print(f"  {len(associations)} contacts have company associations")

    # Get all unique company IDs
    all_company_ids = set()
    for cids in associations.values():
        all_company_ids.update(cids)

    # Fetch company details
    print(f"\n=== Fetching {len(all_company_ids)} Company Details ===")
    companies = get_companies_by_ids(list(all_company_ids))

    # Extract ODS codes and identify PCNs
    waitlist_ods = set()
    pcn_ids = []
    no_ods_companies = []

    for comp_id, props in companies.items():
        ods = props.get("ods_unique") or props.get("practice_code")
        org_type = (props.get("organisation_type") or "").lower()
        name = props.get("name", "")

        if is_valid_ods(ods):
            waitlist_ods.add(ods.strip().upper())
        elif "pcn" in org_type or "pcn" in name.upper():
            pcn_ids.append(comp_id)
        else:
            no_ods_companies.append((comp_id, name))

    print(f"  Direct ODS codes: {len(waitlist_ods)}")
    print(f"  PCNs to expand: {len(pcn_ids)}")
    print(f"  Companies without ODS: {len(no_ods_companies)}")

    # Expand PCNs to constituent practices
    if pcn_ids:
        print(f"\n=== Expanding {len(pcn_ids)} PCNs ===")
        for pcn_id in pcn_ids:
            pcn_name = companies.get(pcn_id, {}).get("name", pcn_id)
            codes = expand_pcn_to_practices(pcn_id)
            print(f"  {pcn_name}: {len(codes)} practices")
            waitlist_ods.update(c.strip().upper() for c in codes if is_valid_ods(c))
            time.sleep(0.2)

    # Search by name for unassociated contacts
    unassociated = [
        c for c in contacts
        if int(c["id"]) not in associations
    ]
    if unassociated:
        print(f"\n=== Searching {len(unassociated)} Unassociated Contacts by Company Name ===")
        for c in unassociated:
            company_name = (c.get("properties", {}).get("company") or "").strip()
            if company_name and company_name.lower() not in ("", "x", "test", "sdf", "wer", "company"):
                ods = search_company_by_name(company_name)
                if ods and is_valid_ods(ods):
                    waitlist_ods.add(ods.strip().upper())
                    print(f"  {company_name} -> {ods}")
                time.sleep(0.2)

    # Also search by name for companies without ODS codes
    if no_ods_companies:
        print(f"\n=== Searching {len(no_ods_companies)} Companies Without ODS ===")
        for comp_id, name in no_ods_companies:
            if name and "pcn" not in name.upper() and "icb" not in name.upper():
                ods = search_company_by_name(name)
                if ods and is_valid_ods(ods):
                    waitlist_ods.add(ods.strip().upper())
                    print(f"  {name} -> {ods}")
                time.sleep(0.2)

    # Remove any live customer codes from waitlist (covers both planner
    # and full-planner tiers since they share live_customers.json).
    waitlist_ods -= LIVE_CUSTOMER_ODS

    # Remove any onboarding (In Progress) codes from waitlist — a practice
    # that's been promoted to the In Progress tier shouldn't also count
    # as still-signing-up. refresh_live_from_google_sheet() runs first in
    # main() so onboarding_ods.json reflects the current sheet state.
    onboarding_path = DATA_DIR / "onboarding_ods.json"
    if onboarding_path.exists():
        with open(onboarding_path) as f:
            onboarding_ods = set(c.upper() for c in json.load(f))
        moved = waitlist_ods & onboarding_ods
        if moved:
            print(f"  Removing {len(moved)} waitlist codes promoted to In Progress")
            waitlist_ods -= onboarding_ods

    # Validate + write with shrink-protection
    output_path = DATA_DIR / "waitlist_ods.json"
    write_waitlist_safely(waitlist_ods, output_path)

    # Save the raw contact count so the frontend can display it
    meta_path = DATA_DIR / "waitlist_meta.json"
    with open(meta_path, "w") as f:
        json.dump({"contacts": len(contacts)}, f)

    print(f"\n  Saved {len(waitlist_ods)} waitlist ODS codes to {output_path}")
    print(f"  Saved contact count ({len(contacts)}) to {meta_path}")
    return sorted(waitlist_ods)


def refresh_live_from_google_sheet():
    """
    Fetch live practices from the published Google Sheet and merge into
    live_customers.json. Additive only — never removes existing entries.
    Falls back gracefully if the sheet is unavailable.
    """
    global LIVE_CUSTOMER_ODS

    import csv
    import io

    def fetch_csv(url):
        req = urllib.request.Request(url, headers={"User-Agent": "SuveraRefreshBot/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8-sig")

    print("\n=== Fetching Live Customers from Google Sheet ===")
    sheet_live = set()
    sheet_onboarding = set()  # status="In Progress" — actively being set up

    # 1. SaaS tab: Column G (idx 6) = ODS Code, Column I (idx 8) = Status
    #    (Sheet was restructured 2026-05-15 — Status moved from G→I, ODS H→G.)
    #    Failsafe: the ODS cell is hand-typed and sheet edits have wiped it
    #    before (Fakenham, 2026-08-11) — rows with a Live/In-Progress status
    #    but no valid ODS fall back to a unique practice-name match against
    #    the NHS directory (plus VC_NAME_OVERRIDES) instead of being dropped.
    try:
        raw = fetch_csv(GSHEET_SAAS_URL)
        reader = csv.reader(io.StringIO(raw))
        next(reader, None)  # skip header

        def _norm(s):
            return "".join(c for c in (s or "").lower() if c.isalnum())
        norm_to_ods = {}
        try:
            with open(DATA_DIR / "practices_geocoded.json") as f:
                for p in json.load(f):
                    if "bcss" in (p.get("name") or "").lower():
                        continue
                    norm_to_ods.setdefault(_norm(p["name"]), []).append(p["ods"].upper())
        except Exception:
            pass

        name_matched = []
        for row in reader:
            ods = row[6].strip().upper() if len(row) > 6 else ""
            status = row[8].strip().lower() if len(row) > 8 else ""
            if not is_valid_ods(ods):
                if status not in ("live", "in progress"):
                    continue
                name = row[0].strip() if row else ""
                cands = ([VC_NAME_OVERRIDES[name.lower().strip()]]
                         if name.lower().strip() in VC_NAME_OVERRIDES
                         else norm_to_ods.get(_norm(name), []))
                if name and len(cands) == 1:
                    ods = cands[0]
                    name_matched.append(f"{name} -> {ods}")
                else:
                    print(f"  WARN: SaaS row '{name}' is {status} with no ODS and no unique name match — skipped")
                    continue
            if status == "live":
                sheet_live.add(ods)
            elif status == "in progress":
                sheet_onboarding.add(ods)
        if name_matched:
            print(f"  SaaS tab fallback: {len(name_matched)} row(s) without ODS matched by name: " + "; ".join(name_matched))
        print(f"  SaaS tab: {len(sheet_live)} live, {len(sheet_onboarding)} in-progress (onboarding)")
    except Exception as e:
        print(f"  WARN: Could not fetch SaaS tab: {e}")

    # 2. VC practices tab: practice qualifies as Live if EITHER
    #      Column K (idx 10) = Status == "Live"  OR
    #      Column L (idx 11) = Bloods automation == "Done"
    #    No ODS column — match practice names against practices_geocoded.json.
    #    `vc_done_ods` (Bloods=Done only) feeds live_customers_full_planner.json.
    try:
        raw = fetch_csv(GSHEET_VC_URL)
        reader = csv.reader(io.StringIO(raw))
        next(reader, None)  # skip header

        with open(DATA_DIR / "practices_geocoded.json") as f:
            practices = json.load(f)
        name_to_ods = {}
        for p in practices:
            name_to_ods[p["name"].lower().strip()] = p["ods"].upper()

        vc_done_ods = set()
        vc_status_live_ods = set()
        for row in reader:
            status = row[10].strip() if len(row) > 10 else ""
            bloods = row[11].strip() if len(row) > 11 else ""
            practice_name = row[0].strip() if row else ""
            is_status_live = status.lower() == "live"
            is_bloods_done = bloods.lower() == "done"
            if not practice_name or not (is_status_live or is_bloods_done):
                continue
            ods = resolve_vc_name(practice_name, name_to_ods)
            if ods and is_valid_ods(ods):
                sheet_live.add(ods)
                if is_bloods_done:
                    vc_done_ods.add(ods)
                if is_status_live:
                    vc_status_live_ods.add(ods)
        print(f"  VC tab: {len(vc_status_live_ods)} status=Live, {len(vc_done_ods)} bloods=Done")
    except Exception as e:
        print(f"  WARN: Could not fetch VC tab: {e}")
        vc_done_ods = set()

    print(f"  Total from sheets: {len(sheet_live)} live practices")

    # Load existing and merge
    live_path = DATA_DIR / "live_customers.json"
    with open(live_path) as f:
        existing = set(c.upper() for c in json.load(f))

    new_additions = sheet_live - existing
    merged = sorted(existing | sheet_live)

    if new_additions:
        print(f"  Adding {len(new_additions)} new live: {sorted(new_additions)}")
        with open(live_path, "w") as f:
            json.dump(merged, f, indent=2)
        # Update the global set so waitlist refresh excludes them
        LIVE_CUSTOMER_ODS = set(merged)
    else:
        print("  No new live practices from sheet.")

    # VC "Done" practices are Full Planner (all features incl. bloods)
    if vc_done_ods:
        fp_path = DATA_DIR / "live_customers_full_planner.json"
        with open(fp_path) as f:
            existing_fp = set(c.upper() for c in json.load(f))
        new_fp = vc_done_ods - existing_fp
        if new_fp:
            merged_fp = sorted(existing_fp | vc_done_ods)
            print(f"  Adding {len(new_fp)} new full-planner: {sorted(new_fp)}")
            with open(fp_path, "w") as f:
                json.dump(merged_fp, f, indent=2)

    # Write onboarding (In Progress) set as its own file so downstream tools
    # (push_to_sheets.py, build_merged_icb_xlsx.py) can expose it as a tier.
    # Excludes any ODS already in live_customers — a practice that's both
    # "In Progress" and "Live" in the sheet is effectively Live.
    onboarding_path = DATA_DIR / "onboarding_ods.json"
    onboarding_clean = sheet_onboarding - (set(merged) if sheet_live or new_additions else existing)
    if onboarding_clean or onboarding_path.exists():
        with open(onboarding_path, "w") as f:
            json.dump(sorted(onboarding_clean), f, indent=2)
        print(f"  Onboarding (In Progress, not yet Live): {len(onboarding_clean)} practices -> {onboarding_path.name}")


def refresh_practice_tiers():
    """
    Write public/data/practice_tiers.json — mapping ODS → pricing tier for
    the Planner Growth Dashboard. Additive; never edits live_customers.json.

    Tiers (see docs/planner_growth_dashboard.md):
      - "VC"          — appears in the VC tab (Virtual Clinic bundle, free Planner)
      - "Money-back"  — manually flagged in the SaaS tab (column J idx 9 = "Money-back")
      - "Freemium"    — default for any other Live/onboarding/waitlist practice (deprecated SaaS)

    No-one is on Money-back yet; the column is read so the user can re-classify
    in the sheet without a code change. Falls back gracefully on fetch errors —
    in that case, the existing tiers file is left untouched.
    """
    import csv
    import io

    def fetch_csv(url):
        req = urllib.request.Request(url, headers={"User-Agent": "SuveraRefreshBot/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8-sig")

    print("\n=== Refreshing Practice Tiers (Planner Growth Dashboard) ===")
    out_path = DATA_DIR / "practice_tiers.json"

    saas_tier_by_ods = {}  # ods -> "Freemium" | "Money-back"
    vc_ods = set()

    # SaaS tab: ODS col G (idx 6), optional Tier col J (idx 9). Anything
    # explicitly marked "Money-back" / "moneyback" wins; everything else is
    # Freemium by default.
    try:
        raw = fetch_csv(GSHEET_SAAS_URL)
        reader = csv.reader(io.StringIO(raw))
        next(reader, None)
        for row in reader:
            ods = row[6].strip().upper() if len(row) > 6 else ""
            tier_raw = row[9].strip().lower() if len(row) > 9 else ""
            if not is_valid_ods(ods):
                continue
            if tier_raw.replace(" ", "").replace("-", "") == "moneyback":
                saas_tier_by_ods[ods] = "Money-back"
            else:
                saas_tier_by_ods[ods] = "Freemium"
        print(f"  SaaS tab: {sum(1 for t in saas_tier_by_ods.values() if t == 'Freemium')} Freemium, "
              f"{sum(1 for t in saas_tier_by_ods.values() if t == 'Money-back')} Money-back")
    except Exception as e:
        print(f"  WARN: Could not fetch SaaS tab for tiers: {e}")

    # VC tab: practice name in col A; resolve to ODS via practices_geocoded
    try:
        raw = fetch_csv(GSHEET_VC_URL)
        reader = csv.reader(io.StringIO(raw))
        next(reader, None)
        with open(DATA_DIR / "practices_geocoded.json") as f:
            practices = json.load(f)
        name_to_ods = {p["name"].lower().strip(): p["ods"].upper() for p in practices}
        for row in reader:
            practice_name = row[0].strip() if row else ""
            if not practice_name:
                continue
            ods = resolve_vc_name(practice_name, name_to_ods)
            if ods and is_valid_ods(ods):
                vc_ods.add(ods)
        print(f"  VC tab: {len(vc_ods)} practices")
    except Exception as e:
        print(f"  WARN: Could not fetch VC tab for tiers: {e}")

    # Compose final tier map. VC wins over SaaS if a practice somehow appears
    # in both — Planner is genuinely free under the bundle.
    tier_map = dict(saas_tier_by_ods)
    for ods in vc_ods:
        tier_map[ods] = "VC"

    # Manual tier overrides (applied last, win over the sheet). The onboarding
    # sheet is read-only, so reclassifications the user makes verbally land here.
    #   G84023 Southborough Lane Surgery — listed on the VC tab but is actually
    #   a pure-SaaS Freemium Planner practice (confirmed by Will 2026-06-23).
    TIER_OVERRIDES = {"G84023": "Freemium"}
    tier_map.update(TIER_OVERRIDES)

    # Backfill: any Live/onboarding/waitlist ODS not seen in either tab gets
    # "Freemium" by default (user's stated preference — they re-classify manually).
    pipeline_ods = set()
    for fname in ("live_customers.json", "onboarding_ods.json", "waitlist_ods.json"):
        p = DATA_DIR / fname
        if p.exists():
            with open(p) as f:
                pipeline_ods |= set(c.upper() for c in json.load(f))
    for ods in pipeline_ods:
        tier_map.setdefault(ods, "Freemium")

    if not tier_map:
        print("  WARN: no tier data resolved — leaving practice_tiers.json untouched.")
        return

    # Safety: refuse to shrink by more than 20% (sheet outage protection)
    if out_path.exists():
        try:
            with open(out_path) as f:
                prev = json.load(f)
            if len(tier_map) < 0.8 * len(prev):
                print(f"  WARN: new tier map ({len(tier_map)}) is <80% of previous "
                      f"({len(prev)}) — refusing to write. Investigate before retrying.")
                return
        except Exception:
            pass

    with open(out_path, "w") as f:
        json.dump(dict(sorted(tier_map.items())), f, indent=2)
    breakdown = {}
    for t in tier_map.values():
        breakdown[t] = breakdown.get(t, 0) + 1
    print(f"  Wrote {out_path.name}: {len(tier_map)} practices · " +
          " · ".join(f"{n} {t}" for t, n in sorted(breakdown.items())))


def _flatten_month_total(by_ods_month_clinician: dict) -> dict:
    """Collapse the clinician dimension — keep just {ods: {month: total}}.
    Used for the recalls feed which has no clinician column."""
    out: dict = {}
    for ods, months_map in by_ods_month_clinician.items():
        out[ods] = {m: clinicians.get("_total", 0) for m, clinicians in months_map.items()}
    return out


def _fetch_breakdown(url, count_col, practice_col, label, months=None, clinician_col=None):
    """Fetch CSV, aggregate monthly + per-practice (+ optional per-clinician).

    `months` is a set of "YYYY-MM" strings; defaults to {current month}.

    Returns (monthly_totals, grand_total, practices_by_month, by_ods_month_clinician)
    where:
      - practices_by_month: {month: [{name, count, ods}, ...]}
      - by_ods_month_clinician: {ods: {month: {clinician|"_total": count}}}
        — clinician dimension only populated if clinician_col is set.
        — "_total" key always present for month totals across clinicians.
    """
    import csv
    import io
    from collections import defaultdict
    from datetime import datetime as _dt
    from datetime import timedelta as _td
    # `url` may be a single URL, or a list of (url, lo_month, hi_month) sources
    # spliced together — rows are kept when lo <= month < hi (None = open end).
    # Any source failing aborts the whole feed so a partial fetch can't
    # masquerade as "recalls dropped to zero".
    sources = url if isinstance(url, list) else [(url, None, None)]
    src_rows = []
    for src_url, lo, hi in sources:
        try:
            req = urllib.request.Request(src_url, headers={"User-Agent": "SuveraRefreshBot/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8-sig")
        except Exception as e:
            print(f"  WARN: Could not fetch {label} sheet: {e}")
            return {}, 0, {}, {}, {}, False
        reader = csv.reader(io.StringIO(raw))
        next(reader, None)
        for row in reader:
            m = row[0].strip()[:7] if row else ""
            if lo is not None and m < lo:
                continue
            if hi is not None and m >= hi:
                continue
            src_rows.append(row)

    if months is None:
        months = {_dt.now().strftime("%Y-%m")}
    monthly = {}
    total = 0
    by_month_practice = defaultdict(lambda: defaultdict(int))  # month -> {pname: count}
    # Per-practice, per-month, per-clinician (Full Name) detail. Used by the
    # Planner Growth Dashboard to show "who did the recalls / forms".
    by_pname_month_clinician = defaultdict(  # pname
        lambda: defaultdict(lambda: defaultdict(int))  # month -> clinician -> count
    )
    # Per-practice, per-WEEK (Monday-of-week) totals — for the optional weekly
    # toggle. has_daily flips True only if the feed has sub-monthly dates (the
    # current Omni sheet is monthly, so this stays False until a daily feed is wired).
    by_pname_week = defaultdict(lambda: defaultdict(int))  # pname -> weekStart(YYYY-MM-DD) -> count
    has_daily = False
    for row in src_rows:
        if len(row) <= count_col:
            continue
        month = row[0].strip()[:7]
        try:
            count = int(row[count_col].strip())
        except ValueError:
            continue
        monthly[month] = monthly.get(month, 0) + count
        total += count
        if month in months and len(row) > practice_col:
            pname = row[practice_col].strip()
            if pname:
                by_month_practice[month][pname] += count
                # weekly bucket (Monday-of-week) from the full date, if present
                ds = row[0].strip()[:10]
                if len(ds) == 10 and ds[8:10] != "01":
                    has_daily = True
                try:
                    _dd = _dt.strptime(ds, "%Y-%m-%d")
                    _wk = (_dd - _td(days=_dd.weekday())).strftime("%Y-%m-%d")
                    by_pname_week[pname][_wk] += count
                except ValueError:
                    pass
                # capture clinician detail across FY (not just current-month);
                # we keep all FY months here regardless of `months` filter
                # because the drilldown wants full history.
                clinician = ""
                if clinician_col is not None and len(row) > clinician_col:
                    clinician = row[clinician_col].strip() or "(unknown)"
                if clinician:
                    by_pname_month_clinician[pname][month][clinician] += count
                by_pname_month_clinician[pname][month]["_total"] = \
                    by_pname_month_clinician[pname][month].get("_total", 0) + count

    # Match practice names to ODS codes via geocoded practices
    with open(DATA_DIR / "practices_geocoded.json") as f:
        practices = json.load(f)
    name_to_ods = {p["name"].lower().strip(): p["ods"].upper() for p in practices}

    def _lookup(pname):
        lower = pname.lower().strip()
        if lower in VC_NAME_OVERRIDES:
            return VC_NAME_OVERRIDES[lower]
        if lower in name_to_ods:
            return name_to_ods[lower]
        for full_name, code in name_to_ods.items():
            if lower in full_name or full_name in lower:
                return code
        return None

    practices_by_month = {}
    for m in months:
        rows = sorted(by_month_practice.get(m, {}).items(), key=lambda x: -x[1])
        practices_by_month[m] = [
            {"name": pname, "count": cnt, "ods": _lookup(pname)} for pname, cnt in rows
        ]

    # Re-key the per-clinician detail by ODS (so the dashboard can look it up directly)
    by_ods_month_clinician: dict = {}
    for pname, months_map in by_pname_month_clinician.items():
        ods = _lookup(pname)
        if not ods:
            continue
        dest = by_ods_month_clinician.setdefault(ods, {})
        for m, clinicians in months_map.items():
            dest_m = dest.setdefault(m, {})
            for clin, cnt in clinicians.items():
                dest_m[clin] = dest_m.get(clin, 0) + cnt

    # Re-key weekly totals by ODS
    by_ods_week: dict = {}
    for pname, wkmap in by_pname_week.items():
        ods = _lookup(pname)
        if not ods:
            continue
        dest = by_ods_week.setdefault(ods, {})
        for wk, cnt in wkmap.items():
            dest[wk] = dest.get(wk, 0) + cnt

    total_active = sum(len(v) for v in practices_by_month.values())
    print(f"  {label}: {total} total, {total_active} active across {sorted(months)}"
          f"{' · daily granularity' if has_daily else ' · monthly only'}")
    return monthly, total, practices_by_month, by_ods_month_clinician, by_ods_week, has_daily


def refresh_patient_sizes():
    """Refresh per-practice patient list sizes from NHS Digital's monthly CSV.

    Source: NHS Digital "Patients Registered at a GP Practice" publication.
    Stable landing URL + stable CSV filename; only the CDN hash rotates monthly.
    Cached on disk for 24h to avoid needless scraping during the 5-min refresh
    loop (list sizes only update monthly anyway).

    Merges into practices_geocoded.json. Never overwrites with 0 — if the NHS
    file omits a practice, we keep whatever patient count was there previously.
    """
    print("\n=== Fetching Patient List Sizes (NHS Digital) ===")
    try:
        from patient_list_sizes import fetch_list_sizes, apply_to_practices, PatientListError
    except ImportError as e:
        print(f"  WARN: patient_list_sizes module unavailable: {e}")
        return

    try:
        sizes = fetch_list_sizes()
    except PatientListError as e:
        print(f"  WARN: could not fetch list sizes ({e}). Keeping existing values.")
        return

    practices_path = DATA_DIR / "practices_geocoded.json"
    with open(practices_path) as f:
        practices = json.load(f)

    pre_nonzero = sum(1 for p in practices if p.get("patients"))
    updated, missing = apply_to_practices(practices, sizes)
    post_nonzero = sum(1 for p in practices if p.get("patients"))

    print(f"  NHS file practices: {len(sizes):,}")
    print(f"  Updated: {updated:,}  |  Missing from NHS file: {len(missing):,}")
    print(f"  Practices with patients>0:  {pre_nonzero:,} -> {post_nonzero:,}")

    with open(practices_path, "w") as f:
        json.dump(practices, f)


def refresh_pcn_icb():
    """Overwrite pcn_name/pcn_code/icb in practices_geocoded.json from the
    live ODS ePCN report (24h disk cache in ods_pcn.py — cheap on the 5-min
    cron, same pattern as refresh_patient_sizes).

    The legacy static fields came from an old name-based join, so ~1,600
    practices carried another same-named practice's ICB (e.g. Westgate
    Surgery B86029 in Otley wearing the Kent Westgate's Kent & Medway ICB)
    and pre-merger ICB names. Practices absent from the ePCN report (no
    current PCN membership) keep their existing fields — stale beats blank.
    """
    from ods_pcn import OdsPcnError, fetch_pcn_membership, icb_from_sicbl_name  # noqa: F401

    def _display_pcn(name):
        keep = {"PCN", "NHS", "ICB", "GP"}
        return " ".join(
            w if w.upper() in keep else (w[:1].upper() + w[1:].lower())
            for w in name.split()
        )

    try:
        mapping = fetch_pcn_membership()
    except OdsPcnError as e:
        print(f"  WARN: ePCN fetch failed, keeping existing PCN/ICB fields: {e}")
        return

    practices_path = DATA_DIR / "practices_geocoded.json"
    with open(practices_path) as f:
        practices = json.load(f)

    changed = 0
    for p in practices:
        m = mapping.get(p["ods"].upper())
        if not m:
            continue
        new = {
            "pcn_code": m["pcn_code"],
            "pcn_name": _display_pcn(m["pcn_name"]),
            "icb": m["icb"],
        }
        if any(p.get(k) != v for k, v in new.items()):
            p.update(new)
            changed += 1

    if changed:
        with open(practices_path, "w") as f:
            json.dump(practices, f)
        print(f"  PCN/ICB refreshed from ODS ePCN: {changed} practices updated")
    else:
        print("  PCN/ICB already current with ODS ePCN")


def refresh_paid_customers():
    """Sync paid_customers.json (map's Gold tier) from HubSpot.

    A paying customer is a Planner deal renamed to "PAID - <practice> - …";
    the ODS comes from the deal's associated company (practice_code /
    ods_unique). Replaces the old hand-maintained list — rename a deal in
    HubSpot and the next 5-min refresh turns the practice gold on the map.

    Safety: any HubSpot error, or an empty result when the previous file was
    non-empty, leaves the existing file untouched.
    """
    print("\n=== Refreshing Paid Customers (HubSpot PAID deals) ===")
    out_path = DATA_DIR / "paid_customers.json"
    paid_re = re.compile(r"^\s*PAID\b[\s\-–—:]*", re.IGNORECASE)

    try:
        # CONTAINS_TOKEN "PAID" over-matches (any deal with the word paid);
        # the prefix regex below is the real filter.
        resp = hubspot_request("POST", "/crm/v3/objects/deals/search", {
            "filterGroups": [{"filters": [
                {"propertyName": "dealname", "operator": "CONTAINS_TOKEN", "value": "PAID"},
            ]}],
            "properties": ["dealname"],
            "limit": 100,
        })
        deals = [d for d in resp.get("results", [])
                 if paid_re.match(d.get("properties", {}).get("dealname") or "")]
        print(f"  PAID-prefixed deals: {len(deals)}")

        paid_ods = set()
        for d in deals:
            assoc = hubspot_request("GET", f"/crm/v4/objects/deals/{d['id']}/associations/companies")
            for a in assoc.get("results", []):
                comp = hubspot_request(
                    "GET",
                    f"/crm/v3/objects/companies/{a['toObjectId']}?properties=practice_code,ods_unique,name")
                p = comp.get("properties", {})
                ods = (p.get("practice_code") or p.get("ods_unique") or "").strip().upper()
                if is_valid_ods(ods):
                    paid_ods.add(ods)
                    break
            else:
                print(f"  WARN: no ODS resolved for deal "
                      f"'{d.get('properties', {}).get('dealname')}' — not in paid set")
    except SystemExit:
        raise
    except Exception as e:
        print(f"  WARN: HubSpot paid-deal fetch failed ({e}); keeping existing {out_path.name}")
        return

    previous = set()
    if out_path.exists():
        try:
            with open(out_path) as f:
                previous = set(json.load(f))
        except Exception:
            pass
    if not paid_ods and previous:
        print("  WARN: PAID search returned nothing but previous file was non-empty — keeping it.")
        return

    with open(out_path, "w") as f:
        json.dump(sorted(paid_ods), f, indent=1)
    added, removed = sorted(paid_ods - previous), sorted(previous - paid_ods)
    print(f"  paid customers: {len(paid_ods)}"
          + (f" · added {added}" if added else "")
          + (f" · removed {removed}" if removed else ""))


def refresh_recalls():
    """Fetch recall + bloods data from Omni exports and save as JSON.

    Two activity sets are written:
      - `active_ods_this_month` : current calendar month only. Used by the
        dashboard map's "actively recalling now" flashing indicator.
      - `active_ods_recent` : current month + previous month (rolling
        2-month window). Used by the expansion hitlist anchor set, so
        practices that batch recalls monthly still register as active.
    """
    from datetime import datetime as _dt
    from datetime import date as _date
    from datetime import timedelta as _td

    print("\n=== Fetching Omni Data (Recalls + Bloods) ===")

    now = _dt.now()
    this_month = now.strftime("%Y-%m")
    prev_month = (now.replace(day=1) - _td(days=1)).strftime("%Y-%m")

    # FY months: April 1 (current FY) through today inclusive.
    # The Planner Growth Dashboard reads `fy_by_practice` (added below) to
    # produce per-practice FY-to-date recalls/forms.
    fy_start_year = now.year if now.month >= 4 else now.year - 1
    fy_months: set[str] = set()
    y, m = fy_start_year, 4
    while (y, m) <= (now.year, now.month):
        fy_months.add(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    # Always include prev_month even if it predates FY start (rolling 2-month set).
    months = fy_months | {this_month, prev_month}

    # Recalls feed: no clinician column. Spliced from two sheets — the frozen
    # monthly archive (pre-Jun 2026) + the live per-day Omni delivery.
    # Bloods feed: clinician = column 3 ("Full Name").
    r_monthly, r_total, r_practices_by_month, r_by_ods_month_clinician, r_by_ods_week, r_daily = _fetch_breakdown(
        [(GSHEET_RECALLS_URL, None, RECALLS_CUTOVER),
         (GSHEET_RECALLS_DAILY_URL, RECALLS_CUTOVER, None)],
        2, 1, "Recalls", months=months)
    b_monthly, b_total, b_practices_by_month, b_by_ods_month_clinician, b_by_ods_week, b_daily = _fetch_breakdown(
        GSHEET_BLOODS_URL, 4, 1, "Bloods", months=months, clinician_col=3)

    r_practices_this = r_practices_by_month.get(this_month, [])
    b_practices_this = b_practices_by_month.get(this_month, [])

    # Current-month active set (dashboard flashing indicator)
    active_ods_this_month = set()
    for p in r_practices_this + b_practices_this:
        if p["ods"]:
            active_ods_this_month.add(p["ods"])

    # Rolling 2-month active set (hitlist anchor pool)
    active_ods_recent = set()
    for month_entries in list(r_practices_by_month.values()) + list(b_practices_by_month.values()):
        for p in month_entries:
            if p["ods"]:
                active_ods_recent.add(p["ods"])

    # FY-to-date per practice: sum across FY months. Shape:
    #   {ods: {"fy_to_date": int, "this_month": int}}
    def _fy_by_practice(practices_by_month: dict) -> dict:
        out: dict[str, dict[str, int]] = {}
        for month, rows in practices_by_month.items():
            if month not in fy_months:
                continue
            for r in rows:
                ods = r.get("ods")
                if not ods:
                    continue
                bucket = out.setdefault(ods, {"fy_to_date": 0, "this_month": 0})
                bucket["fy_to_date"] += r.get("count") or 0
                if month == this_month:
                    bucket["this_month"] += r.get("count") or 0
        return dict(sorted(out.items()))

    r_fy_by_practice = _fy_by_practice(r_practices_by_month)
    b_fy_by_practice = _fy_by_practice(b_practices_by_month)
    print(f"  FY-by-practice — recalls: {len(r_fy_by_practice)} practices · "
          f"bloods: {len(b_fy_by_practice)} practices")

    data = {
        "recalls": {
            "total": r_total,
            "monthly": {m: r_monthly[m] for m in sorted(r_monthly)},
            "practices_this_month": r_practices_this,
            "fy_by_practice": r_fy_by_practice,
            # Per-practice, per-month detail (no clinician dim for recalls feed)
            "by_ods_month": _flatten_month_total(r_by_ods_month_clinician),
            "by_ods_week": r_by_ods_week,
        },
        "bloods": {
            "total": b_total,
            "monthly": {m: b_monthly[m] for m in sorted(b_monthly)},
            "practices_this_month": b_practices_this,
            "fy_by_practice": b_fy_by_practice,
            # Per-practice, per-month, per-clinician (bloods has Full Name col)
            "by_ods_month_clinician": b_by_ods_month_clinician,
            "by_ods_week": b_by_ods_week,
        },
        # True only when the source feed has sub-monthly dates → enables the weekly toggle.
        "weekly_available": bool(r_daily or b_daily),
        "active_ods_this_month": sorted(active_ods_this_month),
        "active_ods_recent": sorted(active_ods_recent),
    }

    output_path = DATA_DIR / "recalls.json"
    # Feed-failure guard: _fetch_breakdown returns an empty dict when any
    # source fetch fails. Writing that would zero out the map's recall history,
    # so keep the existing file instead — stale beats blank.
    if not r_monthly and output_path.exists():
        print("  WARN: recalls feed empty — keeping existing recalls.json untouched.")
        return
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)


# ============================================================
# Main
# ============================================================

def main():
    load_env()
    start = time.time()

    mode = sys.argv[1] if len(sys.argv) > 1 else "--all"

    # Standalone: just refresh Planner Growth Dashboard's tier map and exit.
    if mode == "--tiers":
        refresh_practice_tiers()
        return

    # Standalone: regenerate recalls.json only (Omni published CSVs + name
    # overrides; no HubSpot). Fast — used to re-pin recall name→ODS mappings.
    if mode == "--recalls":
        refresh_recalls()
        return

    if mode in ("--all", "--practices"):
        refresh_practices()

    # Patient list sizes: cheap after the first run (24h disk cache), so safe
    # to call on every mode including --waitlist.
    if mode in ("--all", "--practices", "--waitlist"):
        refresh_patient_sizes()
        # PCN + ICB from the live ODS ePCN report (also 24h-cached) — the
        # legacy static fields mis-assign ~1,600 practices (name-join bug).
        refresh_pcn_icb()

    # Check Google Sheet for new live practices BEFORE waitlist refresh,
    # so any newly-live practices are excluded from the waitlist.
    refresh_live_from_google_sheet()

    # Planner Growth Dashboard tier map — additive only, writes its own file.
    # Gated to --all so the 5-min --waitlist cron isn't slowed by an extra fetch.
    if mode == "--all":
        refresh_practice_tiers()

    if mode in ("--all", "--waitlist"):
        refresh_waitlist()
        # Gold tier on the map: deals renamed "PAID - …" in HubSpot.
        refresh_paid_customers()

    refresh_recalls()

    elapsed = time.time() - start
    print(f"\n=== Completed in {elapsed:.0f}s ===")


if __name__ == "__main__":
    main()
