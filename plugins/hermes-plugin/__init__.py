"""Canvas Display Hermes plugin registration."""

from . import schemas, tools


def register(ctx):
    """Register Canvas tools for Hermes."""
    ctx.register_tool(
        name="web_search_to_url",
        toolset="canvas_display",
        schema=schemas.WEB_SEARCH_TO_URL,
        handler=tools.web_search_to_url,
    )
    ctx.register_tool(
        name="youtube_search_to_url",
        toolset="canvas_display",
        schema=schemas.YOUTUBE_SEARCH_TO_URL,
        handler=tools.youtube_search_to_url,
    )
    ctx.register_tool(
        name="canvas_set_page",
        toolset="canvas_display",
        schema=schemas.CANVAS_SET_PAGE,
        handler=tools.canvas_set_page,
    )
    ctx.register_tool(
        name="canvas_navigate_panel",
        toolset="canvas_display",
        schema=schemas.CANVAS_NAVIGATE_PANEL,
        handler=tools.canvas_navigate_panel,
    )
    ctx.register_tool(
        name="canvas_media_play",
        toolset="canvas_display",
        schema=schemas.CANVAS_MEDIA_PLAY,
        handler=tools.canvas_media_play,
    )
    ctx.register_tool(
        name="canvas_media_control",
        toolset="canvas_display",
        schema=schemas.CANVAS_MEDIA_CONTROL,
        handler=tools.canvas_media_control,
    )
