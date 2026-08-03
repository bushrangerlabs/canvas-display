# Docker Deployment: LiSTNR Provider For Music Assistant

This guide assumes:

- Music Assistant Server runs in Docker.
- Hermes runs on the same host.
- You want a custom LiSTNR provider available to Music Assistant.

## 1. Identify your Music Assistant container

Run:

```bash
docker ps --format '{{.Names}}\t{{.Image}}' | grep -Ei 'music.*assistant|mass|music_assistant'
```

Set your container name:

```bash
export MA_CONTAINER=<your_music_assistant_container_name>
```

## 2. Copy provider scaffold into container

From this repository root:

```bash
docker cp plugins/listnr-musicassistant-provider "$MA_CONTAINER":/tmp/listnr-musicassistant-provider
```

## 3. Install Python dependency in container

```bash
docker exec "$MA_CONTAINER" sh -lc 'python3 -m pip install --no-cache-dir requests>=2.31.0'
```

## 4. Place provider into custom providers folder

Music Assistant provider modules are Python packages. Depending on image layout,
custom provider locations vary.

Try this inside container:

```bash
docker exec "$MA_CONTAINER" sh -lc '
set -e
for p in \
  /config/providers \
  /data/providers \
  /usr/local/lib/python*/site-packages/music_assistant/providers \
  /app/music_assistant/providers
  do
    if ls -d $p >/dev/null 2>&1; then echo "$p"; fi
  done
'
```

Pick one writable path. Example using `/config/providers`:

```bash
docker exec "$MA_CONTAINER" sh -lc '
set -e
mkdir -p /config/providers/listnr_provider
cp -a /tmp/listnr-musicassistant-provider/listnr_provider/. /config/providers/listnr_provider/
'
```

## 5. Add credentials (environment or provider config)

For token-provider flow, you need:

- `client_id`
- `client_secret`
- `subject`
- optional `scope`

LiSTNR token endpoint (prod):

- `https://token-provider.api.listnr.com/v1/issue-token`

Docs:

- https://docs.api.listnr.com/services/token-provider/guides/issue-token

## 6. Restart Music Assistant container

```bash
docker restart "$MA_CONTAINER"
```

## 7. Verify provider load

```bash
docker logs "$MA_CONTAINER" --tail 200 | grep -Ei 'provider|listnr|error|traceback'
```

If provider doesn’t appear, verify the provider module path and package layout.

## 8. Activate in MA UI

Copying provider files does not auto-enable an instance.

In Music Assistant UI:

1. Settings -> Music providers -> Add provider
2. Pick `LiSTNR Radio`
3. Save config (direct stream mode works with defaults)
4. Optional token validation mode:
  - set `client_id`, `client_secret`, `subject`
  - set `validate_token_on_start=true`

## Important note

This repository now contains a full custom provider module (manifest, setup,
config entries, provider class). It should be considered beta and expanded
over time as station coverage and token-bound stream flows evolve.
