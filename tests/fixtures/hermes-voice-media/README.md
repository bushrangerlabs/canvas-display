# Hermes / voice / media regression fixtures

These fixtures are synthetic and sanitized. They contain no recorded audio, deployment endpoint, private host address, API key, bearer token, Home Assistant credential, or user identity.

- `corpus.v1.json` is the stable expected-outcome corpus used for Hermes and future Canvas Intelligence comparisons.
- `reference-observations.v1.json` supplies adapter-neutral representative observations that exercise the evaluator without calling production services.

The corpus is intentionally versioned. Change expectations only when the corresponding behavior or accepted safety gate changes, and add a new case instead of weakening an existing safety-critical assertion where possible.
