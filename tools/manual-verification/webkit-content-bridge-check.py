#!/usr/bin/env python3
"""
Manual, non-production, dev-only verification harness for Phase 0.

Loads the Content Bridge prototype's YouTube player page in a REAL
WebKitGTK WebView (the same engine Canvas Display's kiosk/Tauri webview
uses) on the actual X11/Wayland display, and observes the page's own
`fetch()` calls to its loopback `/events` endpoint by monkey-patching
`window.fetch` via an injected UserScript (main world, top frame only —
never touches the cross-origin youtube.com iframe).

This does NOT modify edge/content-bridge-prototype/*. It is purely an
external observer of events the prototype's own client JS already sends.

Usage:
    python3 webkit-content-bridge-check.py <bridge-log-file> [timeout-seconds]

The bridge log file must contain a line printed by manual.ts:
    Open this development-only URL in the target WebKitGTK WebView:
    http://127.0.0.1:PORT/v1/youtube/SESSIONID#claim=TOKEN

Exit codes:
    0  -> observed a `playing` event (genuine positive evidence)
    1  -> observed `identity_error` (YouTube error 153) or `player_error`
    2  -> timed out with no terminal event (inconclusive)
    3  -> usage / setup error (couldn't find URL, couldn't create WebView, etc.)

All captured events are printed as JSON to stdout regardless of outcome.
"""
import gi
import json
import re
import sys
import time

gi.require_version('WebKit2', '4.1')
gi.require_version('Gtk', '3.0')

from gi.repository import WebKit2, Gtk, GLib  # noqa: E402

URL_LINE_RE = re.compile(r'(http://127\.0\.0\.1:\d+/v1/youtube/\S+)')

# Injected into the MAIN WORLD of the TOP FRAME ONLY. It never runs inside
# the youtube.com iframe (cross-origin frames are not touched at all),
# so this cannot interfere with YouTube's own player script execution.
FETCH_INTERCEPT_SCRIPT = """
(function () {
  if (window.__canvasTestPatched) return;
  window.__canvasTestPatched = true;

  function post(kind, extra) {
    try {
      window.webkit.messageHandlers.canvasTest.postMessage(
        JSON.stringify(Object.assign({ kind: kind }, extra || {}))
      );
    } catch (e) { /* ignore */ }
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/events') !== -1 && init && init.method === 'POST' && init.body) {
        try {
          const parsed = JSON.parse(init.body);
          post('event_report', { payload: parsed });
        } catch (e) {
          post('parse_error', { error: String(e) });
        }
      }
    } catch (e) {
      // never let instrumentation break the page's real fetch call
    }
    return originalFetch.apply(this, arguments);
  };

  window.addEventListener('error', function (event) {
    post('window_error', {
      message: event.message,
      source: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  });

  const originalConsoleError = console.error.bind(console);
  console.error = function () {
    try {
      post('console_error', { args: Array.prototype.slice.call(arguments).map(String) });
    } catch (e) { /* ignore */ }
    return originalConsoleError.apply(console, arguments);
  };

  const originalConsoleWarn = console.warn.bind(console);
  console.warn = function () {
    try {
      post('console_warn', { args: Array.prototype.slice.call(arguments).map(String) });
    } catch (e) { /* ignore */ }
    return originalConsoleWarn.apply(console, arguments);
  };
})();
"""


def find_bridge_url(log_path):
    with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
        contents = f.read()
    match = URL_LINE_RE.search(contents)
    if not match:
        return None
    return match.group(1).strip()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'usage', 'message': 'expected <bridge-log-file> [timeout-seconds]'}))
        sys.exit(3)

    log_path = sys.argv[1]
    timeout_seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 25

    url = find_bridge_url(log_path)
    if not url:
        print(json.dumps({'error': 'bridge_url_not_found', 'log_path': log_path}))
        sys.exit(3)

    captured_events = []
    result = {'outcome': 'timeout', 'events': captured_events, 'url_used': url}

    content_manager = WebKit2.UserContentManager()
    user_script = WebKit2.UserScript(
        FETCH_INTERCEPT_SCRIPT,
        WebKit2.UserContentInjectedFrames.TOP_FRAME,
        WebKit2.UserScriptInjectionTime.START,
        None,
        None,
    )
    content_manager.add_script(user_script)

    window = Gtk.Window()
    window.set_default_size(640, 480)
    webview = WebKit2.WebView.new_with_user_content_manager(content_manager)
    window.add(webview)

    loop_holder = {'quit': False}

    def quit_loop(outcome):
        if loop_holder['quit']:
            return
        loop_holder['quit'] = True
        result['outcome'] = outcome
        Gtk.main_quit()

    def on_script_message(_manager, js_result):
        try:
            js_value = js_result.get_js_value()
            raw = js_value.to_string()
            message = json.loads(raw)
        except Exception as error:  # noqa: BLE001
            captured_events.append({'kind': 'decode_error', 'error': str(error)})
            return

        if message.get('kind') != 'event_report':
            captured_events.append(message)
            return

        payload = message.get('payload', {})
        payload['_t_seconds_since_load'] = round(time.monotonic() - start_time, 3)
        captured_events.append(payload)
        event_name = payload.get('event')
        if event_name == 'playing':
            quit_loop('playing')
        elif event_name == 'identity_error':
            quit_loop('identity_error_153')
        elif event_name == 'player_error':
            quit_loop('player_error')
        elif event_name == 'exhausted':
            quit_loop('exhausted')

    content_manager.register_script_message_handler('canvasTest')
    content_manager.connect('script-message-received::canvasTest', on_script_message)

    def on_timeout():
        quit_loop('timeout')
        return False

    GLib.timeout_add_seconds(timeout_seconds, on_timeout)

    start_time = time.monotonic()
    webview.load_uri(url)
    window.show_all()

    Gtk.main()

    print(json.dumps(result, indent=2))

    outcome = result['outcome']
    if outcome == 'playing':
        sys.exit(0)
    elif outcome in ('identity_error_153', 'player_error'):
        sys.exit(1)
    elif outcome == 'timeout':
        sys.exit(2)
    else:
        sys.exit(2)


if __name__ == '__main__':
    main()
