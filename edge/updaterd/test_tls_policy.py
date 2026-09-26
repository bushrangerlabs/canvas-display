"""Source-level manifest TLS guards; no devices or network access required."""
from pathlib import Path
import unittest


class TlsPolicyTests(unittest.TestCase):
    def test_manifest_client_retains_strict_native_root_trust(self):
        root = Path(__file__).parent
        source = (root / "src/main.rs").read_text()
        for forbidden in ("danger_accept_invalid_certs", "danger_accept_invalid_hostnames"):
            self.assertNotIn(forbidden, source)
        manifest_fetch = source.split("fn fetch_signed_manifest(", 1)[1].split(
            "\nfn run_configured_rollout(", 1
        )[0]
        self.assertIn("reqwest::blocking::Client::builder()", manifest_fetch)
        self.assertIn(".timeout(Duration::from_secs(30))", manifest_fetch)
        self.assertIn(".error_for_status()", manifest_fetch)
        cargo = (root / "Cargo.toml").read_text()
        self.assertIn('"rustls-tls-native-roots"', cargo)
        self.assertIn("default-features = false", cargo)


if __name__ == "__main__":
    unittest.main()
