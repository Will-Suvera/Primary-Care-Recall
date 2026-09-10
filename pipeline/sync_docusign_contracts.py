#!/usr/bin/env python3
"""Import signed DocuSign contracts, attach to HubSpot and Notion.

For every newly COMPLETED DocuSign envelope: download the signed PDF, parse
Schedule 1 (customer, ODS code, covered practices), attach the PDF as a note
on the matching HubSpot deal and to the "Contract" files property of every
covered Recall Practices row in Notion (setting "Contract Signed" too).

The contract is treated as ground truth for WHICH practices a deal covers —
either Schedule 1's register line ("21,978 (The Pall Mall Surgery), 15,583
(Highlands Surgery)") or, for PCN master agreements, the "Initial Practices"
definition. The covered ODS codes are written to the deal's "Contract practices
(ODS)" property (contract_practices_ods), which sync_notion_recall_practices.py
then uses to decide which Recall Practices rows to create — so a PCN deal only
ever produces rows for the practices that actually signed.

Dedupe is stateless: the HubSpot file is named contract_<envelopeId>.pdf; if
it already exists the envelope is skipped.

Env: DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_PRIVATE_KEY (or
DOCUSIGN_PRIVATE_KEY_FILE), DOCUSIGN_AUTH_SERVER (account-d.docusign.com for
sandbox, account.docusign.com once live), HUBSPOT_API_TOKEN, NOTION_API_TOKEN.

Each signed contract also becomes a row on the finance tracker (Google Sheet
"Primary/Recall Contracts", tab API/WG — same 13 headers as the head of
finance's manual tab): legal name, commencement, term, price per patient,
register, ARR and the finance formulas for monthly / first-invoice values.
Auth: GOOGLE_SHEETS_SA_JSON (service-account JSON) or the repo-root key file.

Modes:
  (default)                 poll DocuSign for envelopes completed in the last 30 days (--days N)
  --file X.pdf --envelope-id ID [--signed YYYY-MM-DD]   process a local PDF (testing / backfill)
  --sheet-only              with --file: only write the finance-sheet row
  --dry-run                 parse + report, change nothing
"""
import base64
import json
import os
import re
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync_notion_recall_practices import (  # noqa: E402
    _request, hs, notion, norm_name, load_enrichment, GEOCODED,
    NOTION_DB_ID, fetch_practice_rows, PIPELINE_ID, create_practice_page,
    _copy_blocks, NOTION_TEMPLATE_PAGE)

HUBSPOT_PORTAL = "143576889"
DRIVE_PARENT = "1M8tBbnYdgVDHtKuFrmhDy1dz0II6sCZF"  # T&C Contracts / 2. Signed Contracts (Partners)

CS_PIPELINE_ID = "2391616730"
SUVERA_ODS = {"R7U1N"}  # Suvera's own code appears in every DPA — never a customer
ODS_RE = re.compile(r"\b[A-Z]\d[0-9A-Z]{4,5}\b")

FINANCE_SHEET_ID = "1js7pGfDnyOdyq5fRPetXflEAx94SUmnltkfO-lAvOSc"  # Primary/Recall Contracts
FINANCE_TAB = "API/WG"
FINANCE_HEADERS = ["Legal name", "Commencement date", "1st Revenue Month", "Expected go-live date",
                   "Years (initial term)", "Price per patient (exc VAT)", "Monthly price (exc VAT)",
                   "1st invoice value (signed → go-live, roundup)", "ARR", "Y1 price (exc VAT)",
                   "Y2 price (exc VAT)", "Register size", "Notes", "Contract PDF"]

DS_AUTH = os.environ.get("DOCUSIGN_AUTH_SERVER", "account-d.docusign.com")


def docusign_url(envelope_id):
    if not re.fullmatch(r"[0-9A-Fa-f-]{36}", envelope_id or ""):
        return ""  # backfilled from a Drive copy / manual id: no envelope to link
    host = "apps-d.docusign.com" if DS_AUTH.startswith("account-d") else "app.docusign.com"
    return f"https://{host}/documents/details/{envelope_id}"


def hubspot_deal_url(deal_id):
    return f"https://app-eu1.hubspot.com/contacts/{HUBSPOT_PORTAL}/record/0-3/{deal_id}"
DS_KEY = os.environ.get("DOCUSIGN_INTEGRATION_KEY", "")
DS_USER = os.environ.get("DOCUSIGN_USER_ID", "")


def _ds_private_key():
    pem = os.environ.get("DOCUSIGN_PRIVATE_KEY", "")
    if not pem:
        f = os.environ.get("DOCUSIGN_PRIVATE_KEY_FILE",
                           str(Path(__file__).parent / ".docusign_key.pem"))
        pem = Path(f).read_text()
    return pem.encode()


# ---------- DocuSign JWT auth + envelope access ----------

def _b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=")


def ds_token():
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64url(json.dumps({
        "iss": DS_KEY, "sub": DS_USER, "aud": DS_AUTH,
        "iat": now, "exp": now + 3600, "scope": "signature impersonation"}).encode())
    signing_input = header + b"." + claims
    key = serialization.load_pem_private_key(_ds_private_key(), password=None)
    sig = _b64url(key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256()))
    jwt = (signing_input + b"." + sig).decode()
    body = f"grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}"
    req = urllib.request.Request(f"https://{DS_AUTH}/oauth/token", data=body.encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["access_token"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        if "consent_required" in detail:
            sys.exit("DocuSign consent not yet granted — open:\n"
                     f"https://{DS_AUTH}/oauth/auth?response_type=code"
                     f"&scope=signature%20impersonation&client_id={DS_KEY}"
                     "&redirect_uri=https://localhost")
        raise RuntimeError(f"DocuSign token request failed ({e.code}): {detail}") from e


def ds_account(token):
    info = _request(f"https://{DS_AUTH}/oauth/userinfo", "GET",
                    headers={"Authorization": f"Bearer {token}"})
    acct = next((a for a in info["accounts"] if a.get("is_default")), info["accounts"][0])
    return acct["account_id"], acct["base_uri"]


def ds_completed_envelopes(token, acct, base, days=30):
    frm = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    r = _request(f"{base}/restapi/v2.1/accounts/{acct}/envelopes"
                 f"?from_date={frm}&status=completed", "GET",
                 headers={"Authorization": f"Bearer {token}"})
    return r.get("envelopes", [])


def ds_download_pdf(token, acct, base, envelope_id):
    req = urllib.request.Request(
        f"{base}/restapi/v2.1/accounts/{acct}/envelopes/{envelope_id}/documents/combined",
        headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


# ---------- contract parsing ----------

def parse_contract(pdf_bytes):
    """Extract Schedule 1 facts from the signed MSA/DPA PDF."""
    from pypdf import PdfReader
    import io
    text = " ".join((pg.extract_text() or "") for pg in PdfReader(io.BytesIO(pdf_bytes)).pages)
    text = re.sub(r"[\ue000-\uf8ff]", "", text)  # private-use glyphs the PDF fonts leave behind
    text = re.sub(r"\s+", " ", text)
    out = {"customer": "", "ods_codes": [], "practices": [], "commencement": "",
           "term_months": None, "price_y1": None, "price_y2": None, "register": None,
           "annual_fee": None, "annual_fee_y2": None, "sms_included": None}
    m = re.search(r"Customer Details\s+Customer\s+(.+?)\s+Customer Address", text)
    if m:
        out["customer"] = m.group(1).strip()
    # ---- commercial terms (best effort; blanks are filled by finance by hand) ----
    sched = text[text.find("Customer Details"):] if "Customer Details" in text else text
    m = re.search(r"Commencement Date\s+(.*?)\s*(?:Initial Term|Practice Register|Register Size|Contact for|"
                  r"Clinical systems|Annual Fee|Suvera Service|Fees|SIGNED)", sched)
    if m:
        v = m.group(1).strip()
        out["commencement"] = "" if ("@" in v or not v) else v[:160]  # a mis-keyed email is not a date
    m = (re.search(r"[Ii]nitial [Tt]erm (?:of|is) (\d+) months", text)
         or re.search(r"Initial Term\s+(\d+) months", text)
         or re.search(r"[Ii]nitial [Tt]erm (?:of|is) (\d+) years?", text))
    if m:
        n = int(m.group(1))
        out["term_months"] = n * 12 if "year" in m.group(0) else n
    # "£0.60 + VAT Y1 & £0.65 + VAT Y2 per patient" / "£0.75 + VAT per patient" /
    # "£ 0.75 0.55 VAT per patient" (struck-through list price, then the agreed one)
    m = re.search(r"£\s?(\d\.\d{2,4})\s*\+?\s*VAT\s*Y1\s*&\s*£\s?(\d\.\d{2,4})\s*\+?\s*VAT\s*Y2", text)
    if m:
        out["price_y1"], out["price_y2"] = float(m.group(1)), float(m.group(2))
    else:
        m = re.search(r"£[^£]{0,30}?(\d\.\d{2,4})\s*(?:\+\s*)?VAT\s*per patient", text)
        if m:
            out["price_y1"] = float(m.group(1))
        m = re.search(r"(?:Year 2|second (?:Contract )?[Yy]ear|Y2|from the second)[^£]{0,80}£\s?(\d\.\d{2,4})", text)
        if m:
            out["price_y2"] = float(m.group(1))
    m = (re.search(r"combined register of\s*([\d,]{4,})", text)
         or re.search(r"([\d,]{4,})\s*total", text)
         or re.search(r"Register Size[^\d]{0,80}([\d,]{4,})", text))
    if m:
        out["register"] = int(m.group(1).replace(",", ""))
    m = re.search(r"(?:Annual Fee|an indicative)[^£]{0,60}£\s?([\d,]+(?:\.\d+)?)"
                  r"(?:\s*(?:Y1|year 1)\s*,\s*£\s?([\d,]+(?:\.\d+)?)\s*(?:Y2|year 2))?", text)
    if m:
        out["annual_fee"] = float(m.group(1).replace(",", ""))
        if m.group(2):
            out["annual_fee_y2"] = float(m.group(2).replace(",", ""))
    if re.search(r"SMS", text):
        out["sms_included"] = bool(re.search(r"(?:unlimited[^.]{0,40}SMS|SMS[^.]{0,60}included)", text, re.I))
    out["ods_codes"] = [c for c in dict.fromkeys(ODS_RE.findall(text)) if c not in SUVERA_ODS]
    # register line: "21,978 (The Pall Mall Surgery), 15,583 (Highlands Surgery) 37,561 total"
    m = re.search(r"Register Size.*?Date\s*\)\s*(.+?)(?:Annual Fee|SIGNED)", text)
    if m:
        out["practices"] = [{"list_size": int(n.replace(",", "")), "name": p.strip()}
                            for n, p in re.findall(r"([\d,]+)\s*\(([^)]+)\)", m.group(1))
                            if not re.search(r"\btotal\b", p, re.I)]
    # PCN master agreement: '"Initial Practices" means Oak Vale Medical Practice,
    # West Derby Medical Centre and Rock Court Surgery.' Other members join later
    # under a Joining Schedule (Schedule 3), each a separate signed envelope.
    if not out["practices"]:
        m = re.search(r"[\"\u201c]Initial Practices[\"\u201d]\s+means\s+(.+?)\.\s", text)
        if m:
            out["practices"] = [{"list_size": None, "name": n.strip()}
                                for n in re.split(r",\s*|\s+and\s+", m.group(1)) if n.strip()]
    if not out["practices"]:
        m = re.search(r"Joining Schedule.*?Participating Practice\s*:?\s*(.+?)\s+(?:ODS|Practice )?Code", text)
        if m:
            out["practices"] = [{"list_size": None, "name": m.group(1).strip()}]
    return out


def resolve_covered_ods(parsed, enrich):
    """The set of practice ODS codes the contract covers. Explicit codes win;
    practices named in the register line are resolved by name WITHIN the PCN
    membership of the contract's own ODS code — a closed, safe search space."""
    covered = {c for c in parsed["ods_codes"] if c in enrich}
    pcn_codes = {enrich[c]["pcn_code"] for c in covered if enrich[c].get("pcn_code")}
    # a PCN's own U-code in the contract scopes the name search to its members
    all_pcn = {p.get("pcn_code") for p in enrich.values() if p.get("pcn_code")}
    pcn_codes |= {c for c in parsed["ods_codes"] if c in all_pcn}
    members = {ods: p for ods, p in enrich.items() if p.get("pcn_code") in pcn_codes}
    for pr in parsed["practices"]:
        n = norm_name(pr["name"])
        hits = [ods for ods, p in members.items() if norm_name(p["name"]) == n]
        if len(hits) == 1:
            covered.add(hits[0])
        else:
            print(f"  WARN: couldn't resolve covered practice '{pr['name']}' "
                  f"({'ambiguous' if hits else 'no match in PCN'})")
    return covered


# ---------- HubSpot attach ----------

def _multipart(fields, file_field, filename, content, ctype="application/pdf"):
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; "
             f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    body += content + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def hubspot_has_file(name):
    """Deterministic existence check by path — the files SEARCH index lags
    uploads by minutes and must never gate dedupe."""
    try:
        hs("GET", f"/files/v3/files/stat/contracts/{name}")
        return True
    except RuntimeError as e:
        msg = str(e)
        if "MISSING_SCOPES" in msg:
            print("  WARN: HubSpot token lacks the Files scope — can't check/upload files")
            return False
        if "-> 404" in msg:
            return False
        raise


def find_deal(parsed, covered):
    """The HubSpot deal this contract belongs to: prefer a deal on the company
    named as Customer (the PCN itself for a master agreement), then a covered
    practice's deal; Planner pipeline before Client Success; newest first.
    Returns (deal_id, deal_name, contract_practices_ods) or (None, None, "")."""
    # the Customer company: matched by the contract's own ODS code(s) (a PCN's
    # U-code sits in the company's ods_unique) and, as a fallback, by name
    groups = [{"filters": [{"propertyName": p, "operator": "IN", "values": parsed["ods_codes"]}]}
              for p in ("ods_unique", "practice_code")] if parsed["ods_codes"] else []
    if parsed["customer"]:
        groups.append({"filters": [{"propertyName": "name", "operator": "EQ",
                                    "value": parsed["customer"]}]})
    cust_comp_ids = set()
    if groups:
        r = hs("POST", "/crm/v3/objects/companies/search", {"filterGroups": groups, "limit": 20})
        cust_comp_ids = {str(c["id"]) for c in r.get("results", [])}
    comp_ids = set(cust_comp_ids)
    if covered:
        r = hs("POST", "/crm/v3/objects/companies/search",
               {"filterGroups": [{"filters": [{"propertyName": p, "operator": "IN",
                                               "values": sorted(covered)}]}
                                 for p in ("ods_unique", "practice_code")], "limit": 100})
        comp_ids |= {str(c["id"]) for c in r.get("results", [])}
    deal_company = {}
    for cid in comp_ids:
        a = hs("GET", f"/crm/v4/objects/companies/{cid}/associations/deals")
        for t in a.get("results", []):
            deal_company.setdefault(str(t["toObjectId"]), cid)
    if not deal_company:
        return None, None, "", None
    dr = hs("POST", "/crm/v3/objects/deals/batch/read",
            {"properties": ["dealname", "pipeline", "hs_lastmodifieddate", "contract_practices_ods"],
             "inputs": [{"id": x} for x in deal_company]})
    cands = [d for d in dr.get("results", [])
             if d["properties"].get("pipeline") in (PIPELINE_ID, CS_PIPELINE_ID)]
    if not cands:
        return None, None, "", None
    cust = norm_name(re.sub(r"\bpcn\b", "", parsed["customer"] or "", flags=re.I))
    def named_for_customer(d):  # "PAID - iGPc PCN" is the PCN's deal; "Oak Vale - Planner" is a member's
        return bool(cust) and cust in norm_name(re.sub(r"\bpcn\b", "", d["properties"].get("dealname") or "", flags=re.I))
    cands.sort(key=lambda d: d["properties"].get("hs_lastmodifieddate") or "", reverse=True)
    cands.sort(key=lambda d: (deal_company[str(d["id"])] not in cust_comp_ids,
                              not named_for_customer(d),
                              d["properties"]["pipeline"] != PIPELINE_ID))  # stable: newest first within
    best = cands[0]
    return (str(best["id"]), best["properties"].get("dealname"),
            best["properties"].get("contract_practices_ods") or "", deal_company[str(best["id"])])


def hubspot_record_covered(deal_id, deal_name, existing, covered, dry_run):
    """Write the covered ODS codes to the deal's "Contract practices (ODS)" —
    a union with what's there, so a later Joining Schedule adds a practice."""
    if not deal_id or not covered:
        return
    have = {c.strip().upper() for c in re.split(r"[,\s]+", existing) if c.strip()}
    merged = sorted(have | set(covered))
    if merged == sorted(have):
        return
    if dry_run:
        print(f"  DRY RUN HubSpot: would set contract_practices_ods={merged} on deal '{deal_name}'")
        return
    hs("PATCH", f"/crm/v3/objects/deals/{deal_id}",
       {"properties": {"contract_practices_ods": ", ".join(merged)}})
    print(f"  HubSpot: contract_practices_ods={merged} on deal '{deal_name}'")


def hubspot_attach(pdf, envelope_id, parsed, covered, deal_id, deal_name, company_id, links, dry_run):
    name = f"contract_{envelope_id}"
    if dry_run:
        print(f"  DRY RUN HubSpot: would upload {name}.pdf and attach to deal "
              f"{deal_name or 'NOT FOUND'} + company {company_id or 'NOT FOUND'}")
        return
    body, ctype = _multipart({"options": json.dumps({"access": "PRIVATE"}),
                              "folderPath": "/contracts"},
                             "file", f"{name}.pdf", pdf)
    up = _request("https://api-eu1.hubapi.com/files/v3/files", "POST", None,
                  headers={"Authorization": f"Bearer {os.environ['HUBSPOT_API_TOKEN']}",
                           "Content-Type": ctype}, raw_body=body)
    file_id = up["id"]
    body_html = (f"<p><b>Signed contract</b> — {parsed['customer'] or 'customer'} "
                 f"(DocuSign envelope {envelope_id}), attached by contract sync.</p><ul>"
                 + "".join(f'<li><a href="{u}">{label}</a></li>' for label, u in links if u) + "</ul>")
    targets = [(deal_id, 214, f"deal '{deal_name}'"), (company_id, 190, f"company {company_id}")]
    done = []
    for obj_id, assoc_type, label in targets:
        if not obj_id:
            continue
        hs("POST", "/crm/v3/objects/notes", {
            "properties": {"hs_timestamp": datetime.now(timezone.utc).isoformat(),
                           "hs_note_body": body_html, "hs_attachment_ids": str(file_id)},
            "associations": [{"to": {"id": obj_id},
                              "types": [{"associationCategory": "HUBSPOT_DEFINED",
                                         "associationTypeId": assoc_type}]}]})
        done.append(label)
    print(f"  HubSpot: uploaded {name}.pdf + note on {', '.join(done) or 'nothing (no deal/company found — file only)'}")


# ---------- Notion attach ----------

def notion_attach(pdf, envelope_id, covered, signed_date, links, ctx, dry_run):
    """Every covered practice gets a Recall Practices row (created here from the
    template if the Notion sync hasn't yet), the signed PDF in "Contract",
    "Contract Signed", and the HubSpot / DocuSign / Drive links."""
    enrich, icb_code, deal_id, deal_name, ehr = ctx
    rows = [r for r in fetch_practice_rows() if r["ods"] in covered]
    missing = sorted(covered - {r["ods"] for r in rows})
    if missing:
        template = [] if dry_run else _copy_blocks(NOTION_TEMPLATE_PAGE)
        for ods in missing:
            if ods not in enrich:
                print(f"  WARN: Notion: covered ODS {ods} is not a known practice — no row")
                continue
            create_practice_page({"deal_id": deal_id or "", "name": enrich[ods]["name"].title(),
                                  "ehr": ehr, "ods": ods, "is_pcn": False, "contract_ods": []},
                                 enrich, icb_code, template, dry_run)
        rows = [r for r in fetch_practice_rows() if r["ods"] in covered] if not dry_run else rows
    if not rows:
        print("  Notion: no practice rows match the covered ODS codes — nothing attached")
        return
    fname = f"contract_{envelope_id}.pdf"
    link_props = {"HubSpot Deal": links.get("hubspot"), "DocuSign": links.get("docusign"),
                  "Contract folder (Drive)": links.get("drive_folder")}
    for row in rows:
        page = notion("GET", f"/pages/{row['page_id']}")
        files = page["properties"].get("Contract", {}).get("files", [])
        if any(f.get("name") == fname for f in files):
            props = {k: {"url": v} for k, v in link_props.items()
                     if v and not (page["properties"].get(k) or {}).get("url")}
            if props and not dry_run:
                notion("PATCH", f"/pages/{row['page_id']}", {"properties": props})
            continue
        if dry_run:
            print(f"  DRY RUN Notion: would attach {fname} + links {list(k for k, v in link_props.items() if v)} to {row['name']}")
            continue
        fu = notion("POST", "/file_uploads", {"mode": "single_part", "filename": fname})
        body, ctype = _multipart({}, "file", fname, pdf)
        _request(fu["upload_url"], "POST", None,
                 headers={"Authorization": f"Bearer {os.environ['NOTION_API_TOKEN']}",
                          "Notion-Version": "2022-06-28", "Content-Type": ctype},
                 raw_body=body)
        keep = [{"type": f["type"], f["type"]: f[f["type"]], "name": f.get("name")}
                for f in files if f.get("type") in ("external", "file")]
        props = {"Contract": {"files": keep + [{"type": "file_upload",
                                                "file_upload": {"id": fu["id"]},
                                                "name": fname}]}}
        if signed_date:
            props["Contract Signed"] = {"date": {"start": signed_date}}
        props.update({k: {"url": v} for k, v in link_props.items() if v})
        notion("PATCH", f"/pages/{row['page_id']}", {"properties": props})
        print(f"  Notion: attached {fname} + links to {row['name']}")


# ---------- finance tracker (Google Sheet) ----------

def _google(api, version):
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
    raw = os.environ.get("GOOGLE_SHEETS_SA_JSON", "")
    if raw:
        info = json.loads(raw)
    else:
        info = json.loads((Path(__file__).resolve().parent.parent / "nhsjobscraper-db905ad21287.json").read_text())
    creds = Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"])
    return build(api, version, credentials=creds, cache_discovery=False)


def _sheets_service():
    return _google("sheets", "v4")


# ---------- Google Drive: T&C Contracts / 2. Signed Contracts (Partners) / <Customer> ----------

def drive_upload(pdf, customer, envelope_id, signed_date, dry_run):
    """Create (or reuse) the customer's folder under DRIVE_PARENT and put the
    signed PDF in it. Returns (folder_url, file_url); ("", "") on any failure
    so Drive never blocks the HubSpot/Notion/sheet steps. Backfill from a PDF
    that already lives on Drive: --drive-folder URL --drive-file URL."""
    if "--drive-file" in sys.argv or "--drive-folder" in sys.argv:
        argv = sys.argv
        return (argv[argv.index("--drive-folder") + 1] if "--drive-folder" in argv else "",
                argv[argv.index("--drive-file") + 1] if "--drive-file" in argv else "")
    if not customer:
        return "", ""
    fname = f"{customer} - Suvera Recall Agreement (signed {signed_date or 'date unknown'}) - {envelope_id}.pdf"
    # Preferred route: the Apps Script web app (pipeline/drive_contracts_webapp.gs)
    # deployed under Will's account — files land owned by Suvera, no service
    # account needs access to the folder.
    webapp = os.environ.get("DRIVE_WEBAPP_URL", "")
    if webapp:
        if dry_run:
            print(f"  DRY RUN Drive: would file {fname} under '{customer}' via the web app")
            return "", ""
        try:
            payload = json.dumps({"secret": os.environ.get("DRIVE_WEBAPP_SECRET", ""),
                                  "customer": customer, "filename": fname, "envelope_id": envelope_id,
                                  "pdf_base64": base64.b64encode(pdf).decode()}).encode()
            req = urllib.request.Request(webapp, data=payload, method="POST",
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:  # Apps Script 302s to the result
                res = json.loads(r.read())
            if res.get("error"):
                raise RuntimeError(res["error"])
            print(f"  Drive: {'filed' if res.get('created') else 'already filed'} {fname} under '{customer}'")
            return res.get("folder_url", ""), res.get("file_url", "")
        except Exception as e:
            print(f"  WARN: Drive web app failed — {str(e)[:160]}")
            return "", ""
    try:
        drv = _google("drive", "v3")
        q = (f"'{DRIVE_PARENT}' in parents and mimeType='application/vnd.google-apps.folder' "
             f"and name='{customer.replace(chr(39), chr(92) + chr(39))}' and trashed=false")
        hits = drv.files().list(q=q, fields="files(id,name,webViewLink)", supportsAllDrives=True,
                                includeItemsFromAllDrives=True).execute().get("files", [])
        if hits:
            folder = hits[0]
        elif dry_run:
            print(f"  DRY RUN Drive: would create folder '{customer}' and upload {fname}")
            return "", ""
        else:
            folder = drv.files().create(body={"name": customer, "parents": [DRIVE_PARENT],
                                              "mimeType": "application/vnd.google-apps.folder"},
                                        fields="id,name,webViewLink", supportsAllDrives=True).execute()
        q = f"'{folder['id']}' in parents and name contains '{envelope_id}' and trashed=false"
        ex = drv.files().list(q=q, fields="files(id,webViewLink)", supportsAllDrives=True,
                              includeItemsFromAllDrives=True).execute().get("files", [])
        if ex:
            print(f"  Drive: {fname} already in '{customer}'")
            return folder["webViewLink"], ex[0]["webViewLink"]
        if dry_run:
            print(f"  DRY RUN Drive: would upload {fname} into existing folder '{customer}'")
            return folder["webViewLink"], ""
        from googleapiclient.http import MediaInMemoryUpload
        f = drv.files().create(body={"name": fname, "parents": [folder["id"]]},
                               media_body=MediaInMemoryUpload(pdf, mimetype="application/pdf"),
                               fields="id,webViewLink", supportsAllDrives=True).execute()
        print(f"  Drive: uploaded {fname} into '{customer}'")
        return folder["webViewLink"], f["webViewLink"]
    except Exception as e:
        print(f"  WARN: Drive skipped — {str(e)[:160]}")
        return "", ""


def _parse_date(s, year_hint=None):
    """'1st June 2026' / '28th July, 2026' / '23.06.26' / '03/09/2026' /
    'Friday 10th July' (year from year_hint) -> date, else None."""
    if not s:
        return None
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", s)
    s = re.sub(r"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b,?\s*", "", s)
    s = s.replace(",", " ").strip()
    s = re.sub(r"\s+", " ", s)
    for fmt in ("%d %B %Y", "%d %b %Y", "%d/%m/%Y", "%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d", "%B %d %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    m = re.search(r"\d{1,2} \w+ \d{4}", s)
    if m and m.group(0) != s:
        return _parse_date(m.group(0))
    m = re.search(r"^(\d{1,2} [A-Za-z]+)$", s)  # day + month, no year
    if m and year_hint:
        return _parse_date(f"{m.group(1)} {year_hint}")
    return None


def finance_row(parsed, covered, envelope_id, signed_date, enrich, row_no, links=None):
    """One API/WG row, using the head of finance's own formulas (columns G, H, I
    reference the row) so the tab reads exactly like the manual one."""
    r = row_no
    signed = _parse_date(signed_date) if signed_date else None
    comm = _parse_date(parsed["commencement"], signed.year if signed else None) or signed
    years = round(parsed["term_months"] / 12, 4) if parsed["term_months"] else ""
    p1, p2, reg = parsed["price_y1"], parsed["price_y2"], parsed["register"]
    if not reg and covered:
        reg = sum(int(enrich[c].get("patients") or 0) for c in covered if c in enrich) or None
    y1 = parsed["annual_fee"] or (round(reg * p1, 2) if reg and p1 else "")
    y2 = (parsed["annual_fee_y2"] or (round(reg * p2, 2) if reg and p2 else None)
          or ("auto-renews (same rate)" if years and years <= 1 else (y1 if years and years > 1 else "")))
    ppp = f"{p1} Y1 / {p2} Y2" if p1 and p2 and p2 != p1 else (p1 if p1 else "")
    notes = []
    if parsed["practices"]:
        notes.append("Practices: " + ", ".join(p["name"] for p in parsed["practices"]))
    elif covered:
        notes.append("Practices: " + ", ".join(
            f"{enrich[c]['name'].title()} ({c})" if c in enrich else c for c in sorted(covered)))
    if parsed["commencement"] and len(parsed["commencement"]) > 24:  # conditional wording, not a plain date
        notes.append(f"Commencement per contract: {parsed['commencement']}"
                     + ("" if _parse_date(parsed["commencement"]) else " (signed date used)"))
    if parsed["sms_included"] is False:
        notes.append("Excludes SMS")
    if "--note" in sys.argv:
        notes.append(sys.argv[sys.argv.index("--note") + 1])
    notes.append(f"Signed {signed.isoformat() if signed else '?'} · DocuSign envelope {envelope_id} · added by contract sync")
    for label, key in (("HubSpot deal", "hubspot"), ("Contract folder", "drive_folder"), ("DocuSign", "docusign")):
        if (links or {}).get(key):
            notes.append(f"{label}: {links[key]}")
    def d(x):
        return x.strftime("%d %b %Y") if x else ""
    L = links or {}
    pdf_link = (f'=HYPERLINK("{L["drive_file"]}","Open PDF (Drive)")' if L.get("drive_file") else
                f'=HYPERLINK("{L["hubspot"]}","Open deal (HubSpot)")' if L.get("hubspot") else "")
    return [parsed["customer"] or "", d(comm), f'=IF(ISNUMBER(B{r}),TEXT(B{r},"mmm-yy"),"")', "",
            years, ppp, f"=IF(ISNUMBER(J{r}),ROUND(J{r}/12,2),\"\")",
            f'=IF(ISNUMBER(D{r}),ROUND(ROUNDUP((D{r}-B{r})/31,0)*G{r},2),"")',
            f'=IF(AND(ISNUMBER(J{r}),ISNUMBER(E{r})),J{r}/MIN(1,E{r}),"")',
            y1, y2, reg or "", " | ".join(notes), pdf_link]


def sheet_append(parsed, covered, envelope_id, signed_date, enrich, dry_run, links=None):
    try:
        svc = _sheets_service()
    except Exception as e:  # missing key / libs: never block the HubSpot+Notion steps
        print(f"  WARN: finance sheet skipped — {str(e)[:120]}")
        return
    vals = svc.spreadsheets().values()
    existing = vals.get(spreadsheetId=FINANCE_SHEET_ID, range=f"'{FINANCE_TAB}'!A:N").execute().get("values", [])
    if not existing:
        vals.update(spreadsheetId=FINANCE_SHEET_ID, range=f"'{FINANCE_TAB}'!A1",
                    valueInputOption="RAW", body={"values": [FINANCE_HEADERS]}).execute()
        existing = [FINANCE_HEADERS]
    if any(len(row) >= 13 and envelope_id in row[12] for row in existing):
        print(f"  finance sheet: envelope {envelope_id} already on {FINANCE_TAB}")
        return
    row_no = len(existing) + 1
    row = finance_row(parsed, covered, envelope_id, signed_date, enrich, row_no, links)
    if dry_run:
        print(f"  DRY RUN finance sheet: would append row {row_no}: {row}")
        return
    vals.update(spreadsheetId=FINANCE_SHEET_ID, range=f"'{FINANCE_TAB}'!A{row_no}",
                valueInputOption="USER_ENTERED", body={"values": [row]}).execute()
    print(f"  finance sheet: row {row_no} added for '{parsed['customer']}'")


def process(pdf, envelope_id, signed_date, enrich, icb_code, dry_run):
    """One signed envelope -> Drive folder, HubSpot deal + company, Notion
    row(s), finance sheet — each carrying links to the others."""
    parsed = parse_contract(pdf)
    covered = resolve_covered_ods(parsed, enrich)
    print(f"  parsed: customer='{parsed['customer']}' ods={parsed['ods_codes']} "
          f"practices={[p['name'] for p in parsed['practices']]} -> covered={sorted(covered)}")
    deal_id, deal_name, existing, company_id = find_deal(parsed, covered)
    hubspot_record_covered(deal_id, deal_name, existing, covered, dry_run)
    folder_url, file_url = drive_upload(pdf, parsed["customer"], envelope_id, signed_date, dry_run)
    links = {"hubspot": hubspot_deal_url(deal_id) if deal_id else "",
             "docusign": docusign_url(envelope_id), "drive_folder": folder_url, "drive_file": file_url}
    ehr = ""
    if deal_id:
        ehr = (hs("GET", f"/crm/v3/objects/deals/{deal_id}?properties=ehr_type")
               .get("properties", {}).get("ehr_type") or "").strip()
    try:
        hubspot_attach(pdf, envelope_id, parsed, covered, deal_id, deal_name, company_id,
                       [("DocuSign envelope", links["docusign"]), ("Signed PDF on Drive", file_url),
                        ("Contract folder on Drive", folder_url)], dry_run)
    except RuntimeError as e:
        if "MISSING_SCOPES" not in str(e):
            raise
        print("  WARN: skipped HubSpot attach — add the Files scope to the private app")
    notion_attach(pdf, envelope_id, covered, signed_date, links,
                  (enrich, icb_code, deal_id, deal_name, ehr), dry_run)
    sheet_append(parsed, covered, envelope_id, signed_date, enrich, dry_run, links)


def main():
    dry_run = "--dry-run" in sys.argv
    for var in ("HUBSPOT_API_TOKEN", "NOTION_API_TOKEN"):
        if not os.environ.get(var):
            sys.exit(f"{var} not set")
    enrich, icb_code = load_enrichment()

    if "--file" in sys.argv:  # local / backfill mode
        pdf = Path(sys.argv[sys.argv.index("--file") + 1]).read_bytes()
        env_id = (sys.argv[sys.argv.index("--envelope-id") + 1]
                  if "--envelope-id" in sys.argv else "manual")
        signed = (sys.argv[sys.argv.index("--signed") + 1]
                  if "--signed" in sys.argv else None)
        if "--sheet-only" in sys.argv:
            parsed = parse_contract(pdf)
            covered = resolve_covered_ods(parsed, enrich)
            print(f"  parsed: {parsed} -> covered={sorted(covered)}")
            sheet_append(parsed, covered, env_id, signed, enrich, dry_run)
            return
        if not dry_run and hubspot_has_file(f"contract_{env_id}.pdf"):
            print(f"contract_{env_id}.pdf already in HubSpot — skipping upload, "
                  f"still checking Notion")
            parsed = parse_contract(pdf)
            covered = resolve_covered_ods(parsed, enrich)
            deal_id, deal_name, _, _ = find_deal(parsed, covered)
            links = {"hubspot": hubspot_deal_url(deal_id) if deal_id else "", "docusign": docusign_url(env_id)}
            notion_attach(pdf, env_id, covered, signed, links,
                          (enrich, icb_code, deal_id, deal_name, ""), dry_run)
            return
        process(pdf, env_id, signed, enrich, icb_code, dry_run)
        return

    if not (DS_KEY and DS_USER):
        sys.exit("DocuSign env vars not set")
    token = ds_token()
    acct, base = ds_account(token)
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 30
    envs = ds_completed_envelopes(token, acct, base, days)
    print(f"{len(envs)} completed envelope(s) in the last {days} days ({DS_AUTH})")
    for e in envs:
        env_id = e["envelopeId"]
        if hubspot_has_file(f"contract_{env_id}.pdf"):
            continue
        signed = (e.get("completedDateTime") or "")[:10] or None
        print(f"envelope {env_id}: '{e.get('emailSubject', '')}' completed {signed}")
        pdf = ds_download_pdf(token, acct, base, env_id)
        process(pdf, env_id, signed, enrich, icb_code, dry_run)


if __name__ == "__main__":
    main()
