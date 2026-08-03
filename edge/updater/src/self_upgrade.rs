//! Self-upgrade of the updater's own binary, reusing the generic two-slot journal and the shared
//! rollout/rollback logic from [`crate::rollout`].
//!
//! The updater is itself a release artifact (product `canvas-edge-updaterd`). To upgrade itself
//! safely it opens a **second, independent** [`crate::journal::InstallJournal`] instance against a
//! distinct SQLite file (for example `updater-self.sqlite3`), fully isolated from the
//! Agent-package journal (`updater.sqlite3`). Both journals share the exact same schema and state
//! machine -- only the on-disk file, the `installed_root` (where the updater's own slot artifacts
//! live), and the `active_binary_path` (the running `canvas-edge-updaterd` binary) differ. This is
//! the "generic schema, separate instances" design intent from `journal/state.rs`'s module doc
//! comment, now proven end-to-end rather than documented as future work.
//!
//! ## Re-exec on next start (honest scope note)
//!
//! A running process cannot replace its own executing binary and re-exec in place within this
//! simple design. [`crate::rollout::perform_rollback`] / [`crate::rollout::swap_active_binary`]
//! atomically swap the binary file at `active_binary_path` so that the **next** process start
//! (for example, systemd `Restart=on-failure`, or a normal unit restart) launches the
//! newly-swapped `canvas-edge-updaterd`. This is the standard "separate-package self-update"
//! pattern and is acceptable for Phase 1. What is **not** done here: an in-process re-exec of the
//! new binary, and a self-health gate that verifies the newly-swapped updater actually starts
//! before the old process exits. Those are deferred (see `docs/CANVAS_CORE_EDGE_STATUS.md`).

use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

use crate::fetch::HttpClient;
use crate::journal::{InstallJournal, JournalError, RecoveryAction};
use crate::manifest::{
    encode_hex, Architecture, ReleaseManifest, ReleaseTrustRoot, SignedReleaseManifest,
    SignedRollbackAuthorization,
};
use crate::rollout::{
    default_health_check, perform_rollback, perform_rollout, DemoRolloutError, RolloutError,
    RolloutOutcome,
};

/// Runs one self-upgrade rollout attempt against the updater's **own** journal. This is a thin,
/// documented forwarder onto [`perform_rollout`] -- the journal, install root, and active binary
/// are all the updater's own, but the state machine and artifact handling are identical to the
/// Agent-package path. No journal logic is duplicated; this exists only to give the self-upgrade
/// case a clear, named seam in the public API.
#[allow(clippy::too_many_arguments)]
pub fn perform_self_upgrade_rollout(
    journal: &mut InstallJournal,
    trust_root: &ReleaseTrustRoot,
    signed_manifest: &SignedReleaseManifest,
    candidate_artifact_source: &str,
    installed_root: &Path,
    installed_security_counter: u64,
    running_architecture: Architecture,
    current_protocol_version: u32,
    current_schema_version: u64,
    rollback_authorization: Option<&SignedRollbackAuthorization>,
    now: DateTime<Utc>,
    health_check: impl FnOnce(&Path) -> bool,
    http_client: Option<&dyn HttpClient>,
) -> Result<RolloutOutcome, RolloutError> {
    perform_rollout(
        journal,
        trust_root,
        signed_manifest,
        candidate_artifact_source,
        installed_root,
        installed_security_counter,
        running_architecture,
        current_protocol_version,
        current_schema_version,
        rollback_authorization,
        now,
        health_check,
        http_client,
    )
}

/// Handles the startup-recovery recommendation from the updater's **own** journal, reusing the
/// shared [`perform_rollback`] (which calls [`crate::rollout::swap_active_binary`]) so the on-disk
/// binary swap is identical to the Agent-package rollback path. Returns the action that was
/// recommended (so the daemon can log it).
///
/// A `RollBack` recommendation means one of two things, and [`perform_rollback`] only succeeds
/// when there is a *known-good* slot to swap back to:
///
/// * **Post-commit rollback** -- the candidate had been committed known-good and flipped active,
///   then later failed. A real binary swap is required and is performed here.
/// * **Pre-commit crash loop** -- the candidate never reached known-good, so `active_slot` never
///   moved. [`InstallJournal::recover_on_startup`] has already durably abandoned the candidate, and
///   there is no prior binary to restore; [`perform_rollback`] returns
///   [`JournalError::NoKnownGoodSlot`], which we treat as "nothing to swap" rather than an error.
pub fn recover_self_upgrade(
    journal: &mut InstallJournal,
    installed_root: &Path,
    active_binary_path: &Path,
) -> Result<RecoveryAction, RolloutError> {
    let action = journal.recover_on_startup()?;
    if let RecoveryAction::RollBack(slot) = action {
        match perform_rollback(journal, installed_root, active_binary_path) {
            Ok(_) => {}
            Err(RolloutError::Journal(JournalError::NoKnownGoodSlot)) => {
                // Pre-commit crash loop: the candidate was already abandoned by
                // recover_on_startup and there is no prior binary to restore. Nothing to swap.
            }
            Err(other) => return Err(other),
        }
        // Re-acknowledge the slot in the returned action for logging clarity.
        return Ok(RecoveryAction::RollBack(slot));
    }
    Ok(action)
}

/// Runs one self-contained demonstration self-upgrade against `journal`, using an ephemeral,
/// freshly generated signing key that trusts only itself. See [`run_demo_self_upgrade`]'s caller
/// (`edge/updaterd`) docs for exactly what this proves (real `perform_self_upgrade_rollout` wiring
/// against the updater's own journal) and does not prove (nothing about real release
/// signing/distribution of the updater binary).
///
/// The demo candidate's `product` is `canvas-edge-updaterd` (a genuine self-upgrade manifest, not
/// the Agent's `canvas-edge-agent` product), and its `security_counter` is always one greater than
/// whatever is currently installed (or `1` on the very first call), so repeated invocations look
/// like a normal forward upgrade. The demo artifact is written under `data_dir` and, on success,
/// installed to `<data_dir>/installed-self/<slot>/artifact` exactly like a real self-upgrade.
///
/// This is a demo/manual-testing helper only, not part of the real self-upgrade contract.
pub fn run_demo_self_upgrade(
    data_dir: &Path,
    journal: &mut InstallJournal,
) -> Result<RolloutOutcome, DemoRolloutError> {
    let signing_key = SigningKey::generate(&mut OsRng);
    let trust_root = ReleaseTrustRoot::new(signing_key.verifying_key());

    let installed_security_counter = match journal.active_slot()? {
        Some(active) => journal.slot_info(active)?.security_counter.unwrap_or(0),
        None => 0,
    };
    let candidate_security_counter = installed_security_counter + 1;

    // This development slice only ever runs on the two active release targets (see architecture
    // plan 21.1); pick whichever matches the host this demo happens to be compiled/run on so the
    // architecture check in evaluate_candidate passes.
    let running_architecture = if cfg!(target_arch = "aarch64") {
        Architecture::Arm64
    } else {
        Architecture::Amd64
    };

    let artifact_bytes = format!(
        "canvas-edge-updaterd self-upgrade artifact, security_counter={candidate_security_counter}"
    )
    .into_bytes();
    let artifact_path = data_dir.join("demo-self-candidate-artifact.bin");
    fs::write(&artifact_path, &artifact_bytes).map_err(|source| {
        DemoRolloutError::WriteDemoArtifact {
            path: artifact_path.clone(),
            source,
        }
    })?;

    let manifest = ReleaseManifest {
        product: "canvas-edge-updaterd".to_string(),
        version: format!("self-demo-{candidate_security_counter}"),
        architecture: running_architecture,
        protocol_min: 0,
        protocol_max: u32::MAX,
        artifact_url: format!("file://{}", artifact_path.display()),
        artifact_size_bytes: artifact_bytes.len() as u64,
        artifact_sha256: encode_hex(&Sha256::digest(&artifact_bytes)),
        required_disk_bytes: 0,
        rollback_compatible_versions: vec![],
        channel: "demo".to_string(),
        health_check_timeout_secs: 5,
        security_counter: candidate_security_counter,
        schema_min: 0,
        schema_max: u64::MAX,
    };
    let signed_manifest = SignedReleaseManifest::sign(manifest, &signing_key);

    let installed_root = data_dir.join("installed-self");

    perform_self_upgrade_rollout(
        journal,
        &trust_root,
        &signed_manifest,
        artifact_path
            .to_str()
            .expect("demo self-upgrade artifact path is valid UTF-8"),
        &installed_root,
        installed_security_counter,
        running_architecture,
        0, // current_protocol_version: within the demo manifest's wide-open [0, u32::MAX]
        0, // current_schema_version: within the demo manifest's wide-open [0, u64::MAX]
        None,
        Utc::now(),
        default_health_check,
        None, // http_client: local-file path, no HTTP fetch needed
    )
    .map_err(DemoRolloutError::from)
}
