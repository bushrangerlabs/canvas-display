"""
Stdio JSON-RPC MCP server for web search and Wikipedia lookups.

Provides two tools that the AI can call to look up information and display
results on Canvas screens:

  web_search(query, max_results=5)
    - Searches the web using DuckDuckGo (no API key required)
    - Returns titles, snippets, and URLs

  wikipedia_lookup(topic, sentences=5)
    - Fetches a Wikipedia article summary for a topic
    - Returns the summary, URL, and key sections

Canvas Core's StdioMcpClient spawns this as a child process:
  command: python3
  args: ["/app/web_search_stdio.py"]

Install dependencies in the Core image (see Dockerfile):
  pip install duckduckgo_search wikipedia-api
"""
import asyncio
import json
import sys
from typing import Any


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


TOOLS = [
    {
        "name": "web_search",
        "description": (
            "Search the web for current information. Use this when asked about recent events, "
            "specific facts, news, how-to guides, or any topic where a web search would help provide "
            "a better answer. Returns page titles, snippets, and URLs."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query to look up"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (1-10, default 5)",
                    "default": 5
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "wikipedia_lookup",
        "description": (
            "Look up a topic on Wikipedia. Use this for encyclopedic knowledge: definitions, "
            "history, science, geography, people, places, events, concepts. Returns a summary "
            "and the article URL which can be displayed on screen."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "The topic to look up on Wikipedia"
                },
                "sentences": {
                    "type": "integer",
                    "description": "Number of summary sentences to return (1-10, default 5)",
                    "default": 5
                }
            },
            "required": ["topic"]
        }
    }
]


def _web_search(query: str, max_results: int = 5) -> dict[str, Any]:
    try:
        from duckduckgo_search import DDGS
        results = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max(1, min(10, max_results))):
                results.append({
                    "title": r.get("title", ""),
                    "snippet": r.get("body", ""),
                    "url": r.get("href", ""),
                })
        if not results:
            return {"error": "No results found", "query": query, "results": []}
        return {"query": query, "results": results, "count": len(results)}
    except ImportError:
        return {"error": "duckduckgo_search library not installed", "results": []}
    except Exception as e:
        return {"error": str(e), "results": []}


def _wikipedia_lookup(topic: str, sentences: int = 5) -> dict[str, Any]:
    try:
        import wikipediaapi
        wiki = wikipediaapi.Wikipedia(
            language="en",
            user_agent="CanvasCore/1.0 (canvas-display; contact@canvas.local)"
        )
        page = wiki.page(topic)
        if not page.exists():
            # Try a search fallback
            try:
                import wikipedia as wp
                suggestions = wp.search(topic, results=3)
                if suggestions:
                    page = wiki.page(suggestions[0])
                    topic = suggestions[0]
            except Exception:
                pass
        if not page.exists():
            return {"error": f"No Wikipedia article found for: {topic}", "topic": topic}

        # Truncate summary to requested sentences
        summary_full = page.summary
        summary_sentences = summary_full.split(". ")
        n = max(1, min(10, sentences))
        summary = ". ".join(summary_sentences[:n])
        if not summary.endswith(".") and summary:
            summary += "."

        # Get top-level sections
        sections = [s.title for s in page.sections if s.title and s.title != "References"][:8]

        return {
            "topic": page.title,
            "summary": summary,
            "url": page.fullurl,
            "sections": sections,
        }
    except ImportError:
        # Fallback to requests-based approach
        try:
            import urllib.request, urllib.parse
            encoded = urllib.parse.quote(topic)
            url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
            with urllib.request.urlopen(url, timeout=8) as resp:
                data = json.loads(resp.read().decode())
            extract = data.get("extract", "")
            extract_sentences = extract.split(". ")
            n = max(1, min(10, sentences))
            summary = ". ".join(extract_sentences[:n])
            if not summary.endswith(".") and summary:
                summary += "."
            return {
                "topic": data.get("title", topic),
                "summary": summary,
                "url": data.get("content_urls", {}).get("desktop", {}).get("page", ""),
                "sections": [],
                "thumbnail": data.get("thumbnail", {}).get("source", ""),
            }
        except Exception as e:
            return {"error": str(e), "topic": topic}
    except Exception as e:
        return {"error": str(e), "topic": topic}


async def handle(msg: dict) -> None:
    req_id = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params", {})

    if method == "initialize":
        _write({
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "canvas-web-search", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            }
        })

    elif method == "tools/list":
        _write({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})

    elif method == "tools/call":
        tool_name = params.get("name", "")
        args = params.get("arguments", {})
        try:
            if tool_name == "web_search":
                result = _web_search(
                    query=str(args.get("query", "")),
                    max_results=int(args.get("max_results", 5)),
                )
            elif tool_name == "wikipedia_lookup":
                result = _wikipedia_lookup(
                    topic=str(args.get("topic", "")),
                    sentences=int(args.get("sentences", 5)),
                )
            else:
                result = {"error": f"Unknown tool: {tool_name}"}

            _write({
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "isError": "error" in result,
                }
            })
        except Exception as e:
            _write({
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps({"error": str(e)})}],
                    "isError": True,
                }
            })

    elif method == "notifications/initialized":
        pass  # no response needed

    else:
        if req_id is not None:
            _write({
                "jsonrpc": "2.0", "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}
            })


async def main() -> None:
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await reader.readline()
            if not line:
                break
            line = line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            msg = json.loads(line)
            await handle(msg)
        except json.JSONDecodeError:
            pass
        except Exception as e:
            sys.stderr.write(f"[web-search-mcp] error: {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    asyncio.run(main())
