# Canvas SIP intercom

Asterisk in Docker, providing a SIP registrar + dialplan for the Echo-style
intercom. This is the **optional SIP transport** for the audio-broadcast
feature; the existing TTS/intercom broadcast (Core `/api/edge/*/broadcast` +
edge pollers) works without it.

## What it gives you

- SIP registrar on UDP/TCP `5060` (host network).
- Endpoints `1001`, `1002`, `1003` — one per edge device.
- Dialplan:
  - `1001` / `1002` / `1003` — call a single device.
  - `8000` — **page all** registered endpoints (one-way broadcast).

## Deploy (on the Core host, 192.168.1.108)

```sh
cd deploy/sip
docker compose up -d
docker logs -f canvas-sip
```

## Configure

1. Set a real password for each endpoint in `config/pjsip.conf` (replace
   `CHANGE_ME`). Do not commit real passwords.
2. Register each edge device as a SIP client (softphone / SIP library) using
   its endpoint number + password, pointing at the host IP.
3. Reload Asterisk after config changes: `docker exec canvas-sip asterisk -rx "pjsip reload"`.

## Notes / next steps

- `Page()` requires `app_page.so` (autoloaded).
- RTP uses `10000-10100/udp`; `network_mode: host` avoids NAT on a LAN.
- The edge apps do not yet embed a SIP client — wiring the devices to register
  and stream audio is the remaining integration step.
