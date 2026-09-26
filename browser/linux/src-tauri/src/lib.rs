#[cfg(target_os = "linux")]
use libc;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

// ─── Sidecar state ──────────────────────────────────────────────────────────

struct ServerChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelLoadEvent {
    label: String,
    ok: bool,
    error: Option<String>,
}

// ─── Crash Log ────────────────────────────────────────────────────────────────

const LOG_PATH: &str = "/tmp/canvas-ui-kiosk.log";

fn klog(msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(LOG_PATH)
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

/// Hide or show the kiosk window. Hide reveals the Pi OS desktop underneath;
/// show brings the kiosk back to fullscreen foreground. Called from the
/// controller webview for Core's remote "hide"/"show" app actions. The process
/// (and its Core WebSocket) stay alive throughout so resume is instant.
///
/// Uses the *injected* WebviewWindow (the window the controller webview runs in)
/// rather than looking windows up by label with `get_webview_window`, because on
/// this kiosk build the window's `is_webview_window()` is false and the
/// `webview_windows()`/`get_webview_window("main")` lookups both return empty.
#[tauri::command]
async fn set_kiosk_visible(
    app: AppHandle,
    window: tauri::Window,
    visible: bool,
) -> Result<(), String> {
    klog(&format!(
        "[set_kiosk_visible] requested {} (window label = '{}')",
        if visible { "show" } else { "hide" },
        window.label()
    ));
    app.run_on_main_thread(move || {
        if visible {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.set_fullscreen(true);
            klog("[set_kiosk_visible] shown + fullscreen");
        } else {
            // A fullscreen window on some compositors ignores hide(); exit
            // fullscreen first so hide() can actually unmap it.
            let _ = window.set_fullscreen(false);
            let hide_res = window.hide();
            klog(&format!("[set_kiosk_visible] hidden -> {:?}", hide_res));
        }
    })
    .map_err(|e| e.to_string())
}

/// Returns the main kiosk window's monitor bounds in Tauri logical pixels. Panel
/// windows use the same logical coordinate space, avoiding CSS screen metrics
/// drifting from the compositor's real output geometry.
#[tauri::command]
fn display_geometry(window: tauri::WebviewWindow) -> Result<DisplayGeometry, String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor is available for the kiosk window".to_string())?;
    let scale = monitor.scale_factor();
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    Ok(DisplayGeometry {
        x: position.x.round() as i32,
        y: position.y.round() as i32,
        width: size.width.round().max(1.0) as u32,
        height: size.height.round().max(1.0) as u32,
    })
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
        let result = app
            .shell()
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

/// Navigate an existing child webview or top-level WebviewWindow to a new URL.
/// Must run on the GTK main thread on Linux — same restriction as build().
#[tauri::command]
async fn navigate_webview(app: AppHandle, label: String, url: String) -> Result<(), String> {
    klog(&format!("[navigate_webview] label={} url={}", label, url));
    let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(webview) = app_handle.get_webview(&label) {
            if let Err(e) = webview.navigate(parsed) {
                eprintln!("[navigate_webview] failed '{}': {}", label, e);
            }
        } else if let Some(win) = app_handle.get_webview_window(&label) {
            if let Err(e) = win.navigate(parsed) {
                eprintln!("[navigate_webview] failed '{}': {}", label, e);
            }
        } else {
            eprintln!("[navigate_webview] no webview '{}'", label);
        }
    })
    .map_err(|e| e.to_string())
}

/// Close a child webview or top-level WebviewWindow by label.
/// Must run on the GTK main thread on Linux.
#[tauri::command]
async fn close_webview(app: AppHandle, label: String) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(webview) = app_handle.get_webview(&label) {
            if let Err(e) = webview.close() {
                eprintln!("[close_webview] failed '{}': {}", label, e);
            }
        } else if let Some(win) = app_handle.get_webview_window(&label) {
            if let Err(e) = win.close() {
                eprintln!("[close_webview] failed '{}': {}", label, e);
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_webview_visibility(
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(webview) = app_handle.get_webview(&label) {
            let result = if visible {
                webview.show()
            } else {
                webview.hide()
            };
            if let Err(e) = result {
                eprintln!("[set_webview_visibility] failed '{}': {}", label, e);
            }
        } else if let Some(win) = app_handle.get_webview_window(&label) {
            let result = if visible { win.show() } else { win.hide() };
            if let Err(e) = result {
                eprintln!("[set_webview_visibility] failed '{}': {}", label, e);
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_panel_webviews(app: AppHandle) -> Result<(), String> {
    // Invalidate any in-flight panel-creation batch before closing — a batch
    // that starts creating panels after this point belongs to a newer page.
    PANEL_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        for (label, webview) in app_handle.webviews() {
            if label.starts_with("panel-") {
                if let Err(e) = webview.close() {
                    eprintln!("[close_panel_webviews] failed '{}': {}", label, e);
                }
            }
        }
    })
    .map_err(|e| e.to_string())
}

/// Execute one fixed YouTube control in an existing player WebviewWindow.
/// The action is allowlisted so callers cannot inject arbitrary JavaScript.
#[tauri::command]
async fn control_youtube_webview(
    app: AppHandle,
    label: String,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    // `method` is checked for existence, then called with `args`. The action is
    // allowlisted so callers cannot inject JS.
    let (method, args) = match action.as_str() {
        "pause" => ("pause", String::new()),
        "resume" => ("resume", String::new()),
        "stop" => ("stop", String::new()),
        "next" => ("next", String::new()),
        "previous" => ("previous", String::new()),
        "volume" => (
            "volume",
            format!("{}", value.unwrap_or(100.0).clamp(0.0, 100.0)),
        ),
        "mute" => ("mute", format!("{}", value.unwrap_or(1.0) != 0.0)),
        _ => return Err(format!("unsupported YouTube control: {action}")),
    };
    // Prefer the YouTube IFrame API bridge; fall back to plain HTML5 media control
    // (matches the Android edge, which controls non-YouTube <video>/<audio> too).
    let html5 = match action.as_str() {
        "pause" => "document.querySelectorAll('video,audio').forEach(function(m){m.pause()})",
        "resume" => "document.querySelectorAll('video,audio').forEach(function(m){m.play().catch(function(){})})",
        "stop" => "document.querySelectorAll('video,audio').forEach(function(m){m.pause();m.currentTime=0})",
        _ => "",
    };
    let script = format!(
        "(function(){{try{{if(window.__canvasYouTubeControl&&window.__canvasYouTubeControl.{method}){{window.__canvasYouTubeControl.{method}({args});return true;}}{html5};return true}}catch(e){{return false}}}})()"
    );
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let eval_on = |label: &str| -> bool {
            if let Some(webview) = app_handle.get_webview(label) {
                return webview.eval(&script).is_ok();
            }
            if let Some(win) = app_handle.get_webview_window(label) {
                return win.eval(&script).is_ok();
            }
            false
        };
        if eval_on(&label) {
            return;
        }
        // The requested label is gone (e.g. no floating overlay): fall back to the
        // last panel webview so YouTube playing inside a panel is still controllable.
        let mut panels: Vec<String> = app_handle
            .webviews()
            .keys()
            .filter(|candidate| candidate.starts_with("panel-"))
            .cloned()
            .collect();
        panels.sort();
        match panels.last() {
            Some(last) => {
                if !eval_on(last) {
                    eprintln!(
                        "[control_youtube_webview] no webview '{}' or panel to control",
                        label
                    );
                }
            }
            None => eprintln!("[control_youtube_webview] no webview '{}'", label),
        }
    })
    .map_err(|e| e.to_string())
}

/// Get the app version from Cargo.toml
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Read the Edge device identity from the Agent's IPC socket.
/// Returns JSON with `device_id`, `installation_id`, and `public_key_fingerprint`.
#[tauri::command]
async fn get_device_identity() -> Result<String, String> {
    use std::os::unix::net::UnixStream;

    let socket_path = std::path::Path::new("/run/canvas-edge/agent.sock");
    if !socket_path.exists() {
        // Fallback: try the data-dir path for dev setups
        let fallback = std::path::Path::new("/tmp/canvas-edge/agent.sock");
        if !fallback.exists() {
            return Err(
                "Edge Agent IPC socket not found at /run/canvas-edge/agent.sock".to_string(),
            );
        }
        let mut stream =
            UnixStream::connect(fallback).map_err(|e| format!("connect to IPC: {e}"))?;
        return read_device_identity(&mut stream);
    }

    let mut stream =
        UnixStream::connect(socket_path).map_err(|e| format!("connect to IPC: {e}"))?;
    read_device_identity(&mut stream)
}

/// Execute an allowlisted renderer action through the Edge Agent's authenticated local IPC.
#[tauri::command]
async fn edge_ipc(method: String, arguments: serde_json::Value) -> Result<String, String> {
    use std::os::unix::net::UnixStream;

    let primary = std::path::Path::new("/run/canvas-edge/agent.sock");
    let fallback = std::path::Path::new("/tmp/canvas-edge/agent.sock");
    let socket_path = if primary.exists() { primary } else { fallback };
    let mut stream =
        UnixStream::connect(socket_path).map_err(|e| format!("connect to Edge IPC: {e}"))?;
    dispatch_edge_ipc(&mut stream, &method, arguments)
}

/// Optional remote Core control channel. The kiosk continues to use its local
/// sidecar for rendering/content, while commands and diagnostics arrive from Core.
#[tauri::command]
fn core_control_config() -> serde_json::Value {
    serde_json::json!({
        "serverUrl": std::env::var("CANVAS_CORE_CONTROL_URL").ok(),
        "deviceId": std::env::var("CANVAS_CORE_DEVICE_ID").ok(),
    })
}

fn dispatch_edge_ipc(
    stream: &mut std::os::unix::net::UnixStream,
    method: &str,
    arguments: serde_json::Value,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};

    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut session_line = String::new();
    reader
        .read_line(&mut session_line)
        .map_err(|e| format!("read IPC session: {e}"))?;
    let session: serde_json::Value =
        serde_json::from_str(&session_line).map_err(|e| format!("parse IPC session: {e}"))?;
    let capability_token = session["capability_token"]
        .as_str()
        .ok_or_else(|| "missing IPC capability token".to_string())?;

    let request = serde_json::json!({
        "capability_token": capability_token,
        "method": method,
        "arguments": arguments,
    });
    let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .map_err(|e| format!("write IPC request: {e}"))?;

    let mut response_line = String::new();
    reader
        .read_line(&mut response_line)
        .map_err(|e| format!("read IPC response: {e}"))?;
    let response: serde_json::Value =
        serde_json::from_str(&response_line).map_err(|e| format!("parse IPC response: {e}"))?;
    if response["ok"].as_bool() == Some(true) {
        return response["result"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "IPC response is missing its result".to_string());
    }
    let message = response
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .or_else(|| response["message"].as_str())
        .or_else(|| response["error"].as_str())
        .unwrap_or("Edge IPC action failed");
    Err(message.to_string())
}

fn read_device_identity(stream: &mut std::os::unix::net::UnixStream) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};

    // Read the session handshake line
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut session_line = String::new();
    reader
        .read_line(&mut session_line)
        .map_err(|e| format!("read session: {e}"))?;

    // Parse the session to get our capability token
    let session: serde_json::Value =
        serde_json::from_str(&session_line).map_err(|e| format!("parse session: {e}"))?;
    let capability_token = session["capability_token"]
        .as_str()
        .ok_or_else(|| "missing capability_token in session".to_string())?;

    // Send the agent.device_identity request
    let request = serde_json::json!({
        "capability_token": capability_token,
        "method": "agent.device_identity",
        "arguments": {},
    });
    let mut request_bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    request_bytes.push(b'\n');
    stream
        .write_all(&request_bytes)
        .map_err(|e| format!("write request: {e}"))?;

    // Read the response
    let mut response_line = String::new();
    reader
        .read_line(&mut response_line)
        .map_err(|e| format!("read response: {e}"))?;

    let response: serde_json::Value =
        serde_json::from_str(&response_line).map_err(|e| format!("parse response: {e}"))?;

    if let Some(result) = response["result"].as_str() {
        Ok(result.to_string())
    } else if let Some(err) = response["error"].as_str() {
        Err(format!("IPC error: {err}"))
    } else {
        Ok(response_line.trim().to_string())
    }
}

#[derive(serde::Deserialize, Clone)]
struct PanelSpec {
    label: String,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    visible: bool,
    ingress_session: Option<String>,
    init_script: Option<String>,
}

/// GTK widget name of the GtkFixed that hosts the controller and all panel
/// webviews with exact geometry.
const CANVAS_FIXED_NAME: &str = "canvas-webview-fixed";

/// Bumped every time `close_panel_webviews` runs. In-flight panel-creation
/// batches capture the value at start and abort if it changes, so an older
/// page load can never re-create panels over a newer one (the frontend can
/// have several load_page pushes racing at startup).
static PANEL_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Place a child webview at an exact geometry inside its Tauri window.
///
/// Why this exists: Tauri's `Window::add_child` on Linux/GTK does NOT honour
/// the requested position/size. tauri-runtime-wry routes `WebviewKind::
/// WindowChild` to `build_gtk(window.default_vbox())`, and wry's
/// `add_to_container` packs webviews into that vertical GtkBox with
/// `pack_start(webview, true, true, 0)` — the bounds are discarded. Every
/// webview in the window (the controller included) then shares the window
/// height as stacked box rows, which is the "panels render in the wrong
/// place" bug. wry only applies bounds when the container is a GtkFixed
/// (`set_size_request(w, h)` + `Fixed::put(w, x, y)`), so we re-parent the
/// freshly created panel webview — plus any webviews still packed in the
/// vbox — into a GtkFixed we own, at the exact requested geometry. The
/// webview keeps its Tauri label, IPC, initialization scripts and TLS
/// handling; only its GTK parent changes. Must run on the main thread.
fn place_webview_in_fixed(
    wk: &webkit2gtk::WebView,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    label: &str,
) {
    use gtk::prelude::*;

    // Remember what the caller wants this webview to look like before we
    // start moving it between containers.
    let desired_visible = wk.is_visible();

    // The webview Tauri just built is a direct child of the window's default vbox.
    let vbox = match wk.parent() {
        Some(parent) => match parent.dynamic_cast::<gtk::Box>() {
            Ok(box_) => box_,
            Err(_) => {
                klog(&format!(
                    "[fixed-container] '{}' parent is not a GtkBox; leaving layout untouched",
                    label
                ));
                return;
            }
        },
        None => {
            klog(&format!(
                "[fixed-container] '{}' has no parent widget",
                label
            ));
            return;
        }
    };

    // Find (or create) the fixed container among the vbox children.
    let mut existing_fixed: Option<gtk::Fixed> = None;
    for child in vbox.children() {
        if child.widget_name() == CANVAS_FIXED_NAME {
            if let Ok(f) = child.dynamic_cast::<gtk::Fixed>() {
                existing_fixed = Some(f);
            }
        }
    }

    let fixed = match existing_fixed {
        Some(f) => f,
        None => {
            // First panel for this window: move every webview currently packed
            // in the box (the controller included) into a new GtkFixed,
            // preserving each widget's current allocation and visibility.
            let f = gtk::Fixed::new();
            f.set_widget_name(CANVAS_FIXED_NAME);
            for child in vbox.children() {
                if let Ok(existing) = child.dynamic_cast::<webkit2gtk::WebView>() {
                    let alloc = existing.allocation();
                    let visible = existing.is_visible();
                    // If the widget has not been allocated yet, fall back to
                    // the toplevel size so the controller stays fullscreen.
                    let (ax, ay, aw, ah) = if alloc.width() < 2 || alloc.height() < 2 {
                        match existing.toplevel() {
                            Some(toplevel) => {
                                let ta = toplevel.allocation();
                                (ta.x(), ta.y(), ta.width(), ta.height())
                            }
                            None => (alloc.x(), alloc.y(), alloc.width(), alloc.height()),
                        }
                    } else {
                        (alloc.x(), alloc.y(), alloc.width(), alloc.height())
                    };
                    vbox.remove(&existing);
                    f.put(&existing, ax, ay);
                    existing.set_size_request(aw, ah);
                    if visible {
                        existing.show();
                    } else {
                        existing.hide();
                    }
                    klog(&format!(
                        "[fixed-container] moved existing webview to {},{} {}x{}",
                        ax, ay, aw, ah
                    ));
                }
            }
            vbox.pack_start(&f, true, true, 0);
            f.show();
            klog("[fixed-container] created GtkFixed in window vbox");
            f
        }
    };

    // Detach the panel from wherever add_child packed it and place it exactly.
    if let Some(old_parent) = wk.parent() {
        if let Ok(container) = old_parent.dynamic_cast::<gtk::Container>() {
            container.remove(wk);
        }
    }
    fixed.put(wk, x, y);
    wk.set_size_request(width as i32, height as i32);
    if desired_visible {
        wk.show();
    } else {
        wk.hide();
    }
    klog(&format!(
        "[fixed-container] '{}' placed at {},{} {}x{}",
        label, x, y, width, height
    ));
}

// Build a single child webview attached to the provided parent window and run it
// on the main thread. This is the only place that performs `add_child`, so both
// the one-shot and the batched commands share identical behaviour.
fn create_one_panel(
    app: &AppHandle,
    window: tauri::WebviewWindow,
    spec: &PanelSpec,
) -> Result<(), String> {
    let parsed_url = spec.url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let app_handle = app.clone();
    let label = spec.label.clone();
    let visible = spec.visible;
    let ingress_session = spec.ingress_session.clone();
    let init_script = spec.init_script.clone();
    let x = spec.x;
    let y = spec.y;
    let width = spec.width;
    let height = spec.height;

    app.run_on_main_thread(move || {
        klog(&format!(
            "[create_one_panel] on main thread, building '{}'",
            label
        ));
    let mut builder = tauri::WebviewBuilder::new(
            &label,
            tauri::WebviewUrl::External(parsed_url),
        )
        .incognito(false);

        let load_app = app_handle.clone();
        let load_label = label.clone();
        builder = builder.on_page_load(move |_webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = load_app.emit(
                    "panel-load-result",
                    PanelLoadEvent {
                        label: load_label.clone(),
                        ok: true,
                        error: None,
                    },
                );
            }
        });

        if let Some(session) = ingress_session {
            let safe_session: String = session
                .chars()
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

        let navigation_app = app_handle.clone();
        let navigation_label = label.clone();
        builder = builder.on_navigation(move |target| {
            if target.scheme() == "canvas-player" && target.host_str() == Some("close") {
                klog(&format!("[{}] Canvas player requested close", navigation_label));
                if let Some(webview) = navigation_app.get_webview(&navigation_label) {
                    let _ = webview.close();
                }
                return false;
            }
            true
        });

        klog(&format!(
            "[create_one_panel] adding child '{}' at {},{} {}x{}",
            label, x, y, width, height
        ));
        match window.as_ref().window().add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        ) {
            Err(e) => {
                klog(&format!(
                    "[create_one_panel] BUILD FAILED '{}': {}",
                    label, e
                ));
                eprintln!("[create_one_panel] failed to build '{}': {}", label, e);
            }
            Ok(webview) => {
                klog(&format!("[create_one_panel] build OK for '{}'", label));
                if !visible {
                    let _ = webview.hide();
                }
                #[cfg(target_os = "linux")]
                let label2 = label.clone();
                #[cfg(target_os = "linux")]
                let _ = webview.with_webview(move |wv| {
                    use webkit2gtk::{ProcessModel, SettingsExt, WebContextExt, WebViewExt};
                    let wk = wv.inner();

                    // Force each webview into its own web process — prevents the
                    // null-ptr SIGSEGV in libwebkit2gtk when multiple same-origin
                    // pages (e.g. two HA URLs) share a single WebKit secondary process
                    // and race-crash during heavy JavaScript initialisation.
                    if let Some(ctx) = wk.web_context() {
                        ctx.set_process_model(ProcessModel::MultipleSecondaryProcesses);
                        klog(&format!(
                            "[{}] process model set to MultipleSecondaryProcesses",
                            label2
                        ));
                    }

                    // Trust must be provisioned in the system store, never learned from a
                    // failed connection. Do not log URLs or certificate contents here.
                    let tls_app = app_handle.clone();
                    let tls_label = label2.clone();
                    wk.connect_load_failed_with_tls_errors(
                        move |_view, _failing_uri, _certificate, errors| {
                            klog(&format!(
                                "[TLS] panel load rejected: certificate validation failed ({:?}); check system CA trust, certificate hostname/validity, and system clock",
                                errors
                            ));
                            let _ = tls_app.emit(
                                "panel-load-result",
                                PanelLoadEvent {
                                    label: tls_label.clone(),
                                    ok: false,
                                    error: Some("certificate validation failed".to_string()),
                                },
                            );
                            // Keep WebKit's default failure handling; never retry or allow it.
                            false
                        },
                    );

                    if let Some(settings) = wk.settings() {
                        settings.set_hardware_acceleration_policy(
                            webkit2gtk::HardwareAccelerationPolicy::Never,
                        );
                        settings.set_enable_page_cache(false);
                        klog(&format!("[{}] webkit settings applied", label2));
                    }

                    // Re-parent the webview into a GtkFixed so the requested
                    // geometry actually applies on Linux/GTK (Tauri's add_child
                    // packs it into the window's GtkBox and discards bounds).
                    place_webview_in_fixed(&wk, x, y, width, height, &label2);
                });
                klog(&format!("[create_one_panel] done '{}'", label));
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_panel_webview(
    app: AppHandle,
    window: tauri::WebviewWindow,
    label: String,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    _title: String,
    visible: bool,
    ingress_session: Option<String>,
    init_script: Option<String>,
) -> Result<(), String> {
    let spec = PanelSpec {
        label,
        url,
        x,
        y,
        width,
        height,
        visible,
        ingress_session,
        init_script,
    };
    create_one_panel(&app, window, &spec)
}

// Batched creation. A single frontend call hands every panel to Rust; a spawned
// thread builds them on the main thread with a stabilising gap between each. This
// keeps panel creation alive even if the controller webview is occluded (and its
// JS suspended) by a large child panel — the spawned thread does not depend on the
// controller's event loop.
#[tauri::command]
fn create_panel_webviews(
    app: AppHandle,
    window: tauri::WebviewWindow,
    panels: Vec<PanelSpec>,
) -> Result<(), String> {
    // Capture the generation at call time; if close_panel_webviews runs while
    // this batch is still creating panels (a newer page load arrived), the
    // batch aborts instead of stacking stale panels over the newer page.
    let generation = PANEL_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    let app2 = app.clone();
    let window2 = window.clone();
    std::thread::spawn(move || {
        for (i, spec) in panels.into_iter().enumerate() {
            if PANEL_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
                klog(&format!(
                    "[create_panel_webviews] batch superseded by a newer page load before creating '{}'; aborting",
                    spec.label
                ));
                return;
            }
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(2200));
            }
            if let Err(e) = create_one_panel(&app2, window2.clone(), &spec) {
                klog(&format!(
                    "[create_panel_webviews] error creating '{}': {}",
                    spec.label, e
                ));
            }
        }
        klog("[create_panel_webviews] batch complete");
    });
    Ok(())
}

pub fn run() {
    // Truncate/create the log file fresh on each run
    let _ = std::fs::write(LOG_PATH, "");
    klog("=== Canvas UI kiosk starting ===");

    // Set WebKit2GTK environment variables before anything initializes.
    #[cfg(target_os = "linux")]
    {
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
        }
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        unsafe {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
        // Disable DMA-BUF renderer — can produce NULL GdkGLContext on software GL,
        // triggering a null-ptr crash in WebKit's rendering pipeline (offset +0x48).
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
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
                libc::SIGBUS => "SIGNAL: SIGBUS (bus error)",
                _ => "SIGNAL: unknown fatal signal",
            };
            // Write directly — async-signal-safe path
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(LOG_PATH)
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
        libc::signal(libc::SIGBUS, fatal_handler as libc::sighandler_t);
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
            display_geometry,
            get_device_identity,
            edge_ipc,
            core_control_config,
            navigate_webview,
            close_webview,
            set_webview_visibility,
            close_panel_webviews,
            control_youtube_webview,
            create_panel_webview,
            create_panel_webviews,
            set_kiosk_visible,
        ])
        .setup(|app| {
            // ── Spawn embedded server sidecar ──────────────────────────────
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/canvas-ui"));
            std::fs::create_dir_all(&data_dir).ok();
            let data_dir_str = data_dir.to_string_lossy().to_string();
            klog(&format!("setup: data dir = {}", data_dir_str));

            // Pass resource dir so sidecar can locate native .node bindings and static assets
            let binaries_resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
                .join("binaries");
            let binaries_dir_str = binaries_resource_dir.to_string_lossy().to_string();
            let static_dir_str = binaries_resource_dir
                .join("public")
                .to_string_lossy()
                .to_string();
            klog(&format!(
                "setup: resource binaries dir = {}",
                binaries_dir_str
            ));

            match app
                .shell()
                .sidecar("canvas-display-server")
                .expect("canvas-display-server sidecar not found")
                .env("CANVAS_DATA_DIR", &data_dir_str)
                .env("NATIVE_BINDING_DIR", &binaries_dir_str)
                .env("STATIC_DIR", &static_dir_str)
                .env("PORT", "3100")
                .env("HOST", "127.0.0.1")
                .spawn()
            {
                Ok((mut rx, child)) => {
                    klog("setup: canvas-display-server sidecar started");
                    app.manage(ServerChild(Mutex::new(Some(child))));

                    // Needed so we can react to the sidecar's exit below.
                    let app_handle = app.handle().clone();

                    // Forward sidecar stdout/stderr to the kiosk log file
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    let msg = String::from_utf8_lossy(&line);
                                    klog(&format!("[server] {}", msg.trim_end()));
                                }
                                CommandEvent::Stderr(line) => {
                                    let msg = String::from_utf8_lossy(&line);
                                    klog(&format!("[server:err] {}", msg.trim_end()));
                                }
                                CommandEvent::Terminated(status) => {
                                    // The sidecar implements `/api/app/restart` and
                                    // `/api/app/stop` by exiting itself. The parent kiosk
                                    // must translate that into a whole-app exit, otherwise
                                    // the edge app is left running without its server.
                                    // systemd runs us with `Restart=on-failure`, so it only
                                    // relaunches us when the kiosk exits non-zero.
                                    match status {
                                        // stop — sidecar exited cleanly: exit the kiosk 0.
                                        TerminatedPayload { code: Some(0), .. } => {
                                            klog("[server] sidecar exited cleanly (app stop) — stopping kiosk");
                                            app_handle.exit(0);
                                            // Hard fallback in case app.exit doesn't terminate.
                                            std::process::exit(0);
                                        }
                                        // restart (or a crash) — exit non-zero so systemd restarts us.
                                        TerminatedPayload { code: Some(code), .. } => {
                                            klog(&format!(
                                                "[server] sidecar exited with code {} (app restart) — restarting kiosk",
                                                code
                                            ));
                                            std::process::exit(1);
                                        }
                                        // Terminated by signal — e.g. our own shutdown kill in
                                        // the RunEvent::Exit handler. Don't re-exit here.
                                        _ => {
                                            klog(&format!("[server] sidecar terminated by signal: {:?}", status));
                                        }
                                    }
                                    break;
                                }
                                _ => {}
                            }
                        }
                    });
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
