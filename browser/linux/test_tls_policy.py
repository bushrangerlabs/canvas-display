"""Source-level TLS guards; no WebKit runtime or network access required."""
from pathlib import Path
import unittest


class TlsPolicyTests(unittest.TestCase):
    def test_tls_failure_is_logged_without_secrets_and_not_retried(self):
        source = (Path(__file__).parent / "src-tauri/src/lib.rs").read_text()
        self.assertNotIn("allow_tls_certificate_for_host", source)
        handler = source.split("wk.connect_load_failed_with_tls_errors(", 1)[1].split(
            "\n                    );", 1
        )[0]
        self.assertIn("|_view, _failing_uri, _certificate, errors|", handler)
        body = handler.split("| {", 1)[1]
        self.assertIn("klog(&format!(", body)
        self.assertIn("certificate validation failed", body)
        self.assertIn("errors", body)
        for forbidden in ("_failing_uri", "_certificate", "_view", "true", "reload", "load_uri"):
            self.assertNotIn(forbidden, body)
        self.assertTrue(body.rstrip().endswith("false\n                        },"))
        self.assertNotIn("wk.reload()", source)


if __name__ == "__main__":
    unittest.main()
