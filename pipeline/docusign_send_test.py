#!/usr/bin/env python3
"""Send a sandbox test envelope (used for end-to-end testing + DocuSign go-live
call count). Usage: docusign_send_test.py <pdf> <signer_email> <signer_name>"""
import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync_docusign_contracts import ds_token, ds_account, _request  # noqa: E402


def main():
    pdf_path, email, name = sys.argv[1], sys.argv[2], sys.argv[3]
    token = ds_token()
    acct, base = ds_account(token)
    envelope = {
        "emailSubject": "TEST — Suvera contract sync (sandbox)",
        "status": "sent",
        "documents": [{
            "documentBase64": base64.b64encode(Path(pdf_path).read_bytes()).decode(),
            "name": Path(pdf_path).name, "fileExtension": "pdf", "documentId": "1"}],
        "recipients": {"signers": [{
            "email": email, "name": name, "recipientId": "1",
            "tabs": {"signHereTabs": [{"documentId": "1", "pageNumber": "8",
                                       "xPosition": "100", "yPosition": "500"}]}}]},
    }
    r = _request(f"{base}/restapi/v2.1/accounts/{acct}/envelopes", "POST", envelope,
                 headers={"Authorization": f"Bearer {token}"})
    print("sent envelope:", r.get("envelopeId"), "status:", r.get("status"))


if __name__ == "__main__":
    main()
