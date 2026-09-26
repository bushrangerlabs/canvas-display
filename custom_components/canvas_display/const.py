"""Constants for Canvas Display integration."""
DOMAIN = "canvas_display"
CONF_API_URL = "api_url"
CONF_API_TOKEN = "api_token"
# Core mode: poll Canvas Core's edge API and expose one media_player per
# registered device (Linux kiosk + native Android). HA's MQTT integration has no
# media_player platform, so this REST surface is the only supported path.
CONF_CORE_MODE = "core_mode"
CONF_EDGE_TOKEN = "edge_token"
