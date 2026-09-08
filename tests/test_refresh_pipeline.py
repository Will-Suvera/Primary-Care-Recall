"""
Unit tests for the refresh_data.py pipeline:
- Schema validator
- Shrink-protection invariant
- Retry-with-backoff on HubSpot 5xx
- PCN expansion whitelist

Run: python3 -m unittest tests.test_refresh_pipeline
"""

import io
import json
import os
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch, MagicMock

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "pipeline"))

import refresh_data  # noqa: E402


class TestSchemaValidator(unittest.TestCase):
    def test_valid_payload(self):
        codes = [f"A{i:05d}" for i in range(60)]
        refresh_data.validate_waitlist_schema(codes)  # should not raise

    def test_rejects_non_list(self):
        with self.assertRaises(ValueError):
            refresh_data.validate_waitlist_schema({"not": "a list"})

    def test_rejects_too_small(self):
        with self.assertRaises(ValueError):
            refresh_data.validate_waitlist_schema(["A12345"] * 10)

    def test_rejects_non_string_entry(self):
        bad = ["A12345"] * 50 + [12345]
        with self.assertRaises(ValueError):
            refresh_data.validate_waitlist_schema(bad)

    def test_rejects_malformed_ods(self):
        bad = ["A12345"] * 50 + ["this-is-not-an-ods-code"]
        with self.assertRaises(ValueError):
            refresh_data.validate_waitlist_schema(bad)


class TestShrinkProtection(unittest.TestCase):
    def setUp(self):
        self.tmp = PROJECT_ROOT / "tests" / "_tmp_waitlist.json"
        with open(self.tmp, "w") as f:
            json.dump([f"A{i:05d}" for i in range(100)], f)

    def tearDown(self):
        if self.tmp.exists():
            self.tmp.unlink()

    def test_allows_small_growth(self):
        new_codes = [f"A{i:05d}" for i in range(105)]
        refresh_data.write_waitlist_safely(new_codes, self.tmp)
        with open(self.tmp) as f:
            written = json.load(f)
        self.assertEqual(len(written), 105)

    def test_allows_small_shrink(self):
        # 5% shrink (95/100) is under the 10% limit and should pass.
        new_codes = [f"A{i:05d}" for i in range(95)]
        refresh_data.write_waitlist_safely(new_codes, self.tmp)

    def test_blocks_large_shrink(self):
        # 20% shrink (80/100) should trip the invariant.
        new_codes = [f"A{i:05d}" for i in range(80)]
        with self.assertRaises(RuntimeError) as ctx:
            refresh_data.write_waitlist_safely(new_codes, self.tmp)
        self.assertIn("Refusing to overwrite", str(ctx.exception))

        # And the file on disk must NOT have been overwritten.
        with open(self.tmp) as f:
            still_there = json.load(f)
        self.assertEqual(len(still_there), 100)


class TestHubspotRetry(unittest.TestCase):
    def setUp(self):
        os.environ["HUBSPOT_API_TOKEN"] = "test-token-not-real"
        # Speed up tests by zeroing the backoff.
        self._orig_backoff = refresh_data.HUBSPOT_BACKOFF_BASE
        refresh_data.HUBSPOT_BACKOFF_BASE = 0.0

    def tearDown(self):
        refresh_data.HUBSPOT_BACKOFF_BASE = self._orig_backoff

    def _http_error(self, code):
        return urllib.error.HTTPError(
            url="http://x", code=code, msg="err",
            hdrs={}, fp=io.BytesIO(b"server error body"),
        )

    def test_succeeds_on_first_try(self):
        ok_resp = MagicMock()
        ok_resp.read.return_value = b'{"ok": true}'
        ok_resp.__enter__ = lambda s: s
        ok_resp.__exit__ = lambda s, *a: None

        with patch("urllib.request.urlopen", return_value=ok_resp) as mock_open:
            result = refresh_data.hubspot_request("GET", "/test")
        self.assertEqual(result, {"ok": True})
        self.assertEqual(mock_open.call_count, 1)

    def test_retries_on_500_then_succeeds(self):
        ok_resp = MagicMock()
        ok_resp.read.return_value = b'{"ok": true}'
        ok_resp.__enter__ = lambda s: s
        ok_resp.__exit__ = lambda s, *a: None

        side_effects = [self._http_error(500), self._http_error(503), ok_resp]
        with patch("urllib.request.urlopen", side_effect=side_effects) as mock_open:
            result = refresh_data.hubspot_request("GET", "/test")
        self.assertEqual(result, {"ok": True})
        self.assertEqual(mock_open.call_count, 3)

    def test_retries_on_429_then_succeeds(self):
        ok_resp = MagicMock()
        ok_resp.read.return_value = b'{"ok": true}'
        ok_resp.__enter__ = lambda s: s
        ok_resp.__exit__ = lambda s, *a: None

        side_effects = [self._http_error(429), ok_resp]
        with patch("urllib.request.urlopen", side_effect=side_effects) as mock_open:
            result = refresh_data.hubspot_request("GET", "/test")
        self.assertEqual(result, {"ok": True})
        self.assertEqual(mock_open.call_count, 2)

    def test_does_not_retry_on_4xx(self):
        side_effects = [self._http_error(401)]
        with patch("urllib.request.urlopen", side_effect=side_effects) as mock_open:
            with self.assertRaises(urllib.error.HTTPError):
                refresh_data.hubspot_request("GET", "/test")
        self.assertEqual(mock_open.call_count, 1)

    def test_gives_up_after_max_retries(self):
        side_effects = [self._http_error(500)] * refresh_data.HUBSPOT_MAX_RETRIES
        with patch("urllib.request.urlopen", side_effect=side_effects) as mock_open:
            with self.assertRaises(urllib.error.HTTPError):
                refresh_data.hubspot_request("GET", "/test")
        self.assertEqual(mock_open.call_count, refresh_data.HUBSPOT_MAX_RETRIES)


class TestPCNWhitelist(unittest.TestCase):
    def test_recognises_gp_practice(self):
        self.assertTrue(refresh_data.is_gp_practice({"organisation_type": "GP Practice"}))
        self.assertTrue(refresh_data.is_gp_practice({"organisation_type": "gp practice"}))
        self.assertTrue(refresh_data.is_gp_practice({"organisation_type": "GP"}))

    def test_rejects_federation(self):
        self.assertFalse(refresh_data.is_gp_practice({"organisation_type": "Federation"}))

    def test_rejects_pcn(self):
        self.assertFalse(refresh_data.is_gp_practice({"organisation_type": "PCN"}))

    def test_rejects_icb(self):
        self.assertFalse(refresh_data.is_gp_practice({"organisation_type": "ICB"}))

    def test_rejects_blank(self):
        self.assertFalse(refresh_data.is_gp_practice({}))
        self.assertFalse(refresh_data.is_gp_practice({"organisation_type": ""}))


class TestClassifyCompany(unittest.TestCase):
    """PCNs must be expanded even when the ODS sync has stamped a U-code on them."""

    def test_pcn_with_ucode_is_still_expanded(self):
        # Regression: 2026-09-07 the ODS -> HubSpot sync wrote pcn U-codes into
        # ods_unique and the waitlist collapsed 476 -> 308.
        props = {"name": "Darlington PCN", "organisation_type": "PCN", "ods_unique": "U12345"}
        self.assertEqual(refresh_data.classify_company(props), ("pcn", None))

    def test_pcn_by_name_only(self):
        props = {"name": "EPSOM PCN", "organisation_type": "", "practice_code": "U54321"}
        self.assertEqual(refresh_data.classify_company(props), ("pcn", None))

    def test_gp_practice_named_pcn_is_not_expanded(self):
        props = {"name": "PCN Hub Surgery", "organisation_type": "GP Practice", "ods_unique": "C11111"}
        self.assertEqual(refresh_data.classify_company(props), ("practice", "C11111"))

    def test_practice_with_ods(self):
        props = {"name": "Some Surgery", "organisation_type": "GP Practice", "ods_unique": " a12345 "}
        self.assertEqual(refresh_data.classify_company(props), ("practice", "A12345"))

    def test_practice_falls_back_to_practice_code(self):
        props = {"name": "Some Surgery", "organisation_type": "GP Practice", "practice_code": "B99999"}
        self.assertEqual(refresh_data.classify_company(props), ("practice", "B99999"))

    def test_no_ods_no_pcn(self):
        props = {"name": "Some Federation", "organisation_type": "Federation"}
        self.assertEqual(refresh_data.classify_company(props), ("none", None))


if __name__ == "__main__":
    unittest.main()
