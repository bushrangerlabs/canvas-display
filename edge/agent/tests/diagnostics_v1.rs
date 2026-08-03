//! Executable evidence for the local diagnostics summary (Phase 1 checklist item "local
//! diagnostics" -- see `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md`) in
//! `canvas_edge_agent::diagnostics`.
//!
//! These tests build `DiagnosticsSummary` from plain canned inputs -- no real `Storage`/SQLite
//! file is opened here, proving the type is genuinely dependency-injected as designed (see module
//! docs in `edge/agent/src/diagnostics/mod.rs`).

use std::time::{Duration, Instant};

use canvas_edge_agent::diagnostics::DiagnosticsSummary;
use canvas_edge_agent::storage::Epochs;

const TEST_VERSION: &str = "9.9.9-test";

fn fake_epochs() -> Epochs {
    Epochs {
        core_stream_epoch: 3,
        edge_stream_epoch: 2,
        authority_epoch: 5,
        restore_generation: 1,
        last_core_sequence: Some(42),
        last_edge_acked_sequence: Some(41),
        next_edge_sequence: 43,
    }
}

#[test]
fn new_carries_the_caller_supplied_fields_through_unchanged() {
    let start = Instant::now();
    let epochs = fake_epochs();

    let summary = DiagnosticsSummary::new(start, 7, epochs, TEST_VERSION);

    assert_eq!(summary.recovered_unknown_outcome_count, 7);
    assert_eq!(summary.epochs, epochs);
    assert_eq!(summary.version, TEST_VERSION);
    assert_eq!(summary.arch, std::env::consts::ARCH);
    assert!(summary.generated_at_unix_seconds > 0);
}

#[test]
fn zero_recovered_commands_is_a_valid_clean_shutdown_case() {
    let summary = DiagnosticsSummary::new(Instant::now(), 0, fake_epochs(), TEST_VERSION);
    assert_eq!(summary.recovered_unknown_outcome_count, 0);
}

#[test]
fn uptime_reflects_a_start_instant_in_the_past_with_slack_for_timing_noise() {
    // Construct with a start instant slightly in the past and confirm the computed uptime is at
    // least that much. This must not be flaky: only assert a lower bound (never an exact/upper
    // bound), since the actual wall-clock time elapsed between capturing `start` and calling
    // `new` is always >= the nominal offset, plus whatever scheduling noise the test happens to
    // hit.
    let backdated_start = Instant::now() - Duration::from_secs(5);

    let summary = DiagnosticsSummary::new(backdated_start, 0, fake_epochs(), TEST_VERSION);

    assert!(
        summary.uptime >= Duration::from_secs(5),
        "expected uptime >= 5s, got {:?}",
        summary.uptime
    );
    // Generous upper bound just to catch a genuinely broken calculation (e.g. accidentally using
    // `Instant::now() - Instant::now()` style logic that underflows/saturates to zero, or wildly
    // over-counts); not intended to be a tight timing assertion.
    assert!(
        summary.uptime < Duration::from_secs(60),
        "expected uptime well under 60s for a 5s-backdated start, got {:?}",
        summary.uptime
    );
}

#[test]
fn to_log_lines_contains_every_key_fact_as_a_substring() {
    let summary = DiagnosticsSummary::new(Instant::now(), 3, fake_epochs(), TEST_VERSION);
    let lines = summary.to_log_lines();
    let joined = lines.join("\n");

    assert!(joined.contains(TEST_VERSION), "missing version: {joined}");
    assert!(
        joined.contains(std::env::consts::ARCH),
        "missing arch: {joined}"
    );
    assert!(joined.contains('3'), "missing recovered count: {joined}");
    assert!(
        joined.contains("core_stream=3"),
        "missing core_stream epoch: {joined}"
    );
    assert!(
        joined.contains("edge_stream=2"),
        "missing edge_stream epoch: {joined}"
    );
    assert!(
        joined.contains("authority=5"),
        "missing authority epoch: {joined}"
    );
    assert!(
        joined.contains("restore_generation=1"),
        "missing restore_generation epoch: {joined}"
    );
}

#[test]
fn display_impl_matches_to_log_lines_joined_by_newlines() {
    let summary = DiagnosticsSummary::new(Instant::now(), 1, fake_epochs(), TEST_VERSION);
    assert_eq!(summary.to_string(), summary.to_log_lines().join("\n"));
}
