# LiSTNR Music Assistant Provider

This folder contains a starter scaffold for a custom Music Assistant provider that resolves and serves LiSTNR radio stations.

## Scope of this scaffold

- Token provider client for LiSTNR JWT issuance.
- Static AU station catalog and alias matching.
- Stream URL resolver (LiSTNR-style stream URL generation and host probing).
- Provider roadmap for plugging into Music Assistant provider APIs.

## Current status

This now includes a runnable custom Music Assistant provider module with:

- `manifest.json`
- `setup(...)` and `get_config_entries(...)`
- `ListnrProvider` with browse/search/library radios + stream details
- multi-candidate stream fallback per station (for better playback resilience)
- optional token preflight and in-memory token caching

This is ready for real testing in MA, with beta-level station coverage.

## Enable in Music Assistant

1. Open Music Assistant UI.
2. Go to Settings -> Music providers -> Add provider.
3. Select `LiSTNR Radio` (domain `listnr_provider`).
4. Save with defaults for direct stream mode.
5. Optional: fill `client_id`, `client_secret`, `subject`, then set
	`validate_token_on_start=true` to verify token credentials on provider load.

## Quick functional test

1. Search for `Triple M Melbourne`.
2. Start playback on any available player.
3. If playback fails on first URL, MA should automatically try the next
	candidate stream URL supplied by the provider.

## Why this approach

- Keeps LiSTNR as primary source with explicit station control.
- Reduces dependence on Radio Browser availability and metadata drift.
- Gives deterministic station matching for voice commands.

## Next implementation steps

1. Add token-aware authenticated stream URL shaping where LiSTNR requires JWT-bound URLs.
2. Improve station catalogue coverage and regional variants.
3. Add tests for alias matching and stream resolution.
4. Harden error handling and retries around transient CDN failures.

## Credentials and onboarding

LiSTNR token provider requires onboarded client credentials:

- `client_id`
- `client_secret`
- token issue endpoint (prod): `https://token-provider.api.listnr.com/v1/issue-token`

See docs: https://docs.api.listnr.com/services/token-provider
