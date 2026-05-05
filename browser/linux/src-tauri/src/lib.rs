use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use std::io::Write;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use libc;

// ─── Sidecar state ──────────────────────────────────────────────────────────

struct ServerChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

// ─── Crash Log ────────────────────────────────────────────────────────────────

const LOG_PATH: &str = "/tmp/canvas-ui-kiosk.log";

fn klog(msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true).append(true).open(LOG_PATH)
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, msg);
        let _ = f.flush();
    }
    eprintln!("[canvas-ui] {}", msg);
}

/// Quit the application cleanly via Tauri's own exit — closes all windows
/// and webviews before the process terminates.
#[tauri::command]
fn quit_app(app: AppHandle) {
    klog("[quit_app] quitting on server command");
    app.exit(0);
    // Hard fallback in case app.exit doesn't terminate the process
    std::process::exit(0);
}

/// Turn the display off using xset (Linux only)
#[tauri::command]
async fn screen_off(app: AppHandle) -> Result<(), String> {
    app.shell()
        .command("xset")
        .args(["dpms", "force", "off"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Turn the display on using xset (Linux only)
#[tauri::command]
async fn screen_on(app: AppHandle) -> Result<(), String> {
    app.shell()
        .command("xset")
        .args(["dpms", "force", "on"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Set display brightness using xrandr. brightness is 0.0–1.0.
/// Requires knowing the output name (e.g. HDMI-1, eDP-1).
/// Tries common output names until one works.
#[tauri::command]
async fn set_brightness(app: AppHandle, brightness: f32) -> Result<(), String> {
    let clamped = brightness.clamp(0.0, 1.0);
    let outputs = ["eDP-1", "HDMI-1", "HDMI-2", "DP-1", "DP-2", "VGA-1"];
    for output in &outputs {
        let result = app.shell()
            .command("xrandr")
            .args(["--output", output, "--brightness", &clamped.to_string()])
            .output()
            .await;
        if let Ok(out) = result {
            if out.status.success() {
                return Ok(());
            }
        }
    }
    Err("Failed to set brightness — no matching display output found".into())
}

/// Prevent display from sleeping (DPMS disable)
#[tauri::command]
async fn keep_screen_on(app: AppHandle) -> Result<(), String> {
    app.shell()
        .command("xset")
        .args(["s", "off", "-dpms"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Navigate an existing WebviewWindow to a new URL.
/// Must run on the GTK main thread on Linux — same restriction as build().
#[tauri::command]
async fn navigate_webview(app: AppHandle, label: String, url: String) -> Result<(), String> {
    klog(&format!("[navigate_webview] label={} url={}", label, url));
    let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = app_handle.get_webview_window(&label) {
            if let Err(e) = win.navigate(parsed) {
                eprintln!("[navigate_webview] failed '{}': {}", label, e);
            }
        } else {
            eprintln!("[navigate_webview] no webview '{}'", label);
        }
    }).map_err(|e| e.to_string())
}

/// Close a WebviewWindow by label.
/// Must run on the GTK main thread on Linux.
#[tauri::command]
async fn close_webview(app: AppHandle, label: String) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = app_handle.get_webview_window(&label) {
            if let Err(e) = win.close() {
                eprintln!("[close_webview] failed '{}': {}", label, e);
            }
        }
    }).map_err(|e| e.to_string())
}

/// Get the app version from Cargo.toml
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn create_panel_webview(
    app: AppHandle,
    label: String,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    title: String,
    visible: bool,
    ingress_session: Option<String>,
    init_script: Option<String>,
) -> Result<(), String> {
    klog(&format!("[create_panel_webview] label={} url={}", label, url));
    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let app_handle = app.clone();

    app.run_on_main_thread(move || {
        klog(&format!("[create_panel_webview] on main thread, building '{}'", label));
        let mut builder = tauri::WebviewWindowBuilder::new(
            &app_handle,
            &label,
            tauri::WebviewUrl::External(parsed_url),
        )
        .position(x as f64, y as f64)
        .inner_size(width as f64, height as f64)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(visible)
        .title(&title)
        .incognito(false);

        if let Some(session) = ingress_session {
            let safe_session: String = session.chars()
                .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            let script = format!(
                r#"document.cookie = "ingress_session={}; path=/; max-age=3600";"#,
                safe_session
            );
            builder = builder.initialization_script(&script);
        }

        if let Some(script) = init_script {
            builder = builder.initialization_script(&script);
        }

        klog(&format!("[create_panel_webview] calling builder.build() for '{}'", label));
        match builder.build() {
            Err(e) => {
                klog(&format!("[create_panel_webview] BUILD FAILED '{}': {}", label, e));
                eprintln!("[create_panel_webview] failed to build '{}': {}", label, e);
            }
            Ok(win) => {
                klog(&format!("[create_panel_webview] build OK for '{}'", label));
                #[cfg(target_os = "linux")]
                let label2 = label.clone();
                #[cfg(target_os = "linux")]
                let _ = win.with_webview(move |wv| {
                    use webkit2gtk::{ProcessModel, SettingsExt, WebContextExt, WebViewExt};
                    let wk = wv.inner();

                    // Force each webview into its own web process — prevents the
                    // null-ptr SIGSEGV in libwebkit2gtk when multiple same-origin
                    // pages (e.g. two HA URLs) share a single WebKit secondary process
                    // and race-crash during heavy JavaScript initialisation.
                    if let Some(ctx) = wk.web_context() {
                        ctx.set_process_model(ProcessModel::MultipleSecondaryProcesses);
                        klog(&format!("[{}] process model set to MultipleSecondaryProcesses", label2));
                    }

                    if let Some(settings) = wk.settings() {
                        settings.set_hardware_acceleration_policy(
                            webkit2gtk::HardwareAccelerationPolicy::Never,
                        );
                        settings.set_enable_page_cache(false);
                        klog(&format!("[{}] webkit settings applied", label2));
                    }
                });
                klog(&format!("[create_panel_webview] done '{}'", label));
            }
        }
    }).map_err(|e| e.to_string())
}

pub fn run() {
    // Truncate/create the log file fresh on each run
    let _ = std::fs::write(LOG_PATH, "");
    klog("=== Canvas UI kiosk starting ===");

    // Set WebKit2GTK environment variables before anything initializes.
    #[cfg(target_os = "linux")]
    {
        unsafe { std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1"); }
        unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1"); }
        unsafe { std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1"); }
        // Disable DMA-BUF renderer — can produce NULL GdkGLContext on software GL,
        // triggering a null-ptr crash in WebKit's rendering pipeline (offset +0x48).
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1"); }
        // JSC_useLLInt removed — forces HA's massive JS to run 10x slower through the
        // bytecode interpreter, creating timing windows that trigger null-pointer crashes
        // in WebKit's GObject layer. JIT is stable on 2.50.4 without LLInt enforcement.
        klog("env vars set: SANDBOX disabled, COMPOSITING disabled, SW GL, DMABUF disabled");
    }

    // Panic hook — write to log before process unwinds
    std::panic::set_hook(Box::new(|info| {
        klog(&format!("PANIC: {}", info));
        eprintln!("[canvas-ui] PANIC: {}", info);
    }));

    // Raw signal handlers — catch SIGSEGV/SIGABRT from deep inside GTK/WebKit.
    // We write to the log file then re-raise to get a proper core dump.
    #[cfg(target_os = "linux")]
    unsafe {
        unsafe extern "C" fn fatal_handler(sig: libc::c_int) {
            let msg = match sig {
                libc::SIGSEGV => "SIGNAL: SIGSEGV (segmentation fault)",
                libc::SIGABRT => "SIGNAL: SIGABRT (abort)",
                libc::SIGBUS  => "SIGNAL: SIGBUS (bus error)",
                _             => "SIGNAL: unknown fatal signal",
            };
            // Write directly — async-signal-safe path
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true).append(true).open(LOG_PATH)
            {
                let _ = std::io::Write::write_all(&mut f, msg.as_bytes());
                let _ = std::io::Write::write_all(&mut f, b"\n");
            }
            // Reset to default and re-raise so we still get a core dump
            libc::signal(sig, libc::SIG_DFL);
            libc::raise(sig);
        }
        libc::signal(libc::SIGSEGV, fatal_handler as libc::sighandler_t);
        libc::signal(libc::SIGABRT, fatal_handler as libc::sighandler_t);
        libc::signal(libc::SIGBUS,  fatal_handler as libc::sighandler_t);
        klog("signal handlers installed: SIGSEGV SIGABRT SIGBUS");
    }

    klog("building Tauri app...");
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            screen_off,
            screen_on,
            set_brightness,
            keep_screen_on,
            app_version,
            navigate_webview,
            close_webview,
            create_panel_webview,
        ])
        .setup(|app| {
            // ── Spawn embedded server sidecar ──────────────────────────────
            let data_dir = app.path().app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/canvas-ui"));
            std::fs::create_dir_all(&data_dir).ok();
            let data_dir_str = data_dir.to_string_lossy().to_string();
            klog(&format!("setup: data dir = {}", data_dir_str));

            // Pass resource dir so sidecar can locate native .node bindings and static assets
            let binaries_resource_dir = app.path().resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
                .join("binaries");
            let binaries_dir_str = binaries_resource_dir.to_string_lossy().to_string();
            let static_dir_str = binaries_resource_dir.join("public").to_string_lossy().to_string();
            klog(&format!("setup: resource binaries dir = {}", binaries_dir_str));

            match app.shell()
                .sidecar("canvas-display-server")
                .expect("canvas-display-server sidecar not found")
                .env("CANVAS_DATA_DIR", &data_dir_str)
                .env("NATIVE_BINDING_DIR", &binaries_dir_str)
                .env("STATIC_DIR", &static_dir_str)
                .env("PORT", "3100")
                .env("HOST", "0.0.0.0")
                .spawn()
            {
                Ok((_rx, child)) => {
                    klog("setup: canvas-display-server sidecar started");
                    app.manage(ServerChild(Mutex::new(Some(child))));
                }
                Err(e) => {
                    klog(&format!("setup: failed to start sidecar: {}", e));
                    // Non-fatal — app still works without the server (kiosk display only)
                    app.manage(ServerChild(Mutex::new(None)));
                }
            }

            #[cfg(target_os = "linux")]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.with_webview(|wv| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    let wk = wv.inner();
                    if let Some(settings) = wk.settings() {
                        settings.set_hardware_acceleration_policy(
                            webkit2gtk::HardwareAccelerationPolicy::Never,
                        );
                    }
                });
            }
            klog("setup: main window ready, spawning keep_screen_on");

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = keep_screen_on(app_handle).await;
            });
            klog("setup: done");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Canvas UI")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill the embedded server on exit
                if let Some(state) = app_handle.try_state::<ServerChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            klog("exit: killing canvas-display-server sidecar");
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
