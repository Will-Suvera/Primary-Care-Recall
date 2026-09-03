#!/usr/bin/env python3
"""Import signed DocuSign contracts, attach to HubSpot and Notion.

For every newly COMPLETED DocuSign envelope: download the signed PDF, parse
Schedule 1 (customer, ODS code, covered practices), attach the PDF as a note
on the matching HubSpot deal and to the "Contract" files property of every
covered Recall Practices row in Notion (setting "Contract Signed" too).

The contract is treated as ground truth for WHICH practices a deal covers —
Schedule 1's register line names each practice (e.g. "21,978 (The Pall Mall
Surgery), 15,583 (Highlands Surgery)"), which beats any name-based guessing.

Dedupe is stateless: the HubSpot file is named contract_<envelopeId>.pdf; if
it already exists the envelope is skipped.

Env: DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_PRIVATE_KEY (or
DOCUSIGN_PRIVATE_KEY_FILE), DOCUSIGN_AUTH_SERVER (account-d.docusign.com for
sandbox, account.docusign.com once live), HUBSPOT_API_TOKEN, NOTION_API_TOKEN.

Modes:
  (default)                 poll DocuSign for envelopes completed in the last 30 days
  --file X.pdf --envelope-id ID [--signed YYYY-MM-DD]   process a local PDF (testing / backfill)
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
    NOTION_DB_ID, fetch_practice_rows, PIPELINE_ID)

CS_PIPELINE_ID = "2391616730"
SUVERA_ODS = {"R7U1N"}  # Suvera's own code appears in every DPA — never a customer
ODS_RE = re.compile(r"\b[A-Z]\d[0-9A-Z]{4,5}\b")

DS_AUTH = os.environ.get("DOCUSIGN_AUTH_SERVER", "account-d.docusign.com")
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
    text = re.sub(r"\s+", " ", text)
    out = {"customer": "", "ods_codes": [], "practices": []}
    m = re.search(r"Customer Details\s+Customer\s+(.+?)\s+Customer Address", text)
    if m:
        out["customer"] = m.group(1).strip()
    out["ods_codes"] = [c for c in dict.fromkeys(ODS_RE.findall(text)) if c not in SUVERA_ODS]
    # register line: "21,978 (The Pall Mall Surgery), 15,583 (Highlands Surgery) 37,561 total"
    m = re.search(r"Register Size.*?Date\s*\)\s*(.+?)(?:Annual Fee|SIGNED)", text)
    if m:
        out["practices"] = [{"list_size": int(n.replace(",", "")), "name": p.strip()}
                            for n, p in re.findall(r"([\d,]+)\s*\(([^)]+)\)", m.group(1))
                            if not re.search(r"\btotal\b", p, re.I)]
    return out


def resolve_covered_ods(parsed, enrich):
    """The set of practice ODS codes the contract covers. Explicit codes win;
    practices named in the register line are resolved by name WITHIN the PCN
    membership of the contract's own ODS code — a closed, safe search space."""
    covered = {c for c in parsed["ods_codes"] if c in enrich}
    pcn_codes = {enrich[c]["pcn_code"] for c in covered if enrich[c].get("pcn_code")}
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
    try:
        r = hs("GET", f"/files/v3/files/search?name={name}")
    except RuntimeError as e:
        if "MISSING_SCOPES" in str(e):
            print("  WARN: HubSpot token lacks the Files scope — can't check/upload files")
            return False
        raise
    return any(f.get("name") == name for f in r.get("results", []))


def hubspot_attach(pdf, envelope_id, parsed, covered, dry_run):
    name = f"contract_{envelope_id}"
    # primary deal: covered-ODS companies' deals, or the customer-named company's
    deal_id, deal_name = None, None
    filters = [{"filters": [{"propertyName": p, "operator": "IN", "values": sorted(covered)}]}
               for p in ("ods_unique", "practice_code")] if covered else []
    if parsed["customer"]:
        filters.append({"filters": [{"propertyName": "name", "operator": "EQ",
                                     "value": parsed["customer"]}]})
    comp_ids = []
    if filters:
        r = hs("POST", "/crm/v3/objects/companies/search",
               {"filterGroups": filters, "limit": 100})
        comp_ids = [str(c["id"]) for c in r.get("results", [])]
    deals = []
    for cid in comp_ids:
        a = hs("GET", f"/crm/v4/objects/companies/{cid}/associations/deals")
        for t in a.get("results", []):
            deals.append(str(t["toObjectId"]))
    if deals:
        dr = hs("POST", "/crm/v3/objects/deals/batch/read",
                {"properties": ["dealname", "pipeline", "hs_lastmodifieddate"],
                 "inputs": [{"id": x} for x in dict.fromkeys(deals)]})
        cands = [d for d in dr.get("results", [])
                 if d["properties"].get("pipeline") in (PIPELINE_ID, CS_PIPELINE_ID)]
        cands.sort(key=lambda d: (d["properties"]["pipeline"] != PIPELINE_ID,
                                  d["properties"].get("hs_lastmodifieddate") or ""), )
        if cands:
            deal_id = str(cands[0]["id"])
            deal_name = cands[0]["properties"].get("dealname")
    if dry_run:
        print(f"  DRY RUN HubSpot: would upload {name}.pdf and attach to deal "
              f"{deal_name or 'NOT FOUND'}")
        return
    body, ctype = _multipart({"options": json.dumps({"access": "PRIVATE"}),
                              "folderPath": "/contracts"},
                             "file", f"{name}.pdf", pdf)
    up = _request("https://api-eu1.hubapi.com/files/v3/files", "POST", None,
                  headers={"Authorization": f"Bearer {os.environ['HUBSPOT_API_TOKEN']}",
                           "Content-Type": ctype}, raw_body=body)
    file_id = up["id"]
    if deal_id:
        hs("POST", "/crm/v3/objects/notes", {
            "properties": {"hs_timestamp": datetime.now(timezone.utc).isoformat(),
                           "hs_note_body": f"Signed contract (DocuSign envelope {envelope_id}) "
                                           f"— {parsed['customer'] or 'customer'} — attached by contract sync.",
                           "hs_attachment_ids": str(file_id)},
            "associations": [{"to": {"id": deal_id},
                              "types": [{"associationCategory": "HUBSPOT_DEFINED",
                                         "associationTypeId": 214}]}]})
        print(f"  HubSpot: uploaded {name}.pdf + note on deal '{deal_name}'")
    else:
        print(f"  HubSpot: uploaded {name}.pdf (no matching deal found — file only)")


# ---------- Notion attach ----------

def notion_attach(pdf, envelope_id, covered, signed_date, dry_run):
    rows = [r for r in fetch_practice_rows() if r["ods"] in covered]
    if not rows:
        print("  Notion: no practice rows match the covered ODS codes — nothing attached")
        return
    fname = f"contract_{envelope_id}.pdf"
    for row in rows:
        page = notion("GET", f"/pages/{row['page_id']}")
        files = page["properties"].get("Contract", {}).get("files", [])
        if any(f.get("name") == fname for f in files):
            continue
        if dry_run:
            print(f"  DRY RUN Notion: would attach {fname} to {row['name']}")
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
        notion("PATCH", f"/pages/{row['page_id']}", {"properties": props})
        print(f"  Notion: attached {fname} to {row['name']}")


def process(pdf, envelope_id, signed_date, enrich, dry_run):
    parsed = parse_contract(pdf)
    covered = resolve_covered_ods(parsed, enrich)
    print(f"  parsed: customer='{parsed['customer']}' ods={parsed['ods_codes']} "
          f"practices={[p['name'] for p in parsed['practices']]} -> covered={sorted(covered)}")
    try:
        hubspot_attach(pdf, envelope_id, parsed, covered, dry_run)
    except RuntimeError as e:
        if "MISSING_SCOPES" not in str(e):
            raise
        print("  WARN: skipped HubSpot attach — add the Files scope to the private app")
    notion_attach(pdf, envelope_id, covered, signed_date, dry_run)


def main():
    dry_run = "--dry-run" in sys.argv
    for var in ("HUBSPOT_API_TOKEN", "NOTION_API_TOKEN"):
        if not os.environ.get(var):
            sys.exit(f"{var} not set")
    enrich, _ = load_enrichment()

    if "--file" in sys.argv:  # local / backfill mode
        pdf = Path(sys.argv[sys.argv.index("--file") + 1]).read_bytes()
        env_id = (sys.argv[sys.argv.index("--envelope-id") + 1]
                  if "--envelope-id" in sys.argv else "manual")
        signed = (sys.argv[sys.argv.index("--signed") + 1]
                  if "--signed" in sys.argv else None)
        if not dry_run and hubspot_has_file(f"contract_{env_id}.pdf"):
            print(f"contract_{env_id}.pdf already in HubSpot — skipping upload, "
                  f"still checking Notion")
            notion_attach(pdf, env_id, resolve_covered_ods(parse_contract(pdf), enrich),
                          signed, dry_run)
            return
        process(pdf, env_id, signed, enrich, dry_run)
        return

    if not (DS_KEY and DS_USER):
        sys.exit("DocuSign env vars not set")
    token = ds_token()
    acct, base = ds_account(token)
    envs = ds_completed_envelopes(token, acct, base)
    print(f"{len(envs)} completed envelope(s) in the last 30 days ({DS_AUTH})")
    for e in envs:
        env_id = e["envelopeId"]
        if hubspot_has_file(f"contract_{env_id}.pdf"):
            continue
        signed = (e.get("completedDateTime") or "")[:10] or None
        print(f"envelope {env_id}: '{e.get('emailSubject', '')}' completed {signed}")
        pdf = ds_download_pdf(token, acct, base, env_id)
        process(pdf, env_id, signed, enrich, dry_run)


if __name__ == "__main__":
    main()
