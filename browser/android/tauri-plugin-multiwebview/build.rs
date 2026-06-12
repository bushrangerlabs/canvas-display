const COMMANDS: &[&str] = &[
    "create_panel_webview",
    "navigate_webview",
    "close_webview",
    "show_webview",
    "hide_webview",
    "get_all_webview_labels",
    "screen_off",
    "screen_on",
    "set_brightness",
    "keep_screen_on",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
