# Hermes Plugin (Canvas Display)

This is a native Hermes Python plugin (register API), following the official plugin model:

- `plugin.yaml`
- `__init__.py` (defines `register(ctx)`)
- `schemas.py` (tool schemas shown to the model)
- `tools.py` (tool handlers)

## Tools

- `web_search_to_url`
- `youtube_search_to_url`
- `canvas_set_page`
- `canvas_navigate_panel`
- `canvas_media_play`
- `canvas_media_control`

## Install Into Hermes

There are two common deployment modes.

### 1. Host-based Hermes install

Copy this folder to Hermes plugins:

```bash
mkdir -p ~/.hermes/plugins/canvas-display
cp -r plugins/hermes-plugin/* ~/.hermes/plugins/canvas-display/
```

Then enable it:

```bash
hermes plugins enable canvas-display
```

### 2. Docker-based Hermes install

If Hermes is running inside a container, copy the plugin into the container plugin directory instead of assuming the host `~/.hermes` path is writable.

Typical pattern:

```bash
docker cp plugins/hermes-plugin/. hermes:/root/.hermes/plugins/canvas-display/
docker exec hermes hermes plugins enable canvas-display
```

This repo has previously used a Hermes container on `192.168.1.108`, and host plugin paths may be root-owned.

Optional debug discovery logs:

```bash
HERMES_PLUGINS_DEBUG=1 hermes plugins list
```

For container installs:

```bash
docker exec hermes hermes plugins list --plain --no-bundled
```

## Runtime Env

- `CANVAS_API_URL` (default: `http://127.0.0.1:3100`)

The plugin does not run as an HTTP server. Hermes loads it and calls handlers directly.

## Local validation

The plugin can be syntax-checked locally with:

```bash
cd plugins/hermes-plugin
python3 -m py_compile __init__.py schemas.py tools.py
```

That validation step is already part of `release.sh`.
