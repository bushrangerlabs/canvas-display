//! Recovery screen HTML for the renderer crash-loop safe recovery screen.
//!
//! This module provides a minimal, self-contained HTML page (no external assets) that the Edge
//! Agent can serve when the renderer is in a crash-loop or the normal scene fails to load. The
//! page shows a branded error message, crash count, a spinning indicator, and a "Retry" button
//! the user can tap to attempt a manual restart. Auto-retry is attempted after 60 seconds of no
//! crashes.

/// The recovery screen HTML template. Uses `{crash_count}` and `{seconds_since_last_crash}` as
/// placeholder tokens that the caller replaces with real values.
pub const RECOVERY_SCREEN_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Canvas Display — Recovery Mode</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #111;
    color: #eee;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
    text-align: center;
  }
  .logo { font-size: 2rem; font-weight: 700; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .logo span { color: #7c3aed; }
  .subtitle { font-size: 1.1rem; color: #999; margin-bottom: 2rem; }
  .spinner {
    width: 48px; height: 48px; border: 4px solid #333;
    border-top-color: #7c3aed; border-radius: 50%;
    animation: spin 0.8s linear infinite; margin-bottom: 2rem;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { font-size: 0.95rem; color: #aaa; margin-bottom: 0.25rem; }
  .status strong { color: #f59e0b; }
  .countdown { font-size: 0.85rem; color: #666; margin-bottom: 2rem; }
  .btn {
    display: inline-block; padding: 0.75rem 2rem; border: none; border-radius: 8px;
    font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s;
    background: #7c3aed; color: #fff; text-decoration: none;
  }
  .btn:hover { background: #6d28d9; }
  .btn:active { background: #5b21b6; }
  .footer { margin-top: 3rem; font-size: 0.75rem; color: #555; }
</style>
</head>
<body>
  <div class="logo">Canvas <span>Display</span></div>
  <div class="subtitle">Recovery Mode</div>
  <div class="spinner"></div>
  <div class="status">Crashes: <strong>{crash_count}</strong></div>
  <div class="status">Last crash: <strong>{seconds_since_last_crash}s</strong> ago</div>
  <div class="countdown">Auto-retry in <span id="countdown">60</span>s</div>
  <button class="btn" onclick="retry()">Retry Now</button>
  <div class="footer">Canvas Edge Agent v{agent_version}</div>
  <script>
    let countdown = 60;
    function tick() {
      document.getElementById("countdown").textContent = countdown;
      if (countdown > 0) { countdown--; setTimeout(tick, 1000); }
      else { retry(); }
    }
    tick();
    function retry() {
      document.querySelector(".btn").disabled = true;
      document.querySelector(".btn").textContent = "Restarting...";
      fetch("/_retry", { method: "POST" }).catch(function(){});
    }
  </script>
</body>
</html>"#;

/// Builds the recovery screen HTML with the given crash count, seconds since last crash, and agent
/// version substituted into the template.
pub fn render_recovery_screen(
    crash_count: u32,
    seconds_since_last_crash: u64,
    agent_version: &str,
) -> String {
    RECOVERY_SCREEN_HTML
        .replace("{crash_count}", &crash_count.to_string())
        .replace(
            "{seconds_since_last_crash}",
            &seconds_since_last_crash.to_string(),
        )
        .replace("{agent_version}", agent_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_screen_contains_expected_elements() {
        let html = render_recovery_screen(3, 15, "0.1.0");
        assert!(html.contains("Canvas"));
        assert!(html.contains("Display"));
        assert!(html.contains("Recovery Mode"));
        assert!(html.contains("Crashes:"));
        assert!(html.contains("3"));
        assert!(html.contains("15"));
        assert!(html.contains("0.1.0"));
        assert!(html.contains("Retry Now"));
        assert!(html.contains("Auto-retry"));
        assert!(html.contains("retry()"));
        assert!(html.contains("fetch"));
    }

    #[test]
    fn recovery_screen_handles_zero_crashes() {
        let html = render_recovery_screen(0, 0, "0.1.0");
        assert!(html.contains("0"));
    }

    #[test]
    fn recovery_screen_embeds_agent_version() {
        let html = render_recovery_screen(5, 30, "1.2.3-beta");
        assert!(html.contains("1.2.3-beta"));
    }
}
