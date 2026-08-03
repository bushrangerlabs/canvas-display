"""Tool schemas visible to Hermes for Canvas Display plugin."""

WEB_SEARCH_TO_URL = {
    "name": "web_search_to_url",
    "description": (
        "Resolve a web query to a reliable URL with search fallback. "
        "Use this before opening generic websites when the user gives a topic, not a direct URL."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Web search query text to resolve into a URL",
            }
        },
        "required": ["query"],
    },
}

YOUTUBE_SEARCH_TO_URL = {
    "name": "youtube_search_to_url",
    "description": (
        "Build a YouTube search URL from query text. "
        "Use for media requests when the user asks to play or find content on YouTube."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query for YouTube",
            }
        },
        "required": ["query"],
    },
}

CANVAS_SET_PAGE = {
    "name": "canvas_set_page",
    "description": "Set active Canvas page by page_id or page name.",
    "parameters": {
        "type": "object",
        "properties": {
            "page_id": {"type": "string", "description": "Canvas page id"},
            "page": {"type": "string", "description": "Canvas page name"},
        },
        "required": [],
    },
}

CANVAS_NAVIGATE_PANEL = {
    "name": "canvas_navigate_panel",
    "description": "Navigate a Canvas panel to a URL by panel_id or panel name.",
    "parameters": {
        "type": "object",
        "properties": {
            "panel_id": {"type": "string", "description": "Panel id"},
            "panel": {"type": "string", "description": "Panel name"},
            "page_id": {"type": "string", "description": "Optional page id"},
            "page": {"type": "string", "description": "Optional page name"},
            "url": {"type": "string", "description": "Target URL"},
        },
        "required": ["url"],
    },
}

CANVAS_MEDIA_PLAY = {
    "name": "canvas_media_play",
    "description": (
        "Play media through Canvas unified media API. "
        "Supports source types: music_assistant, radio_browser, direct_audio, youtube."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "enum": ["music_assistant", "radio_browser", "direct_audio", "youtube"],
                "description": "Media source adapter to use",
            },
            "url": {"type": "string", "description": "Media URL or YouTube URL/video id"},
            "title": {"type": "string", "description": "Optional display title"},
            "volume": {"type": "number", "description": "Optional volume (0-100)"},
            "panel_id": {
                "type": "string",
                "description": "Optional target panel id for YouTube webview playback",
            },
        },
        "required": ["source", "url"],
    },
}

CANVAS_MEDIA_CONTROL = {
    "name": "canvas_media_control",
    "description": (
        "Control media playback through Canvas unified media API. "
        "Actions: pause, resume, stop, volume, mute."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "enum": ["music_assistant", "radio_browser", "direct_audio", "youtube"],
                "description": "Media source adapter to control",
            },
            "action": {
                "type": "string",
                "enum": ["pause", "resume", "stop", "volume", "mute"],
                "description": "Playback action",
            },
            "level": {"type": "number", "description": "Required for volume action (0-100)"},
            "muted": {"type": "boolean", "description": "Required for mute action"},
        },
        "required": ["source", "action"],
    },
}
