use tauri::{plugin::PluginApi, AppHandle, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.multiwebview";

pub fn init<R: Runtime>(
    _app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> tauri::Result<()> {
    #[cfg(target_os = "android")]
    let _handle =
        api.register_android_plugin(PLUGIN_IDENTIFIER, "MultiWebViewPlugin")?;
    Ok(())
}
