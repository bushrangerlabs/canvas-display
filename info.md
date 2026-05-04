# Canvas Display

Home Assistant integration for [Canvas Display](https://github.com/bushrangerlabs/canvas-display) — a customizable canvas-based display system for single-board computers and kiosk devices.

## Features

- **Status sensor** — shows each device as `online` / `offline`
- **Active page select** — switch the displayed page from HA
- **Multiple devices** — add one entry per Canvas Display device

## Setup

For each Canvas Display device:

1. In HA: **Settings → Devices & Services → Add Integration → Canvas Display**
2. Enter the server URL, e.g. `http://192.168.1.x:3100`
3. HA will connect and name the entry after the device's configured name

## Requirements

- Canvas Display server running and reachable from HA (port 3100 by default)
