//! Integration tests proving real, injectable OS/hardware capability detection and pure per-domain
//! application-state conversion (Phase 1 checklist item "Report renderer/hardware capabilities and
//! per-domain application state") for `canvas_edge_agent::capabilities`. See module docs in
//! `edge/agent/src/capabilities/mod.rs`, `detect.rs`, and `domain.rs` for what is genuinely
//! detected vs. assumed, and for exactly how a later task would wire this into
//! `session::state::EdgeSession`.
//!
//! Which tests exercise the *real* filesystem-probing logic vs. the fake/injectable probe:
//!
//! - `real_probe_*` tests construct `RealSystemCapabilityProbe::with_paths(...)` pointing at a
//!   throwaway `tempfile::tempdir()` (never the real `/sys/class/backlight` or real `PATH`), so
//!   they prove the real directory-walking/executable-bit logic works without depending on -- or
//!   mutating -- the actual test machine's hardware state.
//! - Every other capability test uses `FakeSystemCapabilityProbe` to simulate "backlight
//!   present/absent" and "mpv present/absent" without touching the filesystem at all.

use std::fs;
use std::os::unix::fs::PermissionsExt;

use canvas_edge_agent::capabilities::{
    to_domain_application, CapabilityDetector, Domain, DomainOutcome, FakeSystemCapabilityProbe,
    RealSystemCapabilityProbe, SystemCapabilityProbe, HARDWARE_BRIGHTNESS, HARDWARE_DPMS,
    MEDIA_MPV, MEDIA_YOUTUBE_IFRAME, RENDERER_CANVAS_SCENE_V1, VOICE_OPUS_WSS,
    VOICE_WAKEWORD_LOCAL,
};
use canvas_edge_agent::protocol::{AgentInfoArchitecture, DomainApplicationStatus};
use tempfile::tempdir;

fn capability_strings<T: std::ops::Deref<Target = String>>(items: &[T]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn fake_probe_backlight_present_includes_brightness_hardware_capability() {
    let probe = FakeSystemCapabilityProbe::new(true, false);
    let detector = CapabilityDetector::new(probe, AgentInfoArchitecture::Amd64);

    let capabilities = detector.detect();

    let hardware = capability_strings(&capabilities.hardware);
    assert!(hardware.contains(&HARDWARE_BRIGHTNESS.to_string()));
}

#[test]
fn fake_probe_backlight_absent_excludes_brightness_hardware_capability() {
    let probe = FakeSystemCapabilityProbe::new(false, false);
    let detector = CapabilityDetector::new(probe, AgentInfoArchitecture::Amd64);

    let capabilities = detector.detect();

    let hardware = capability_strings(&capabilities.hardware);
    assert!(!hardware.contains(&HARDWARE_BRIGHTNESS.to_string()));
}

#[test]
fn dpms_renderer_and_voice_capabilities_are_always_present_regardless_of_probe() {
    for (backlight, mpv) in [(false, false), (true, false), (false, true), (true, true)] {
        let probe = FakeSystemCapabilityProbe::new(backlight, mpv);
        let detector = CapabilityDetector::new(probe, AgentInfoArchitecture::Arm64);

        let capabilities = detector.detect();

        let hardware = capability_strings(&capabilities.hardware);
        let renderer = capability_strings(&capabilities.renderer);
        let media = capability_strings(&capabilities.media);
        let voice = capability_strings(&capabilities.voice);

        assert!(hardware.contains(&HARDWARE_DPMS.to_string()));
        assert!(renderer.contains(&RENDERER_CANVAS_SCENE_V1.to_string()));
        assert!(media.contains(&MEDIA_YOUTUBE_IFRAME.to_string()));
        assert!(voice.contains(&VOICE_WAKEWORD_LOCAL.to_string()));
        assert!(voice.contains(&VOICE_OPUS_WSS.to_string()));
    }
}

#[test]
fn fake_probe_mpv_present_includes_mpv_media_capability() {
    let probe = FakeSystemCapabilityProbe::new(false, true);
    let detector = CapabilityDetector::new(probe, AgentInfoArchitecture::Amd64);

    let capabilities = detector.detect();

    let media = capability_strings(&capabilities.media);
    assert!(media.contains(&MEDIA_MPV.to_string()));
}

#[test]
fn fake_probe_mpv_absent_excludes_mpv_media_capability() {
    let probe = FakeSystemCapabilityProbe::new(false, false);
    let detector = CapabilityDetector::new(probe, AgentInfoArchitecture::Amd64);

    let capabilities = detector.detect();

    let media = capability_strings(&capabilities.media);
    assert!(!media.contains(&MEDIA_MPV.to_string()));
}

#[test]
fn real_probe_against_nonexistent_paths_is_graceful_and_reports_nothing() {
    let base = tempdir().expect("create tempdir");
    // Deliberately do not create this subdirectory: this is the "no backlight driver present"
    // case that is completely normal on a desktop/VM/CI machine, and must never panic.
    let missing_backlight_dir = base.path().join("does-not-exist");

    let probe = RealSystemCapabilityProbe::with_paths(missing_backlight_dir, "");

    assert!(!probe.has_backlight());
    assert!(!probe.has_mpv_on_path());
}

#[test]
fn real_probe_detects_a_backlight_directory_with_a_brightness_file() {
    let base = tempdir().expect("create tempdir");
    let backlight_dir = base.path().join("intel_backlight");
    fs::create_dir_all(&backlight_dir).expect("create fake backlight device dir");
    fs::write(backlight_dir.join("brightness"), b"255").expect("write fake brightness file");

    let probe = RealSystemCapabilityProbe::with_paths(base.path(), "");

    assert!(probe.has_backlight());
}

#[test]
fn real_probe_ignores_a_backlight_device_directory_missing_a_brightness_file() {
    let base = tempdir().expect("create tempdir");
    let backlight_dir = base.path().join("some_other_device");
    fs::create_dir_all(&backlight_dir).expect("create dir without a brightness file");

    let probe = RealSystemCapabilityProbe::with_paths(base.path(), "");

    assert!(!probe.has_backlight());
}

#[test]
fn real_probe_detects_an_executable_mpv_on_a_synthetic_path() {
    let base = tempdir().expect("create tempdir");
    let bin_dir = base.path().join("bin");
    fs::create_dir_all(&bin_dir).expect("create fake bin dir");
    let mpv_path = bin_dir.join("mpv");
    fs::write(&mpv_path, b"#!/bin/sh\necho fake mpv\n").expect("write fake mpv script");
    let mut perms = fs::metadata(&mpv_path)
        .expect("stat fake mpv script")
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&mpv_path, perms).expect("mark fake mpv script executable");

    let path_env = bin_dir.to_string_lossy().to_string();
    let probe =
        RealSystemCapabilityProbe::with_paths(base.path().join("unused-backlight"), path_env);

    assert!(probe.has_mpv_on_path());
}

#[test]
fn real_probe_does_not_treat_a_non_executable_mpv_file_as_present() {
    let base = tempdir().expect("create tempdir");
    let bin_dir = base.path().join("bin");
    fs::create_dir_all(&bin_dir).expect("create fake bin dir");
    let mpv_path = bin_dir.join("mpv");
    fs::write(&mpv_path, b"not actually executable").expect("write non-executable file");
    let mut perms = fs::metadata(&mpv_path).expect("stat file").permissions();
    perms.set_mode(0o644);
    fs::set_permissions(&mpv_path, perms).expect("mark file non-executable");

    let path_env = bin_dir.to_string_lossy().to_string();
    let probe =
        RealSystemCapabilityProbe::with_paths(base.path().join("unused-backlight"), path_env);

    assert!(!probe.has_mpv_on_path());
}

#[test]
fn domain_outcome_pending_converts_to_pending_status_with_no_reason() {
    let application = to_domain_application(7, &DomainOutcome::Pending);

    assert_eq!(application.desired_revision, 7);
    assert_eq!(application.status, DomainApplicationStatus::Pending);
    assert!(application.reason.is_none());
}

#[test]
fn domain_outcome_applied_converts_to_applied_status_with_no_reason() {
    let application = to_domain_application(12, &DomainOutcome::Applied);

    assert_eq!(application.desired_revision, 12);
    assert_eq!(application.status, DomainApplicationStatus::Applied);
    assert!(application.reason.is_none());
}

#[test]
fn domain_outcome_diverged_converts_to_diverged_status_with_no_reason() {
    let application = to_domain_application(3, &DomainOutcome::Diverged);

    assert_eq!(application.desired_revision, 3);
    assert_eq!(application.status, DomainApplicationStatus::Diverged);
    assert!(application.reason.is_none());
}

#[test]
fn domain_outcome_failed_converts_to_failed_status_and_carries_the_reason() {
    let outcome = DomainOutcome::Failed {
        reason: "asset digest mismatch".to_string(),
    };

    let application = to_domain_application(5, &outcome);

    assert_eq!(application.desired_revision, 5);
    assert_eq!(application.status, DomainApplicationStatus::Failed);
    assert_eq!(
        application
            .reason
            .expect("reason should be present")
            .to_string(),
        "asset digest mismatch"
    );
}

#[test]
fn domain_outcome_unsupported_converts_to_unsupported_status_and_carries_the_reason() {
    let outcome = DomainOutcome::Unsupported {
        reason: "no voice pipeline in this build".to_string(),
    };

    let application = to_domain_application(9, &outcome);

    assert_eq!(application.desired_revision, 9);
    assert_eq!(application.status, DomainApplicationStatus::Unsupported);
    assert_eq!(
        application
            .reason
            .expect("reason should be present")
            .to_string(),
        "no voice pipeline in this build"
    );
}

#[test]
fn an_overly_long_failure_reason_is_truncated_rather_than_panicking() {
    let long_reason = "x".repeat(500);
    let outcome = DomainOutcome::Failed {
        reason: long_reason,
    };

    let application = to_domain_application(1, &outcome);

    let reason = application.reason.expect("reason should be present");
    assert!(reason.chars().count() <= 128);
}

#[test]
fn an_empty_failure_reason_falls_back_to_a_placeholder_rather_than_panicking() {
    let outcome = DomainOutcome::Failed {
        reason: String::new(),
    };

    let application = to_domain_application(1, &outcome);

    let reason = application.reason.expect("reason should be present");
    assert!(!reason.to_string().is_empty());
}

#[test]
fn domain_as_str_matches_the_wire_keys_already_used_in_state_reported() {
    assert_eq!(Domain::Scene.as_str(), "scene");
    assert_eq!(Domain::Display.as_str(), "display");
    assert_eq!(Domain::Audio.as_str(), "audio");
    assert_eq!(Domain::Voice.as_str(), "voice");
    assert_eq!(Domain::Update.as_str(), "update");
}

#[test]
fn domain_application_serializes_through_real_serde_without_error() {
    let outcome = DomainOutcome::Failed {
        reason: "renderer IPC call timed out".to_string(),
    };
    let application = to_domain_application(42, &outcome);

    let json = serde_json::to_string(&application).expect("DomainApplication should serialize");

    assert!(json.contains("\"desired_revision\":42"));
    assert!(json.contains("\"status\":\"failed\""));
    assert!(json.contains("renderer IPC call timed out"));
}

#[test]
fn edge_capabilities_serializes_through_real_serde_without_error() {
    let probe = FakeSystemCapabilityProbe::new(true, true);
    let detector = CapabilityDetector::new(probe, AgentInfoArchitecture::Amd64);
    let capabilities = detector.detect();

    let json = serde_json::to_string(&capabilities).expect("EdgeCapabilities should serialize");

    assert!(json.contains("brightness"));
    assert!(json.contains("dpms"));
    assert!(json.contains("mpv"));
    assert!(json.contains("canvas-scene-v1"));
}
