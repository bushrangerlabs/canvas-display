use tauri::AppHandle;

/// Quit the application cleanly.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Get the app version from Cargo.toml.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_multiwebview::init())
        .invoke_handler(tauri::generate_handler![
            quit_app,
            app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error building Canvas Display Android");
}
