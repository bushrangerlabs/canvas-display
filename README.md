# Canvas Display

> [!WARNING]
> **Work in progress — not ready for use.** This project is in early active development. There are no stable releases, the API will change without notice, and nothing is production-ready yet. Come back later.

A fully standalone display management platform for smart homes and kiosk deployments. Canvas Display is a companion to [Canvas UI](https://github.com/bushrangerlabs/canvas-ui) — while Canvas UI embeds a canvas viewer panel inside Home Assistant, Canvas Display runs as a native kiosk app with its own server, giving you full control of what's shown on dedicated display devices.

## Packages

| Package | Description |
|---|---|
| `server/` | Node.js + SQLite backend — config store, REST API, real-time WebSocket sync, MQTT command/control |
| `web/` | React admin SPA — page/panel editor, device settings, dashboard |
| `browser/` | Tauri native app — kiosk display client for Linux, connects to server for page assignments and HA for live entity data |
| `custom_components/canvas_display/` | Home Assistant custom component — exposes Canvas Display devices as HA entities for automations |

## Architecture

```
Canvas Display Server (server/)
  ├── SQLite database — pages, panels, settings
  ├── REST API — CRUD for pages/panels, settings, MQTT config
  └── WebSocket — real-time page push to connected kiosk clients

Canvas Display Web (web/)
  ├── Dashboard — server status, active page, quick-activate
  ├── Pages editor — drag/resize panels, URL assignment
  └── Settings — MQTT broker config, device name, canvas defaults

Canvas Display Browser (browser/)
  ├── Tauri — Linux deb/AppImage
  ├── Connects to server for page assignments
  ├── Connects to HA for entity data (Canvas UI widgets)
  └── Receives MQTT commands for page changes and panel navigation
```

## MQTT Control

Once connected to an MQTT broker, Canvas Display publishes state and subscribes to commands:

```
canvas_display/{device_name}/state              ← device online/offline + active page
canvas_display/{device_name}/cmd/page           → {"page": "my page name"}
canvas_display/{device_name}/cmd/navigate       → {"panel": "panel name", "url": "https://..."}
canvas_display/{device_name}/cmd/reload         → {}
canvas_display/{device_name}/cmd/quit           → {}
```

Both device name and IDs are accepted in topic and payload fields.

## Getting Started

### Server

```bash
cd server
npm install
npm run dev
# API: http://localhost:3100
# WebSocket: ws://localhost:3100/ws
```

### Web

```bash
cd web
npm install
npm run dev
# http://localhost:5173
```

## Related

- [Canvas UI](https://github.com/bushrangerlabs/canvas-ui) — HACS panel that embeds the canvas editor and viewer inside Home Assistant
