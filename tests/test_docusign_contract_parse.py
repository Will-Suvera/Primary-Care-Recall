"""Schedule 1 parsing for the Recall agreement templates (synthetic text, no PDFs)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
from sync_docusign_contracts import is_recall_contract, parse_contract_text  # noqa: E402

SUVERA = ("Suvera Company Details Suvera Ltd (Company Number 12237910). ODS Code: R7U1N "
          "Suvera Contact Partnerships: partnerships@suvera.co.uk ")

# Nov 2026 template: em-dash heading, Initial Term straight after the Commencement
# Date, no Large Register Discount row.
NOV_2026 = (
    "Master Agreement ... the Buyer identified in Schedule 1 ... "
    "Schedule 1 — Parties and Commercial Details " + SUVERA +
    "Buyer Name Example Surgery Buyer Address 1 High St, Town, AB1 2CD "
    "Buyer Contact Practice Manager: pm@example.org "
    "Commencement Date 04th November 2026 Initial Term 24 months from 04th November 2026 "
    "Cost per patient Base Price: £0.75 + VAT Monthly equivalent £502.13 + VAT "
    "Customer Name Customer Details Register Size Annual Fee Address: 1 High St ODS Code: A12345 "
    "Signed by: Buyer as agent 8,034 £6,025.50 + VAT Totals: 8,034 £6,025.50 "
    "Docusign Envelope ID: 973E34DA-2D80-88D2-8035-9FFCDFEA018C 1021 Insert new rows above "
    "SIGNED by the authorised representatives of Suvera and the Buyer: ")

# Sept 2026 (v5) template: hyphen heading, Large Register Discount row after the date.
SEPT_2026 = (
    "Schedule 1 - Parties and Commercial Details " + SUVERA +
    "Buyer Name Example PCN Buyer Address 2 Low Rd, Town, AB3 4EF "
    "Initial Term 24 months Commencement Date 28 September 2026 Large Register Discount N/A "
    "Customer Name Register Size Annual Fee ODS Code: B54321 "
    "Totals: 14,427 £10,820.25 SIGNED by the authorised representatives ")


class TestScheduleOne(unittest.TestCase):
    def test_november_2026_template_is_recognised(self):
        p = parse_contract_text(NOV_2026)
        self.assertEqual(p["customer"], "Example Surgery")
        self.assertEqual(p["commencement"], "04th November 2026")
        self.assertEqual(p["term_months"], 24)
        self.assertEqual(p["register"], 8034)
        self.assertEqual(p["annual_fee"], 6025.5)
        self.assertEqual(p["ods_codes"], ["A12345"])
        self.assertFalse(p["opt_in_trial"])
        self.assertTrue(is_recall_contract(p))

    def test_september_2026_template_unchanged(self):
        p = parse_contract_text(SEPT_2026)
        self.assertEqual(p["customer"], "Example PCN")
        self.assertEqual(p["commencement"], "28 September 2026")
        self.assertEqual((p["register"], p["annual_fee"]), (14427, 10820.25))
        self.assertTrue(is_recall_contract(p))

    def test_long_commencement_wording_is_left_blank(self):
        # an opt-in trial words the date as a sentence; finance fills it by hand
        text = NOV_2026.replace("Commencement Date 04th November 2026",
                                "Commencement Date The date of the Buyer's signature below. Free trial "
                                "Three months from the Go-Live Date at the practice")
        self.assertEqual(parse_contract_text(text)["commencement"], "")


if __name__ == "__main__":
    unittest.main()
