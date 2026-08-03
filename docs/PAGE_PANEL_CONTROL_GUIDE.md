# Canvas Display Page and Panel Control Guide

**Status:** Living operator/developer guide; reviewed 2026-07-31. Core authority and its
authenticated device channel are preferred. Local server and MQTT methods described below are
compatibility surfaces unless explicitly stated otherwise.

This document describes every supported method for manipulating pages and panels on Canvas Display devices.

## 1. Control model

Canvas uses this hierarchy:

```text
Device
└── Page library (any number of pages)
    └── Active page (one at a time)
        └── Panels (maximum five per page)
```

A panel can contain:

- An HTTP or HTTPS URL
- A published Canvas scene

Panels also support:

- Percentage-based position and size
- Overlapping layers through `z_index`
- Visibility
- Opacity

Core stores the authoritative page library and per-device panel overrides. Commands from the editor, REST API, MQTT, Home Assistant, or AI are converted into an effective page document and delivered through the authenticated Core → Edge → renderer channel.

YouTube playback controls use `POST /api/media/control` with the target device plus
`source: "youtube"` and `action: "pause"`, `"resume"`, `"next"`, or `"stop"`. The equivalent
Core MQTT command topic is `canvas/devices/<deviceId>/commands/media`; publish a JSON payload such
as `{"source":"youtube","action":"next"}`. Results are returned on
`canvas/devices/<deviceId>/state/media`.

`POST /api/media/play` also accepts a public YouTube playlist URL. The Pi resolves up to 50
public items, advances automatically when a track ends, and applies the same media-control and
MQTT commands to that device-local queue. Spoken playlist searches require a configured YouTube
Data API key; “YouTube Music” currently means public music-aware YouTube search and does not
access a user's private YouTube Music account.

Discovery requests display the top three ranked playlists on the requesting Pi. Select by touch
or by saying “play the first one,” “choose the second,” or “select the third playlist.” “Show me
more playlists” advances to the next three ranked results and “cancel the selection” closes it.
The pending selection is local to that Pi and expires after two minutes.

### Custom playlist-selection page

1. In the scene editor, add one or more **Playlist Result** widgets.
2. Give every widget a unique result slot from 1 through 8 and select one of its four layouts.
3. Style the artwork card, typography, colours, border and visible metadata normally.
4. Publish the scene and add it to a page as scene content.
5. Open **Settings → Default pages** and select that page as the **Playlist selection page**.

Canvas stores the page UUID, not its name. At runtime Core reads all enabled Playlist Result
widgets in published scenes on that page and returns one playlist per unique slot. Widget geometry
is mapped through the page panel, so the user controls the arrangement. If the assignment cannot
be resolved, Canvas uses its built-in three-card view.

## 2. Identifiers

Most commands use one or more of these identifiers:

| Identifier | Description |
|---|---|
| `device_id` | Core device UUID, such as `device-2acc4690-...` |
| `page_id` | Page UUID |
| `panel_id` | Panel UUID |
| `scene_id` | Published scene UUID |
| `page` | Case-insensitive page name |
| `panel` | Panel name |

IDs are preferred for automation because names can be changed. Panel names may be used safely when they are unique on the active page or when a page is explicitly supplied.

## 3. Authentication

### Browser/editor

The Core web interface uses an authenticated admin session and CSRF protection.

### Automation clients

Trusted clients such as Home Assistant should use the scoped automation bearer token:

```http
Authorization: Bearer <CANVAS_CORE_AUTOMATION_TOKEN>
```

The token is configured on Core through:

```text
CANVAS_CORE_AUTOMATION_TOKEN
```

Do not put this token in MQTT payloads, URLs, logs, or scene documents.

## 4. REST API

The examples below assume:

```bash
CORE_URL="https://192.168.1.108:3100"
TOKEN="<automation-token>"
```

All JSON commands use:

```bash
-H "Authorization: Bearer $TOKEN" \
-H "Content-Type: application/json"
```

### 4.1 List pages

```http
GET /api/pages
```

```bash
curl -kfsS \
  -H "Authorization: Bearer $TOKEN" \
  "$CORE_URL/api/pages"
```

Each page includes its panel definitions and assigned device IDs.

### 4.2 Get one page

```http
GET /api/pages/{pageId}
```

### 4.3 Create a page

```http
POST /api/pages
```

```json
{
  "name": "Living Room",
  "panels": [
    {
      "name": "Main",
      "content_type": "url",
      "url": "https://example.com",
      "x": 0,
      "y": 0,
      "w": 100,
      "h": 100,
      "position": 0,
      "z_index": 0,
      "visible": true,
      "opacity": 1
    }
  ]
}
```

A page may contain no more than five panels.

### 4.4 Rename or update a page

```http
PATCH /api/pages/{pageId}
```

```json
{
  "name": "Updated Living Room"
}
```

### 4.5 Delete a page

```http
DELETE /api/pages/{pageId}
```

Deleting a page also removes its panel records and device assignments. Devices using that page should be moved to another page first.

### 4.6 Add a panel to a page

```http
POST /api/pages/{pageId}/panels
```

URL panel:

```json
{
  "name": "Weather",
  "content_type": "url",
  "url": "https://weather.example.com",
  "x": 0,
  "y": 0,
  "w": 50,
  "h": 100,
  "z_index": 0,
  "visible": true,
  "opacity": 1
}
```

Scene panel:

```json
{
  "name": "Controls",
  "content_type": "scene",
  "scene_id": "published-scene-uuid",
  "x": 50,
  "y": 0,
  "w": 50,
  "h": 100,
  "z_index": 1,
  "visible": true,
  "opacity": 1
}
```

Scene content must reference a published scene.

### 4.7 Update a panel definition

```http
PATCH /api/pages/{pageId}/panels/{panelId}
```

This changes the shared page definition. It is different from a per-device panel command.

```json
{
  "name": "Main Dashboard",
  "content_type": "url",
  "url": "https://dashboard.example.com",
  "x": 0,
  "y": 0,
  "w": 70,
  "h": 100,
  "z_index": 0,
  "visible": true,
  "opacity": 1
}
```

### 4.8 Delete a panel

```http
DELETE /api/pages/{pageId}/panels/{panelId}
```

### 4.9 Assign a page to a device library

```http
PUT /api/pages/{pageId}/assign
```

```json
{
  "device_id": "device-uuid"
}
```

Assignment places the page in the device’s library. It does not necessarily make it the active page.

### 4.10 Remove a page from a device assignment

```http
DELETE /api/pages/{pageId}/assign/{deviceId}
```

### 4.11 Force a device to display a page

```http
POST /api/pages/{pageId}/display
```

```json
{
  "device_id": "device-uuid"
}
```

Core stores the active page, updates navigation history, sends the complete effective page to Edge, and waits for an applied report.

Successful response:

```json
{
  "delivered": true,
  "delivery": {
    "revision": 45
  }
}
```

### 4.12 Inspect a device page library

```http
GET /api/devices/{deviceId}/pages
```

The result includes:

- Library pages
- Active page
- Default page
- Fallback page
- Navigation history
- Cache/synchronization status

### 4.13 Return to the previous page

```http
POST /api/devices/{deviceId}/page/back
```

### 4.14 Reload the active page

```http
POST /api/devices/{deviceId}/page/reload
```

### 4.15 Unified panel command

```http
POST /api/commands/panel
```

This is the preferred automation interface for changing panel content.

#### Load a URL by panel name

```json
{
  "device_id": "device-uuid",
  "panel": "Main",
  "content_type": "url",
  "url": "https://example.com"
}
```

#### Load a URL by panel ID

```json
{
  "device_id": "device-uuid",
  "panel_id": "panel-uuid",
  "content_type": "url",
  "url": "https://example.com"
}
```

#### Load a published scene

```json
{
  "device_id": "device-uuid",
  "panel_id": "panel-uuid",
  "content_type": "scene",
  "scene_id": "published-scene-uuid"
}
```

#### Hide a panel

```json
{
  "device_id": "device-uuid",
  "panel": "Overlay",
  "visible": false
}
```

#### Show and reload a panel

```json
{
  "device_id": "device-uuid",
  "panel": "Overlay",
  "visible": true,
  "reload": true
}
```

#### Scope a panel name to a page

```json
{
  "device_id": "device-uuid",
  "page": "Living Room",
  "panel": "Main",
  "content_type": "url",
  "url": "https://example.com"
}
```

You may use `page_id` instead of `page`.

If no page is supplied, Core resolves the panel name against the device’s active page. If a panel on an inactive page is targeted, Core stores the override and returns `queued: true`; the content is applied when that page becomes active.

Successful active-panel response:

```json
{
  "success": true,
  "delivered": true,
  "device_id": "device-uuid",
  "page_id": "page-uuid",
  "panel_id": "panel-uuid",
  "content": {
    "type": "url",
    "url": "https://example.com"
  }
}
```

Queued inactive-panel response:

```json
{
  "success": true,
  "delivered": false,
  "queued": true,
  "page_id": "inactive-page-uuid",
  "active_page_id": "current-page-uuid",
  "panel_id": "panel-uuid"
}
```

### 4.16 Device-specific panel patch

The lower-level device route remains available:

```http
PATCH /api/devices/{deviceId}/panels/{panelId}
```

```json
{
  "content_type": "url",
  "url": "https://example.com",
  "visible": true
}
```

Prefer `/api/commands/panel` for new automation because it supports panel names, page scoping, queued inactive-page changes, and reload semantics.

### 4.17 Reload one panel

```http
POST /api/devices/{deviceId}/panels/{panelId}/reload
```

## 5. MQTT

MQTT is owned and monitored by Core.

Configure it under:

```text
Core → Settings → MQTT navigation
```

Settings include:

- Enable/disable
- Broker URL
- Username
- Password
- Live connection state
- Last connection error
- Reconnect
- Disconnect

Supported broker schemes:

```text
mqtt://
mqtts://
ws://
wss://
```

### 5.1 Activate a page

Topic:

```text
canvas/devices/{deviceId}/commands/page
```

Payload:

```json
{
  "page_id": "page-uuid"
}
```

### 5.2 Device-level panel command

Topic:

```text
canvas/devices/{deviceId}/commands/panel
```

URL by panel ID:

```json
{
  "panel_id": "panel-uuid",
  "content_type": "url",
  "url": "https://example.com"
}
```

URL by panel name on the active page:

```json
{
  "panel": "Main",
  "content_type": "url",
  "url": "https://example.com"
}
```

Published scene:

```json
{
  "panel_id": "panel-uuid",
  "content_type": "scene",
  "scene_id": "published-scene-uuid"
}
```

Visibility:

```json
{
  "panel_id": "panel-uuid",
  "visible": false
}
```

### 5.3 Panel-specific MQTT topic

Topic:

```text
canvas/devices/{deviceId}/panels/{panelId}/commands
```

Because the panel ID is in the topic, the payload only needs the requested change:

```json
{
  "content_type": "url",
  "url": "https://example.com",
  "visible": true
}
```

or:

```json
{
  "content_type": "scene",
  "scene_id": "published-scene-uuid"
}
```

### 5.4 MQTT results

Core publishes navigation results to:

```text
canvas/devices/{deviceId}/state/navigation
```

Successful page result:

```json
{
  "ok": true,
  "active_page_id": "page-uuid"
}
```

Successful panel result:

```json
{
  "ok": true,
  "panel_id": "panel-uuid",
  "content": {
    "type": "url",
    "url": "https://example.com"
  },
  "visible": true
}
```

Failure:

```json
{
  "ok": false,
  "error": "published scene not found"
}
```

Successful navigation state is retained so a newly connected subscriber can see the last result.

## 6. Home Assistant

The Canvas Display custom integration exposes these services:

| Service | Purpose |
|---|---|
| `canvas_display.load_device_page` | Activate a page on one Core-managed device |
| `canvas_display.page_back` | Return to the previous page |
| `canvas_display.load_panel_url` | Load an HTTP(S) URL into a panel |
| `canvas_display.load_panel_scene` | Load a published scene into a panel |
| `canvas_display.set_panel_visibility` | Show or hide a panel |
| `canvas_display.set_page` | Legacy page-name/ID command |
| `canvas_display.navigate_panel` | Legacy URL navigation command |
| `canvas_display.reload` | Reload connected displays |

The integration requires:

- Core API URL
- Core automation token

### 6.1 Load a page

```yaml
service: canvas_display.load_device_page
data:
  device_id: device-uuid
  page: page-uuid
```

### 6.2 Load a panel URL

```yaml
service: canvas_display.load_panel_url
data:
  device_id: device-uuid
  panel: Main
  url: https://example.com
```

### 6.3 Load a panel scene

```yaml
service: canvas_display.load_panel_scene
data:
  device_id: device-uuid
  panel: Main
  scene: published-scene-uuid
```

### 6.4 Hide a panel

```yaml
service: canvas_display.set_panel_visibility
data:
  device_id: device-uuid
  panel: Overlay
  visible: false
```

### 6.5 Automation example

```yaml
alias: Show front door camera on Canvas
triggers:
  - trigger: state
    entity_id: binary_sensor.front_door
    to: "on"
actions:
  - action: canvas_display.load_panel_url
    data:
      device_id: device-uuid
      panel: Camera
      url: https://camera.example.com/live
  - delay: "00:01:00"
  - action: canvas_display.load_device_page
    data:
      device_id: device-uuid
      page: default-page-uuid
```

## 7. AI and internal tools

Canvas Intelligence exposes:

### `navigate.page`

Switches connected displays to a page by ID or name.

```json
{
  "page": "Living Room"
}
```

### `navigate.panel`

Changes a panel on connected devices.

URL:

```json
{
  "panel": "Main",
  "content_type": "url",
  "url": "https://example.com"
}
```

Scene:

```json
{
  "panel": "Main",
  "content_type": "scene",
  "scene_id": "published-scene-uuid"
}
```

Visibility:

```json
{
  "panel": "Overlay",
  "visible": false
}
```

The AI tool resolves the panel against each connected device’s active page and reports how many devices accepted the command.

## 8. Editor controls

The Pages editor provides:

- Page creation, rename, and deletion
- Up to five panels per page
- URL/scene content selection
- Published-scene picker
- Panel geometry
- Layer order
- Visibility
- Opacity
- Device assignment
- Force Display

Editor changes modify the shared page definition. Per-device command overrides remain separate and are merged when Core constructs the effective page for that device.

## 9. Shared page definitions versus device overrides

There are two kinds of changes:

### Shared definition

Use page and panel CRUD routes or the editor.

Example:

```http
PATCH /api/pages/{pageId}/panels/{panelId}
```

This changes the panel for every device using that page.

### Per-device override

Use:

```http
POST /api/commands/panel
```

or MQTT/HA/AI equivalents.

This changes the panel only for the selected device. The base page definition is preserved.

## 10. Delivery semantics

For an active device page:

1. Core validates the page, panel, URL, or published scene.
2. Core stores the active page or per-device panel override.
3. Core merges the shared page with device-specific overrides.
4. Core creates a monotonic desired-state revision.
5. Core sends the complete effective page over authenticated WSS.
6. Edge forwards the page to the loopback renderer.
7. The renderer updates the kiosk and returns success.
8. Edge reports `applied`.
9. Core returns `delivered: true`.

Core does not report delivery merely because a message was queued.

### Common response states

| State | Meaning |
|---|---|
| `delivered: true` | Edge and renderer accepted the effective page |
| `delivered: false, queued: true` | Override stored for an inactive page |
| HTTP 400 | Invalid or incomplete command |
| HTTP 404 | Device, page, panel, or published scene not found |
| HTTP 409 | Current device/page state prevents immediate application |
| HTTP 401/403 | Authentication or authorization failure |
| `panel_delivery_failed` | Edge or renderer rejected the update |

## 11. Validation rules

- URLs must begin with `http://` or `https://`.
- Scene panels must reference published scenes.
- A page may contain at most five panels.
- Panel percentage geometry must fit inside the page.
- Opacity must be within the supported range.
- Panel names without page scoping must resolve unambiguously.
- Device-specific commands require a known Core device.
- MQTT must be enabled and connected in Core before MQTT commands are accepted.

## 12. Recommended interfaces

| Use case | Recommended interface |
|---|---|
| Human editing | Core Pages editor |
| Application integration | `POST /api/commands/panel` and page display API |
| Home automation | Canvas Display HA services |
| Event bus/device automation | Core MQTT topics |
| Natural-language control | `navigate.page` and `navigate.panel` AI tools |
| Bulk shared layout changes | Page/panel CRUD API |

For new integrations, prefer device-specific page activation and the unified panel command. The older `/api/commands/navigate` route remains for compatibility but only supports URL navigation and has less precise targeting.
