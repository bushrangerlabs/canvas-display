"""
Stdio JSON-RPC MCP runner for craigles75/au-weather-mcp.

Replaces the au-weather-mcp-http HTTP bridge: instead of wrapping the upstream
server in a FastAPI/uvicorn HTTP container, this script runs directly inside the
Canvas Core container and exposes the same MCP tools over stdin/stdout
(newline-delimited JSON-RPC 2.0 — the MCP stdio transport).

Canvas Core's StdioMcpClient spawns this as a child process:
  command: python3
  args: ["/app/au_weather_stdio.py"]

Install the upstream package in the Core image (see Dockerfile):
  pip install git+https://github.com/craigles75/au-weather-mcp.git@<commit>
"""
import asyncio
import json
import sys

# The au-weather-mcp package exposes list_tools() and call_tool() at module level.
import server as upstream  # type: ignore[import]


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def handle(msg: dict) -> None:
    req_id = msg.get("id")
    method = msg.get("method", "")

    # Notifications (no id) — acknowledged but no response sent.
    if req_id is None:
        return

    try:
        if method == "initialize":
            result: dict = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "au-weather-mcp", "version": "0.1.0"},
            }
        elif method == "tools/list":
            tools = await upstream.list_tools()
            result = {
                "tools": [
                    t.model_dump(by_alias=True, exclude_none=True) for t in tools
                ]
            }
        elif method == "tools/call":
            params = msg.get("params") or {}
            content = await upstream.call_tool(
                params.get("name", ""), params.get("arguments") or {}
            )
            result = {
                "content": [
                    c.model_dump(by_alias=True, exclude_none=True) for c in content
                ],
                "isError": False,
            }
        else:
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }
            )
            return
    except Exception as exc:  # noqa: BLE001
        _write(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": str(exc)[:500]},
            }
        )
        return

    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


async def main() -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await reader.readline()
        except Exception:
            break
        if not line:
            break
        stripped = line.strip()
        if not stripped:
            continue
        try:
            msg = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        await handle(msg)


if __name__ == "__main__":
    asyncio.run(main())
