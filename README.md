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

---

## REST API

Base URL: `http://<device>:3100/api`

All request and response bodies are JSON.

### Pages

| Method | Path | Description |
|---|---|---|
| `GET` | `/pages` | List all pages with their panels |
| `GET` | `/pages/:id` | Get a single page with panels |
| `POST` | `/pages` | Create a page — `{ name, panels?: [...] }` |
| `PATCH` | `/pages/:id` | Rename a page — `{ name }` |
| `DELETE` | `/pages/:id` | Delete a page |
| `POST` | `/pages/:id/push` | Push page to all connected kiosk displays immediately |

#### Panel sub-routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/pages/:id/panels` | Add panel — `{ name, x, y, w, h, url?, view_id? }` |
| `PATCH` | `/pages/:id/panels/:panelId` | Update panel — `{ name?, x?, y?, w?, h?, url?, view_id?, position? }` |
| `DELETE` | `/pages/:id/panels/:panelId` | Remove panel |

Panel geometry fields (`x`, `y`, `w`, `h`) are percentages 0–100 of screen size.

### Commands

Direct control endpoints — same actions as MQTT commands, useful when no broker is configured.

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/commands/page` | `{ page_id? } \| { page? }` | Set active page by ID or name |
| `POST` | `/commands/navigate` | `{ url, panel_id? \| panel?, page_id? \| page? }` | Navigate a panel to a URL |
| `POST` | `/commands/reload` | `{}` | Reload the kiosk display |
| `POST` | `/commands/quit` | `{}` | Show the quit dialog on the kiosk |

`page` and `panel` fields do case-insensitive name lookup. `page` on `/commands/navigate` is optional — used to disambiguate panels that share the same name across different pages.

### Settings

| Method | Path | Description |
|---|---|---|
| `GET` | `/settings` | Get all settings (passwords redacted) |
| `PUT` | `/settings` | Update settings — `{ device_name?, server_port?, mqtt_enabled?, mqtt_broker_url?, mqtt_username?, mqtt_password? }` |
| `GET` | `/settings/mqtt` | Get MQTT connection status `{ enabled, url, connected }` |
| `POST` | `/settings/mqtt/reconnect` | Apply updated MQTT settings and reconnect |
| `POST` | `/settings/mqtt/disconnect` | Disconnect from MQTT broker |

### Devices

| Method | Path | Description |
|---|---|---|
| `GET` | `/devices` | List registered devices with online status |
| `GET` | `/devices/:id` | Get a single device |
| `POST` | `/devices/register` | Register/update device — `{ id?, name?, platform?, screen_width?, screen_height?, pixel_ratio?, ip_address?, app_version? }` |
| `PATCH` | `/devices/:id` | Update device — `{ name?, description?, assigned_page_id?, slug?, platform? }` |
| `DELETE` | `/devices/:id` | Remove device |
| `POST` | `/devices/:id/command` | Send command to a specific device — `{ action, payload? }` |
| `POST` | `/devices/command` | Broadcast command to all devices — `{ action, payload? }` |

Setting `assigned_page_id` via `PATCH /devices/:id` immediately pushes the page to that device.

#### Device command actions

| Action | Payload | Description |
|---|---|---|
| `navigate_panel` | `{ panel_id, url }` | Navigate a panel to a URL |
| `reload` | `{}` | Reload the kiosk |
| `show_quit_dialog` | `{}` | Show quit dialog |
| `screen_off` | `{}` | Turn off screen |
| `screen_on` | `{}` | Turn on screen |
| `set_brightness` | `{ brightness }` | Set screen brightness (0.0–1.0) |
| `show_floating` | `{ url }` | Show/navigate the floating overlay panel |
| `hide_floating` | `{}` | Hide the floating overlay panel |

### HA Proxy (add-on mode only)

Available when running as a Home Assistant add-on with `homeassistant_api: true`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/ingress-info` | Returns the add-on's HA ingress URL |
| `GET` | `/ha/states` | Proxy all HA entity states |
| `GET` | `/ha/states/:entityId` | Proxy a single entity state |
| `GET` | `/ha/camera_proxy/:entityId` | Proxy a camera snapshot image |
| `POST` | `/ha/services/:domain/:service` | Call an HA service |

---

## MQTT

When MQTT is enabled the server connects to the configured broker on startup and maintains a persistent connection with auto-reconnect.

### Published topics (server → broker)

| Topic | Retained | Payload | Description |
|---|---|---|---|
| `canvas_display/server/state` | ✓ | `{ online: bool }` | Server online/offline (will message clears on disconnect) |
| `canvas_display/{device_id}/state` | ✓ | `{ online, device_id, name, page_id, page_name }` | Device state published on connect and whenever the active page changes |
| `canvas_display/{device_id}/panel/{position}/url` | ✓ | `{ url }` | URL of each panel on the active page, published when the page changes |

### Subscribed topics (broker → server)

The server subscribes to `canvas_display/+/cmd/+`. The device segment is matched against both `device_id` and `device_name` (case-insensitive).

| Topic | Payload | Description |
|---|---|---|
| `canvas_display/{device}/cmd/page` | `{ page_id? } \| { page? }` | Set active page by ID or name |
| `canvas_display/{device}/cmd/navigate` | `{ url, panel_id? \| panel?, page_id? \| page? }` | Navigate a panel to a URL |
| `canvas_display/{device}/cmd/reload` | `{}` | Reload the kiosk display |
| `canvas_display/{device}/cmd/quit` | `{}` | Show quit dialog on the kiosk |

`{device}` can be the `device_id` (e.g. `u5v80iARyh9H`) or the human-readable `device_name` (e.g. `device1`).

#### Examples

```bash
# Switch to a page by name
mosquitto_pub -h 192.168.1.57 -u user -P pass \
  -t 'canvas_display/device1/cmd/page' \
  -m '{"page":"youtube"}'

# Navigate a panel to a URL
mosquitto_pub -h 192.168.1.57 -u user -P pass \
  -t 'canvas_display/device1/cmd/navigate' \
  -m '{"panel":"maintop","url":"https://example.com"}'

# Reload the display
mosquitto_pub -h 192.168.1.57 -u user -P pass \
  -t 'canvas_display/device1/cmd/reload' -m '{}'
```

---

## Home Assistant Integration

Install via [canvas-display-hacs](https://github.com/bushrangerlabs/canvas-display-hacs). Exposes the device as a **select entity** (active page) and **sensor entities**, plus four services:

| Service | Fields | Description |
|---|---|---|
| `canvas_display.set_page` | `page` (required), `device_name` | Set active page by name or ID |
| `canvas_display.navigate_panel` | `panel` (required), `url` (required), `page`, `device_name` | Navigate a panel to a URL |
| `canvas_display.reload` | `device_name` | Reload the kiosk |
| `canvas_display.quit` | `device_name` | Show quit dialog |

`device_name` is optional — leave empty to target all configured devices.

---

## WebSocket

Connect to `ws://<device>:3100/ws` (optionally with `?role=browser&deviceId=<id>` for kiosk clients).

Send a `hello` message after connecting:

```json
{ "type": "hello", "client_type": "browser", "device_id": "...", "screen_width": 1920, "screen_height": 1080, "pixel_ratio": 1 }
```

Client types: `browser` (kiosk display), `editor` (web admin), `api` (generic).

---

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

---

## Related

- [Canvas UI](https://github.com/bushrangerlabs/canvas-ui) — HACS panel that embeds the canvas editor and viewer inside Home Assistant
- [canvas-display-hacs](https://github.com/bushrangerlabs/canvas-display-hacs) — Home Assistant integration for Canvas Display
