/**
 * Thin invoke wrapper for the Android kiosk app.
 *
 * Commands that are handled by the native MultiWebViewPlugin are forwarded to
 * `plugin:multiwebview|<camelCase>`. Everything else is passed straight through
 * to @tauri-apps/api/core.
 *
 * The Tauri runtime converts the snake_case command name to lowerCamelCase via
 * `heck::AsLowerCamelCase` before dispatching to Kotlin, so the JS side can use
 * the same snake_case names as the Linux app.
 */
import { invoke as _invoke } from '@tauri-apps/api/core';

/** Commands handled by the Kotlin MultiWebViewPlugin. */
const PLUGIN_COMMANDS = new Set([
  'create_panel_webview',
  'navigate_webview',
  'close_webview',
  'show_webview',
  'hide_webview',
  'get_all_webview_labels',
  'screen_off',
  'screen_on',
  'set_brightness',
  'keep_screen_on',
]);

export function invoke<T = void>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (PLUGIN_COMMANDS.has(cmd)) {
    return _invoke<T>(`plugin:multiwebview|${cmd}`, args);
  }
  return _invoke<T>(cmd, args);
}
