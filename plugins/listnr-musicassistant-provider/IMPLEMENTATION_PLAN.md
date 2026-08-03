# Implementation Plan: LiSTNR Provider For Music Assistant

## Goal

Create a custom Music Assistant provider that offers LiSTNR stations as first-class playable radio sources.

## Phase 1: Provider skeleton

- Add MA provider package structure expected by current Music Assistant version.
- Define provider manifest and configuration entries:
  - client_id
  - client_secret
  - subject
  - scope
  - token endpoint (dev/prod override)

## Phase 2: Catalog and search

- Use `listnr_provider.catalog` as deterministic station registry.
- Implement search matching by station name, callsign, and aliases.
- Return provider-native media items with artwork/homepage metadata.

## Phase 3: Playback URL resolution

- Resolve stream URL candidates from callsign + host + bitrate.
- Add short in-memory cache with TTL.
- Add per-host health status and fallback ordering.

## Phase 4: Token management

- Use `listnr_provider.token_provider.issue_token` with proactive refresh.
- Refresh token at ~2 minutes before expiry.
- Add safe error reporting for auth failures.

## Phase 5: Tests and hardening

- Unit tests for station lookup and alias normalization.
- Unit tests for token request serialization and response parsing.
- Integration tests for provider search and playback URL generation.

## API Notes From LiSTNR Docs

- Token endpoint: POST /v1/issue-token
- JWKS endpoint: GET /v1/jwks
- Token lifetime: 900 seconds
- Auth patterns: Bearer or Basic client credentials

Reference:
- https://docs.api.listnr.com/services/token-provider
- https://docs.api.listnr.com/services/token-provider/guides/issue-token
