//! Canvas Edge Updater daemon entry point.
//!
//! This is intentionally a minimal, network-free long-lived process for this development slice,
//! mirroring canvas-edge-agentd's own first Phase 1 cut: it opens the durable SQLite-backed
//! InstallJournal at a configurable data directory, runs the crash-recovery pass
//! (recover_on_startup) once at startup exactly as a real restart-after-crash would require,
//! acts on (or clearly logs the limitation of acting on) the recommendation, logs a summary, and
//! then idles until it receives a termination signal.
//!
//! What this daemon does today:
//!
//! - Opens TWO independent durable journals, both backed by separate SQLite files under the data
//!   directory, each tracking a different two-slot subject:
//!   * the **Agent package** journal (`updater.sqlite3`), and
//!   * the **updater's own** journal (`updater-self.sqlite3`) for self-upgrade of the
//!     `canvas-edge-updaterd` binary.
//!
//!   These two subjects are fully isolated: each has its own `journal_meta` singleton row, its own
//!   slot artifacts under a distinct `installed_root`, and its own `active_binary_path`. They
//!   share the generic journal schema and state machine, but never the same SQLite file.
//! - Runs recover_on_startup on BOTH journals at startup.
//! - For RecoveryAction::Nothing: logs and continues, exactly as before.
//! - For RecoveryAction::ResumeInstall: logs clearly that resuming is recommended, but does NOT
//!   automatically resume -- see handle_recovery_action below for why this is a genuine, not
//!   merely deferred, gap.
//! - For RecoveryAction::RollForward / RecoveryAction::RollBack: logs clearly what the journal
//!   recommends; for RollBack it now calls canvas_edge_updater::rollout::perform_rollback, which
//!   durably records the rollback AND performs the actual on-disk file-swap back to the target
//!   slot's previously-installed binary (atomically, via canvas_edge_updater::rollout::
//!   swap_active_binary). The replaced binary is preserved as `<active_binary>.previous`.
//!   This applies to BOTH the Agent package journal (swapping `canvas-edge-agentd`) and the
//!   updater's own journal (swapping `canvas-edge-updaterd`).
//! - If CANVAS_EDGE_UPDATER_DEMO_ROLLOUT=1 is set, runs one self-contained, in-process
//!   demonstration rollout (canvas_edge_updater::rollout::run_demo_rollout) against the Agent
//!   package journal after the recovery pass, to prove the real perform_rollout wiring compiles
//!   and works end-to-end from this binary. This is explicitly a demo/manual-testing aid, not a
//!   real update mechanism -- see that function's doc comments for exactly what it does and does
//!   not prove.
//! - If CANVAS_EDGE_UPDATER_DEMO_SELF_UPGRADE=1 is set, runs one self-contained, in-process
//!   demonstration self-upgrade (canvas_edge_updater::self_upgrade::run_demo_self_upgrade)
//!   against the updater's OWN journal, proving the self-upgrade path (separate SQLite file,
//!   separate installed_root, separate active_binary_path) compiles and works end-to-end. Also a
//!   demo/manual-testing aid only.
//!
//! What this daemon deliberately does NOT do yet (see
//! docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md Phase 1 checklist and
//! packaging/systemd/canvas-edge-updater.service's README notes for the full list):
//!
//! - It does not request a real release artifact -- there is no Core release-feed connection yet.
//!   The updater library supports HTTP/TLS streaming fetch with hash verification, but this daemon
//!   has no normal-operation trigger that supplies a signed manifest and candidate URL.
//! - It does not automatically resume an in-progress install from RecoveryAction::ResumeInstall
//!   alone: the journal schema does not durably record where an in-progress candidate's artifact
//!   came from (no stored source path/URL), so there is nothing to resume from without an
//!   operator supplying that information again. This is a real, honest gap, not a simplification
//!   this pass papers over.
//! - It does NOT re-exec the newly-swapped binary in-process. A self-upgrade (or a self-rollback)
//!   atomically swaps the binary file at the updater's active_binary_path so that the NEXT process
//!   start -- for example, systemd `Restart=on-failure`, or a normal unit restart -- launches the
//!   newly-swapped `canvas-edge-updaterd`. This is the standard "separate-package self-update"
//!   pattern and is acceptable for Phase 1. An in-process re-exec and a self-health gate that
//!   verifies the swapped binary actually starts before the old process exits are deferred (see
//!   docs/CANVAS_CORE_EDGE_STATUS.md).

use std::env;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use canvas_edge_updater::journal::{InstallJournal, RecoveryAction};
use canvas_edge_updater::manifest::{Architecture, ReleaseTrustRoot, SignedReleaseManifest};
use canvas_edge_updater::rollout::{
    default_health_check, perform_rollback, perform_rollout, run_demo_rollout,
};
use canvas_edge_updater::self_upgrade::{recover_self_upgrade, run_demo_self_upgrade};

const DATA_DIR_ENV: &str = "CANVAS_EDGE_UPDATER_DATA_DIR";
const DEFAULT_DATA_DIR: &str = "/var/lib/canvas-edge-updater";

// Where the live Agent binary lives. On rollback, the previously-known-good slot's artifact bytes
// are atomically swapped into this path. Defaults to the system install location; override for
// local/manual testing.
const ACTIVE_BINARY_ENV: &str = "CANVAS_EDGE_ACTIVE_BINARY_PATH";
const DEFAULT_ACTIVE_BINARY: &str = "/usr/lib/canvas-edge/canvas-edge-agentd";

// Where the live UPDATER binary lives. On self-upgrade rollback, the previously-known-good slot's
// artifact bytes are atomically swapped into this path. Defaults to the system install location;
// override for local/manual testing. The running process cannot replace its own executing binary
// in-process (see module docs): the swap takes effect on the NEXT process start (e.g. systemd
// Restart=on-failure).
const UPDATER_ACTIVE_BINARY_ENV: &str = "CANVAS_EDGE_UPDATER_ACTIVE_BINARY_PATH";
const DEFAULT_UPDATER_ACTIVE_BINARY: &str = "/usr/lib/canvas-edge/canvas-edge-updaterd";

// Hex-encoded (64 lowercase hex characters = 32 bytes) Ed25519 release trust root public key.
// Optional in this development slice -- if unset, the daemon simply logs that no trust root is
// configured yet rather than failing to start, since nothing here verifies a real manifest yet.
const TRUST_ROOT_ENV: &str = "CANVAS_EDGE_RELEASE_TRUST_ROOT_HEX";
const MANIFEST_URL_ENV: &str = "CANVAS_EDGE_RELEASE_MANIFEST_URL";
const PROTOCOL_VERSION_ENV: &str = "CANVAS_EDGE_PROTOCOL_VERSION";
const SCHEMA_VERSION_ENV: &str = "CANVAS_EDGE_SCHEMA_VERSION";

// Set to 1 to run one self-contained, in-process demonstration rollout after startup recovery --
// see canvas_edge_updater::rollout::run_demo_rollout's doc comment for exactly what this proves
// and does not prove. Manual testing/demonstration only, never set in production.
const DEMO_ROLLOUT_ENV: &str = "CANVAS_EDGE_UPDATER_DEMO_ROLLOUT";

// Set to 1 to run one self-contained, in-process demonstration self-upgrade of the updater's OWN
// binary after startup recovery -- see canvas_edge_updater::self_upgrade::run_demo_self_upgrade's
// doc comment. Manual testing/demonstration only, never set in production.
const DEMO_SELF_UPGRADE_ENV: &str = "CANVAS_EDGE_UPDATER_DEMO_SELF_UPGRADE";

fn resolve_data_dir() -> PathBuf {
    match env::var(DATA_DIR_ENV) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(DEFAULT_DATA_DIR),
    }
}

fn resolve_active_binary_path() -> PathBuf {
    match env::var(ACTIVE_BINARY_ENV) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(DEFAULT_ACTIVE_BINARY),
    }
}

fn resolve_updater_active_binary_path() -> PathBuf {
    match env::var(UPDATER_ACTIVE_BINARY_ENV) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(DEFAULT_UPDATER_ACTIVE_BINARY),
    }
}

/// Loads the configured release trust root, if any. Never fatal if absent or malformed -- this
/// development slice has no networked manifest to verify yet, so a missing/bad trust root only
/// means "verification is not available yet," not a startup failure.
fn load_configured_trust_root() -> Option<ReleaseTrustRoot> {
    let hex = env::var(TRUST_ROOT_ENV).ok()?;
    let bytes = hex_decode_32(&hex)?;
    match ReleaseTrustRoot::from_public_key_bytes(&bytes) {
        Ok(trust_root) => Some(trust_root),
        Err(err) => {
            eprintln!(
                "[canvas-edge-updaterd] {TRUST_ROOT_ENV} is set but not a valid Ed25519 public key: {err}"
            );
            None
        }
    }
}

fn hex_decode_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(chunk).ok()?;
        bytes[index] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(bytes)
}

fn configured_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn running_architecture() -> Architecture {
    #[cfg(target_arch = "aarch64")]
    {
        Architecture::Arm64
    }
    #[cfg(target_arch = "x86_64")]
    {
        Architecture::Amd64
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    compile_error!("canvas-edge-updaterd supports only amd64 and arm64");
}

fn fetch_signed_manifest(url: &str) -> Result<SignedReleaseManifest, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| format!("could not construct HTTPS client: {err}"))?
        .get(url)
        .send()
        .map_err(|err| format!("manifest request failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("manifest endpoint returned an error: {err}"))?;
    response
        .json()
        .map_err(|err| format!("signed manifest JSON is invalid: {err}"))
}

fn run_configured_rollout(
    manifest_url: &str,
    trust_root: &ReleaseTrustRoot,
    data_dir: &std::path::Path,
    journal: &mut InstallJournal,
) -> Result<(), String> {
    if !manifest_url.starts_with("https://") {
        return Err(format!("{MANIFEST_URL_ENV} must use https://"));
    }
    let signed = fetch_signed_manifest(manifest_url)?;
    let verified = signed
        .verify(trust_root)
        .map_err(|err| format!("manifest signature rejected: {err}"))?;
    if !verified.artifact_url.starts_with("https://") {
        return Err("verified artifact URL must use https://".to_string());
    }
    let artifact_url = verified.artifact_url.clone();
    let active = journal
        .active_slot()
        .map_err(|err| err.to_string())?
        .map(|slot| journal.slot_info(slot))
        .transpose()
        .map_err(|err| err.to_string())?;
    if active.as_ref().is_some_and(|slot| {
        slot.security_counter == Some(verified.security_counter)
            && slot.artifact_sha256.as_deref() == Some(&verified.artifact_sha256)
    }) {
        println!(
            "[canvas-edge-updaterd] signed release already installed: version={}, security_counter={}",
            verified.version, verified.security_counter
        );
        return Ok(());
    }
    let installed_security_counter = active
        .and_then(|slot| slot.security_counter)
        .unwrap_or(0);
    let protocol_version = configured_u64(PROTOCOL_VERSION_ENV, 1) as u32;
    let schema_version = configured_u64(SCHEMA_VERSION_ENV, 1);

    let outcome = perform_rollout(
        journal,
        trust_root,
        &signed,
        &artifact_url,
        &data_dir.join("installed"),
        installed_security_counter,
        running_architecture(),
        protocol_version,
        schema_version,
        None,
        chrono::Utc::now(),
        default_health_check,
        None,
    )
    .map_err(|err| err.to_string())?;
    println!(
        "[canvas-edge-updaterd] signed release delivery completed: {outcome:?}, source={artifact_url}"
    );
    Ok(())
}

/// Handles a startup-recovery recommendation for ONE journal subject, performing the actual
/// on-disk binary swap (via canvas_edge_updater::rollout::perform_rollback) when the journal
/// recommends RollBack. `installed_root` and `active_binary_path` identify which subject this
/// journal tracks (the Agent package, or the updater's own binary), so the same logic serves both
/// without forking it.
fn handle_recovery_action(
    journal: &mut InstallJournal,
    installed_root: &std::path::Path,
    active_binary_path: &std::path::Path,
    subject: &str,
) {
    let action = match journal.recover_on_startup() {
        Ok(action) => action,
        Err(err) => {
            eprintln!("[canvas-edge-updaterd] {subject} startup recovery failed: {err}");
            std::process::exit(1);
        }
    };
    println!("[canvas-edge-updaterd] {subject} startup recovery recommendation: {action:?}");

    match action {
        RecoveryAction::Nothing => {
            println!("[canvas-edge-updaterd] {subject} recovery: nothing to do");
        }
        RecoveryAction::ResumeInstall(slot) => {
            println!(
                "[canvas-edge-updaterd] {subject} recovery: resume recommended for slot {slot:?}, but no candidate source is tracked yet; manual intervention required"
            );
        }
        RecoveryAction::RollForward(slot) => {
            println!(
                "[canvas-edge-updaterd] {subject} recovery: roll-forward recommended for slot {slot:?} (candidate has booted and/or health-checked but is not yet committed known-good); no automatic action taken -- a future successful boot/health-check cycle, or the crash-loop threshold, will resolve this on a later recover_on_startup call"
            );
        }
        RecoveryAction::RollBack(slot) => {
            println!(
                "[canvas-edge-updaterd] {subject} recovery: roll-back recommended for slot {slot:?} (crash loop or explicit failure); the journal has already marked it Failed and cleared it as the tracked candidate"
            );
            match perform_rollback(journal, installed_root, active_binary_path) {
                Ok(target) => {
                    println!(
                        "[canvas-edge-updaterd] {subject} recovery: rolled back to known-good slot {target:?}; swapped {} to its previously-installed artifact (previous binary preserved as {}.previous)",
                        active_binary_path.display(),
                        active_binary_path.display()
                    );
                }
                Err(canvas_edge_updater::rollout::RolloutError::Journal(
                    canvas_edge_updater::journal::JournalError::NoKnownGoodSlot,
                )) => {
                    println!(
                        "[canvas-edge-updaterd] {subject} recovery: no known-good slot available to roll back to; manual intervention required"
                    );
                }
                Err(err) => {
                    println!(
                        "[canvas-edge-updaterd] {subject} recovery: rollback file-swap failed ({err}); the journal metadata was updated but the live binary was NOT swapped -- manual intervention required"
                    );
                }
            }
        }
    }
}

fn main() {
    let data_dir = resolve_data_dir();

    if let Err(err) = std::fs::create_dir_all(&data_dir) {
        eprintln!(
            "[canvas-edge-updaterd] failed to create data dir {}: {err}",
            data_dir.display()
        );
        std::process::exit(1);
    }

    let db_path = data_dir.join("updater.sqlite3");
    println!(
        "[canvas-edge-updaterd] opening durable Agent-package install journal at {}",
        db_path.display()
    );

    let mut journal = match InstallJournal::open(&db_path) {
        Ok(journal) => journal,
        Err(err) => {
            eprintln!("[canvas-edge-updaterd] failed to open Agent-package install journal: {err}");
            std::process::exit(1);
        }
    };

    // --- Agent-package journal recovery -----------------------------------------------
    let agent_installed_root = data_dir.join("installed");
    let agent_active_binary = resolve_active_binary_path();
    handle_recovery_action(
        &mut journal,
        &agent_installed_root,
        &agent_active_binary,
        "agent-package",
    );

    match (journal.active_slot(), journal.candidate_slot()) {
        (Ok(active), Ok(candidate)) => {
            println!("[canvas-edge-updaterd] agent-package slots: active={active:?} candidate={candidate:?}");
        }
        (Err(err), _) | (_, Err(err)) => {
            eprintln!("[canvas-edge-updaterd] failed to read Agent-package slot state: {err}");
            std::process::exit(1);
        }
    }

    // --- Updater's OWN journal (self-upgrade) recovery -------------------------------
    // A second, fully independent journal instance tracking the updater's own two slots. It uses a
    // separate SQLite file, a separate installed_root, and a separate active_binary_path so the two
    // subjects are never conflated (see module docs in edge/updater/src/self_upgrade.rs).
    let self_db_path = data_dir.join("updater-self.sqlite3");
    println!(
        "[canvas-edge-updaterd] opening durable updater-self install journal at {}",
        self_db_path.display()
    );
    let mut self_journal = match InstallJournal::open(&self_db_path) {
        Ok(journal) => journal,
        Err(err) => {
            eprintln!("[canvas-edge-updaterd] failed to open updater-self install journal: {err}");
            std::process::exit(1);
        }
    };

    let self_installed_root = data_dir.join("installed-self");
    let self_active_binary = resolve_updater_active_binary_path();
    // Use the self-upgrade recovery helper (reusing perform_rollback / swap_active_binary) for the
    // updater's own journal. A RollBack here atomically swaps the updater binary at
    // self_active_binary so the NEXT process start launches the restored version.
    match recover_self_upgrade(&mut self_journal, &self_installed_root, &self_active_binary) {
        Ok(action) => {
            println!(
                "[canvas-edge-updaterd] updater-self startup recovery recommendation: {action:?}"
            );
            if let canvas_edge_updater::journal::RecoveryAction::RollBack(_) = action {
                println!(
                    "[canvas-edge-updaterd] updater-self recovery: rolled back; swapped {} to its previously-installed artifact (previous binary preserved as {}.previous). NOTE: takes effect on next process start (systemd Restart=on-failure), not in-process.",
                    self_active_binary.display(),
                    self_active_binary.display()
                );
            }
        }
        Err(err) => {
            eprintln!("[canvas-edge-updaterd] updater-self startup recovery failed: {err}");
            std::process::exit(1);
        }
    }

    match (self_journal.active_slot(), self_journal.candidate_slot()) {
        (Ok(active), Ok(candidate)) => {
            println!(
                "[canvas-edge-updaterd] updater-self slots: active={active:?} candidate={candidate:?}"
            );
        }
        (Err(err), _) | (_, Err(err)) => {
            eprintln!("[canvas-edge-updaterd] failed to read updater-self slot state: {err}");
            std::process::exit(1);
        }
    }

    let trust_root = load_configured_trust_root();
    match trust_root {
        Some(_) => {
            println!("[canvas-edge-updaterd] release trust root configured ({TRUST_ROOT_ENV})");
        }
        None => {
            println!(
                "[canvas-edge-updaterd] no release trust root configured ({TRUST_ROOT_ENV} unset); \
                 manifest verification is not available in this development slice"
            );
        }
    }

    if let Ok(manifest_url) = env::var(MANIFEST_URL_ENV) {
        let Some(trust_root) = trust_root.as_ref() else {
            eprintln!(
                "[canvas-edge-updaterd] {MANIFEST_URL_ENV} is configured but {TRUST_ROOT_ENV} is missing or invalid"
            );
            std::process::exit(1);
        };
        println!("[canvas-edge-updaterd] fetching signed release manifest from {manifest_url}");
        if let Err(err) = run_configured_rollout(&manifest_url, trust_root, &data_dir, &mut journal)
        {
            eprintln!("[canvas-edge-updaterd] signed release delivery failed: {err}");
            std::process::exit(1);
        }
    }

    // Manual testing/demo trigger only -- see canvas_edge_updater::rollout::run_demo_rollout's
    // doc comment. This is the shape a future networked daemon would eventually call
    // canvas_edge_updater::rollout::perform_rollout too, except with a real fetched artifact path
    // and a real, independently-provisioned trust root/signed manifest instead of a freshly
    // generated, self-trusting demo key.
    if env::var(DEMO_ROLLOUT_ENV).as_deref() == Ok("1") {
        println!("[canvas-edge-updaterd] {DEMO_ROLLOUT_ENV}=1: running demo rollout");
        match run_demo_rollout(&data_dir, &mut journal) {
            Ok(outcome) => {
                println!("[canvas-edge-updaterd] demo rollout outcome: {outcome:?}");
            }
            Err(err) => {
                eprintln!("[canvas-edge-updaterd] demo rollout failed: {err}");
            }
        }
    }

    // Manual testing/demo trigger only -- see canvas_edge_updater::self_upgrade::run_demo_self_upgrade's
    // doc comment. Exercises the updater's OWN self-upgrade path (separate SQLite file, separate
    // installed_root, separate active_binary_path) end-to-end from this binary. Not a real update.
    if env::var(DEMO_SELF_UPGRADE_ENV).as_deref() == Ok("1") {
        println!("[canvas-edge-updaterd] {DEMO_SELF_UPGRADE_ENV}=1: running demo self-upgrade");
        match run_demo_self_upgrade(&data_dir, &mut self_journal) {
            Ok(outcome) => {
                println!("[canvas-edge-updaterd] demo self-upgrade outcome: {outcome:?}");
            }
            Err(err) => {
                eprintln!("[canvas-edge-updaterd] demo self-upgrade failed: {err}");
            }
        }
    }

    let running = Arc::new(AtomicBool::new(true));
    let handler_running = Arc::clone(&running);
    if let Err(err) = ctrlc::set_handler(move || {
        println!("[canvas-edge-updaterd] shutdown signal received");
        handler_running.store(false, Ordering::SeqCst);
    }) {
        eprintln!("[canvas-edge-updaterd] failed to install signal handler: {err}");
        std::process::exit(1);
    }

    println!("[canvas-edge-updaterd] ready");
    while running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(250));
    }

    println!("[canvas-edge-updaterd] shutting down cleanly");
}
