//! Rollout orchestration: wires `manifest` verification/anti-downgrade evaluation together with
//! `journal` state transitions into one end-to-end "install a candidate release" flow, per
//! `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.3 ("Rollout flow") steps 3-9.
//!
//! [`perform_rollout`] is the entry point. In order, it:
//!
//! 1. Verifies the signed manifest against the release trust root
//!    ([`SignedReleaseManifest::verify`]).
//! 2. Evaluates the verified manifest against currently installed/running state
//!    ([`evaluate_candidate`]) -- architecture, protocol/schema compatibility, and anti-downgrade
//!    policy. A rejection here never touches the journal at all.
//! 3. Picks the correct slot to stage into (whichever slot is *not* [`InstallJournal::active_slot`],
//!    or [`Slot::A`] on the very first-ever install when no slot is active yet -- this mirrors the
//!    exact "the slot that is not currently active" convention already used by
//!    [`InstallJournal::rollback_to_known_good`]).
//! 4. Stages, marks installing, "downloads" (see below), marks installed, records a boot attempt,
//!    runs a local health check, and either commits known-good or leaves the slot for
//!    [`InstallJournal::recover_on_startup`] to evaluate on the next daemon start.
//!
//! ## Scope note: local-file copy and real HTTP/TLS download
//!
//! [`perform_rollout`] takes the candidate artifact source as a single string,
//! `candidate_artifact_source`. If it starts with `http://` or `https://`, the artifact is
//! fetched via a real streaming HTTP/TLS download implemented in [`crate::fetch`] (with
//! `rustls-tls`, bounded retry with exponential backoff, and streaming SHA-256 verification --
//! see that module's docs for the full design). Otherwise the source is treated as a local
//! filesystem path and the bytes are copied directly, exactly as this module always did.
//!
//! Both paths hash the real bytes and reject (never panic) on a SHA-256 mismatch against
//! [`ReleaseManifest::artifact_sha256`], preserving the existing "hash mismatch leaves the slot
//! stuck at `Installing`, no installed bytes written" contract. The local-file path remains the
//! fallback for tests and for the manual `run_demo_rollout` demo trigger; the URL path is what a
//! future networked `edge/updaterd` will use once a real Core release-artifact endpoint exists.
//!
//! **Still not done in this pass:** HTTP Range/resume (a failed partial is re-fetched from byte 0,
//! not resumed), bandwidth throttling, and any authentication scheme for the release-artifact
//! endpoint (mTLS/bearer token). See `fetch.rs`'s "What is and is not proven here" docs.
//!
//! ## Where "installed" bytes live
//!
//! This module writes the verified artifact bytes to `<installed_root>/<slot>/artifact` (for
//! example `<updater data dir>/installed/a/artifact`), where `installed_root` is supplied by the
//! caller (see [`perform_rollout`]'s `installed_root` parameter). This mirrors the journal's own
//! convention of keeping durable state under the updater's data directory, without this module
//! needing to know the journal's SQLite file path (`InstallJournal` does not expose it).
//!
//! ## Health check
//!
//! The local health check for this pass is deliberately simple and honest: does the installed
//! artifact file exist, and is it non-empty and readable ([`default_health_check`])? This proves
//! the real wiring (`record_boot_attempt` -> health check -> `record_health_check_result` ->
//! `commit_known_good`/leave-for-recovery) without inventing a fake, more "sophisticated" check
//! that would not actually validate anything real yet (there is no renderer, database, or
//! hardware to probe from this crate). [`perform_rollout`] takes the health check as an injectable
//! closure specifically so tests can simulate a failing health check without needing a real
//! broken artifact.
//!
//! ## Artifact hash mismatch handling (a documented, deliberate choice)
//!
//! If the copied bytes do not hash to `artifact_sha256`, this module does **not** call
//! `mark_installed` (per architecture plan step 4's verification requirement -- an artifact whose
//! bytes don't match its declared hash must never be considered installed). At that point the
//! slot is left in `Installing` status in the journal. There is deliberately no call made here to
//! `journal/mod.rs`'s existing public API to durably mark the slot `Failed` directly, because no
//! such public API exists (the only way a slot ever reaches `Failed` today is through
//! `InstallJournal::recover_on_startup`'s crash-loop/explicit-failure policy, which this module
//! does not call or second-guess). Editing `journal/mod.rs` to add one is out of scope for this
//! pass. Instead, [`perform_rollout`] returns [`RolloutError::ArtifactHashMismatch`], and the
//! slot remains `Installing` in the journal; on the next daemon start,
//! `InstallJournal::recover_on_startup` will see `Installing` and recommend
//! `RecoveryAction::ResumeInstall` for that slot. A future task should decide whether a
//! hash-mismatch should instead route through `mark_installed` +
//! `record_health_check_result(slot, false)` so the existing crash-loop/rollback recovery path
//! eventually reclaims the slot automatically -- this pass deliberately does not make that call,
//! since architecture plan step 4 treats hash verification as a precondition for installation, not
//! a health check outcome.

//! ## Manual testing/demo trigger
//!
//! [`run_demo_rollout`] is a self-contained, in-process demonstration helper for
//! `edge/updaterd`: it generates an ephemeral Ed25519 signing key, signs a synthetic demo
//! manifest with it, writes a small demo artifact file, and runs a real [`perform_rollout`] call
//! against the real journal. It exists purely so the daemon binary (`edge/updaterd/src/main.rs`,
//! enabled by the `CANVAS_EDGE_UPDATER_DEMO_ROLLOUT=1` environment variable) can exercise this
//! module's wiring end-to-end without needing a real Core release feed, real signing
//! infrastructure, or `ed25519-dalek`/`chrono` as *direct* dependencies of the `updaterd` crate
//! (`canvas_edge_updater`, this library, already depends on them). **This is not how a real
//! release is signed** -- per ADR 0008, "The release signing private key is offline or isolated
//! in CI" -- `run_demo_rollout`'s freshly generated key exists only for this one demonstration
//! call and trusts itself, which is meaningless for a real rollout's security guarantees.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

use crate::fetch::{
    decode_sha256_hex, download_artifact, FetchBackoffConfig, FetchError, HttpClient,
    RealHttpClient,
};
use crate::journal::{InstallJournal, JournalError, Slot};
use crate::manifest::{
    encode_hex, evaluate_candidate, Architecture, ManifestError, RejectionReason, ReleaseManifest,
    ReleaseTrustRoot, SignedReleaseManifest, SignedRollbackAuthorization,
};

/// What happened as a result of a call to [`perform_rollout`] that got far enough to touch the
/// journal at all (rejections before staging are returned as [`RolloutError`] instead, per the
/// "reject before touching the journal" contract described in this module's docs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RolloutOutcome {
    /// The candidate was staged, installed, passed its local health check, and was committed as
    /// the new known-good/active slot.
    CommittedKnownGood { slot: Slot },
    /// The candidate was staged and installed, but the local health check failed. Per
    /// architecture plan step 8/9, this is deliberately left for
    /// [`InstallJournal::recover_on_startup`] to evaluate on the next daemon start rather than
    /// being second-guessed here -- see this module's docs.
    HealthCheckFailed { slot: Slot },
}

/// Why [`perform_rollout`] did not reach a [`RolloutOutcome`].
#[derive(Debug)]
pub enum RolloutError {
    /// The signed manifest failed to verify against the supplied trust root. Nothing was staged;
    /// the journal was never touched.
    ManifestVerification(ManifestError),
    /// [`evaluate_candidate`] rejected the (already-verified) candidate. Nothing was staged; the
    /// journal was never touched.
    CandidateRejected(RejectionReason),
    /// A journal operation itself failed (for example, a concurrent unresolved candidate already
    /// occupies the target slot).
    Journal(JournalError),
    /// The bytes read from the candidate artifact source (local file or HTTP download) do not
    /// hash to the manifest's `artifact_sha256`. `mark_installed` was never called; the slot
    /// remains `Installing` in the journal -- see this module's docs for exactly what that implies
    /// for recovery. On the local-file path this is the variant returned; on the URL path a
    /// hash mismatch is reported as [`RolloutError::FetchFailed`] wrapping a
    /// [`crate::fetch::FetchError::HashMismatch`] instead, but the journal-state guarantee is
    /// identical.
    ArtifactHashMismatch {
        slot: Slot,
        expected_sha256: String,
        actual_sha256: String,
    },
    /// Could not read the candidate artifact bytes from the local-file source path (the
    /// local-file fallback for a real download -- see module docs). On the URL path, the
    /// equivalent read-after-download failure is also reported here.
    ArtifactReadFailed {
        path: PathBuf,
        source: std::io::Error,
    },
    /// Could not write the verified artifact bytes to their installed destination under
    /// `installed_root`.
    ArtifactWriteFailed {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A real HTTP/TLS download of the candidate artifact (when `candidate_artifact_source` is an
    /// `http://`/`https://` URL) failed after all retries, or the downloaded bytes did not hash to
    /// the manifest's `artifact_sha256`. As with [`RolloutError::ArtifactHashMismatch`],
    /// `mark_installed` was never called; the slot remains `Installing` in the journal. See
    /// `fetch.rs`'s docs for the exact partial-file cleanup guarantees.
    FetchFailed { slot: Slot, source: FetchError },
    /// [`InstallJournal::rollback_to_known_good`] identified a target slot, but the actual on-disk
    /// file-swap back to that slot's previously-installed binary could not be performed. The journal
    /// metadata was already durably updated (the bad slot is marked `Failed`, the target is now
    /// active), so this is reported rather than silently swallowed -- the caller must decide whether
    /// to retry or require manual intervention. See [`swap_active_binary`] and [`perform_rollback`].
    RollbackSwapFailed {
        target_slot: Slot,
        active_binary_path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Display for RolloutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ManifestVerification(err) => write!(f, "manifest verification failed: {err}"),
            Self::CandidateRejected(reason) => write!(f, "candidate rejected: {reason}"),
            Self::Journal(err) => write!(f, "journal error: {err}"),
            Self::ArtifactHashMismatch {
                slot,
                expected_sha256,
                actual_sha256,
            } => write!(
                f,
                "artifact hash mismatch for slot {slot}: expected {expected_sha256}, got {actual_sha256}"
            ),
            Self::ArtifactReadFailed { path, source } => {
                write!(f, "failed to read candidate artifact at {}: {source}", path.display())
            }
            Self::ArtifactWriteFailed { path, source } => {
                write!(f, "failed to write installed artifact at {}: {source}", path.display())
            }
            Self::FetchFailed { slot, source } => {
                write!(f, "fetch failed for slot {slot}: {source}")
            }
            Self::RollbackSwapFailed {
                target_slot,
                active_binary_path,
                source,
            } => write!(
                f,
                "rollback file-swap failed for target slot {target_slot}: could not replace {}: {source}",
                active_binary_path.display()
            ),
        }
    }
}

impl std::error::Error for RolloutError {}

impl From<JournalError> for RolloutError {
    fn from(error: JournalError) -> Self {
        Self::Journal(error)
    }
}

/// The default, real (but deliberately simple) local health check: the installed artifact file
/// must exist, be a regular file, and be non-empty. See this module's docs for why this level of
/// simplicity is honest for this pass.
pub fn default_health_check(installed_artifact_path: &Path) -> bool {
    match fs::metadata(installed_artifact_path) {
        Ok(metadata) => metadata.is_file() && metadata.len() > 0,
        Err(_) => false,
    }
}

/// Returns the slot [`perform_rollout`] should stage into: whichever slot is not currently
/// active, or [`Slot::A`] if no slot is active yet (the very first install). This mirrors
/// [`InstallJournal::rollback_to_known_good`]'s existing "the rollback target is always the slot
/// that is not currently active" convention, applied to staging instead of rolling back.
fn target_slot(journal: &InstallJournal) -> Result<Slot, RolloutError> {
    Ok(match journal.active_slot()? {
        Some(active) => active.opposite(),
        None => Slot::A,
    })
}

/// Performs one full rollout attempt: verify -> evaluate -> stage -> install (local-file copy
/// or real HTTP/TLS download, see module docs) -> health-check -> commit/leave-for-recovery.
///
/// `candidate_artifact_source` generalizes the prior local-path-only parameter: if it starts
/// with `http://` or `https://`, the candidate is fetched via [`crate::fetch::download_artifact`]
/// (a real streaming HTTP/TLS download with SHA-256 verification and bounded retry); otherwise it
/// is treated as a local filesystem path and copied as before. Both paths hash the real bytes and
/// reject on a mismatch against `manifest.artifact_sha256`, preserving the existing
/// "hash-mismatch leaves the slot stuck at `Installing`, no installed bytes written" contract.
///
/// `http_client` is the injectable HTTP client used only when `candidate_artifact_source` is a
/// URL. Production callers pass `None` (which makes `perform_rollout` construct a real
/// [`RealHttpClient`]); tests that want to exercise the URL path without real network access pass
/// a [`crate::fetch::FakeHttpClient`]. Local-path callers (the existing `rollout_v1.rs` tests)
/// pass `None` -- it is never consulted on that path.
///
/// `installed_root` is the directory under which verified artifact bytes are written, at
/// `<installed_root>/<slot>/artifact` (see module docs). `health_check` is called with the path
/// to that installed artifact file and decides pass/fail; production callers should pass
/// [`default_health_check`], and tests may pass any closure to simulate a failing check.
#[allow(clippy::too_many_arguments)]
pub fn perform_rollout(
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
    let manifest = signed_manifest
        .verify(trust_root)
        .map_err(RolloutError::ManifestVerification)?;

    evaluate_candidate(
        manifest,
        installed_security_counter,
        running_architecture,
        current_protocol_version,
        current_schema_version,
        trust_root,
        rollback_authorization,
        now,
    )
    .map_err(RolloutError::CandidateRejected)?;

    let slot = target_slot(journal)?;

    journal.stage_candidate(
        slot,
        manifest.version.clone(),
        manifest.security_counter,
        manifest.artifact_sha256.clone(),
    )?;
    journal.mark_installing(slot)?;

    // "Download": either a real HTTP/TLS fetch (if the source is a URL) or a local file copy.
    // Both paths produce verified bytes whose SHA-256 matches `manifest.artifact_sha256`, or
    // return an error without calling `mark_installed` (see module docs).
    let installed_path = if candidate_artifact_source.starts_with("http://")
        || candidate_artifact_source.starts_with("https://")
    {
        download_via_http(
            candidate_artifact_source,
            &manifest.artifact_sha256,
            installed_root,
            slot,
            http_client,
        )?
    } else {
        let bytes =
            read_local_candidate(candidate_artifact_source, &manifest.artifact_sha256, slot)?;
        write_installed_artifact(installed_root, slot, &bytes)?
    };

    journal.mark_installed(slot)?;
    journal.record_boot_attempt(slot)?;

    let passed = health_check(&installed_path);
    journal.record_health_check_result(slot, passed)?;

    if passed {
        journal.commit_known_good(slot)?;
        Ok(RolloutOutcome::CommittedKnownGood { slot })
    } else {
        // Do NOT commit. Leave the slot for InstallJournal::recover_on_startup to evaluate on
        // the next daemon start -- see module docs and journal::recovery's own crash-loop policy.
        Ok(RolloutOutcome::HealthCheckFailed { slot })
    }
}

/// Reads the candidate artifact from a local filesystem path and verifies its SHA-256 against
/// `expected_sha256_hex`. On a mismatch, returns [`RolloutError::ArtifactHashMismatch`] without
/// calling `mark_installed` -- the slot remains `Installing` (see module docs).
fn read_local_candidate(
    candidate_artifact_path: &str,
    expected_sha256_hex: &str,
    slot: Slot,
) -> Result<Vec<u8>, RolloutError> {
    let path = Path::new(candidate_artifact_path);
    let bytes = fs::read(path).map_err(|source| RolloutError::ArtifactReadFailed {
        path: path.to_path_buf(),
        source,
    })?;

    let actual_sha256 = encode_hex(&Sha256::digest(&bytes));
    if actual_sha256 != expected_sha256_hex {
        // Deliberately does not call mark_installed or mutate the journal any further -- see
        // module docs ("Artifact hash mismatch handling").
        return Err(RolloutError::ArtifactHashMismatch {
            slot,
            expected_sha256: expected_sha256_hex.to_string(),
            actual_sha256,
        });
    }

    Ok(bytes)
}

/// Atomically swaps the live Agent binary at `active_binary_path` to the previously-installed
/// artifact bytes of `target_slot` (read from `<installed_root>/<target_slot>/artifact`).
///
/// This is the missing half of [`InstallJournal::rollback_to_known_good`]: that function durably
/// records which slot is now active, but does not touch on-disk binaries. `swap_active_binary`
/// performs the actual file-swap using a temp-file + atomic `rename` (the same crash-safe pattern
/// already used by [`write_installed_artifact`]), so a crash mid-swap leaves either the old binary
/// or the new one in place -- never a half-written file. The replaced binary is preserved as
/// `<active_binary_path>.previous` so a future recovery can still inspect what was rolled away from.
///
/// `target_slot`'s artifact bytes are verified against `expected_sha256_hex` before the swap, so a
/// corrupted known-good slot cannot be promoted to live. On a hash mismatch this returns
/// [`RolloutError::ArtifactHashMismatch`] (the journal metadata is already updated by the caller,
/// so this is reported for manual intervention rather than silently reverting the metadata).
///
/// Scope note: this operates on the Agent-package artifact bytes only. The updater's own
/// self-upgrade (swapping the updater binary itself) is documented future reuse of this same
/// mechanism with a different `installed_root`/`active_binary_path`, not built in this pass.
pub fn swap_active_binary(
    installed_root: &Path,
    target_slot: Slot,
    expected_sha256_hex: &str,
    active_binary_path: &Path,
) -> Result<(), RolloutError> {
    let target_artifact = installed_root.join(target_slot.as_str()).join("artifact");
    let bytes = fs::read(&target_artifact).map_err(|source| RolloutError::ArtifactReadFailed {
        path: target_artifact.clone(),
        source,
    })?;

    let actual_sha256 = encode_hex(&Sha256::digest(&bytes));
    if actual_sha256 != expected_sha256_hex {
        return Err(RolloutError::ArtifactHashMismatch {
            slot: target_slot,
            expected_sha256: expected_sha256_hex.to_string(),
            actual_sha256,
        });
    }

    // Preserve the currently-live binary as `.previous` before overwriting it, so recovery can
    // still inspect what was rolled away from (and a future operator can restore it by hand).
    if active_binary_path.exists() {
        let previous_path = active_binary_path.with_extension("previous");
        fs::rename(active_binary_path, &previous_path).map_err(|source| {
            RolloutError::RollbackSwapFailed {
                target_slot,
                active_binary_path: active_binary_path.to_path_buf(),
                source,
            }
        })?;
    }

    // Atomic swap: write to a temp sibling, then rename into place. `rename` is atomic on the same
    // filesystem, so a crash here leaves either the old `.previous` (rename not yet done) or the
    // new live binary (rename done) -- never a truncated live binary.
    let tmp_path = active_binary_path.with_extension("swap.tmp");
    fs::write(&tmp_path, &bytes).map_err(|source| RolloutError::RollbackSwapFailed {
        target_slot,
        active_binary_path: active_binary_path.to_path_buf(),
        source,
    })?;
    fs::rename(&tmp_path, active_binary_path).map_err(|source| {
        RolloutError::RollbackSwapFailed {
            target_slot,
            active_binary_path: active_binary_path.to_path_buf(),
            source,
        }
    })?;

    Ok(())
}

/// Performs a full rollback to the last known-good slot: durably records the rollback in the
/// journal ([`InstallJournal::rollback_to_known_good`]) and then performs the actual on-disk
/// file-swap back to that slot's previously-installed binary via [`swap_active_binary`].
///
/// This closes the gap that `updaterd`'s `handle_recovery_action` previously only logged about:
/// the journal metadata was updated but no binary was ever restored. Now the recommended
/// [`RecoveryAction::RollBack`] is fully executed -- not just identified.
///
/// Fails closed: if the journal has no known-good slot to roll back to, returns the journal's
/// [`JournalError::NoKnownGoodSlot`] without touching any binaries. If the file-swap itself fails
/// after the metadata update, returns [`RolloutError::RollbackSwapFailed`] so the caller can retry
/// or require manual intervention (the metadata is already correct, so re-running this is safe).
pub fn perform_rollback(
    journal: &mut InstallJournal,
    installed_root: &Path,
    active_binary_path: &Path,
) -> Result<Slot, RolloutError> {
    let target = journal.rollback_to_known_good()?;
    let expected_sha256 = target
        .artifact_sha256
        .ok_or_else(|| JournalError::NoKnownGoodSlot)?;
    swap_active_binary(
        installed_root,
        target.slot,
        &expected_sha256,
        active_binary_path,
    )?;
    Ok(target.slot)
}

/// Fetches the candidate artifact from `url` via a real HTTP/TLS download, streaming directly to
/// the installed slot path (`<installed_root>/<slot>/artifact`) and verifying SHA-256 as it goes
/// (see `fetch::download_artifact`, which writes to a `.partial` sibling and atomically renames
/// on a verified hash match). On any fetch error (including a hash mismatch), returns
/// [`RolloutError::FetchFailed`] without calling `mark_installed` -- the slot remains
/// `Installing`, exactly as the local-path hash-mismatch case does. A hash mismatch from the
/// network path is reported as `FetchFailed` wrapping a `FetchError::HashMismatch`, preserving
/// the same "no installed bytes written" guarantee (the `.partial` file is deleted and the final
/// installed path is never created).
fn download_via_http(
    url: &str,
    expected_sha256_hex: &str,
    installed_root: &Path,
    slot: Slot,
    http_client: Option<&dyn HttpClient>,
) -> Result<PathBuf, RolloutError> {
    let expected_sha256 = decode_sha256_hex(expected_sha256_hex).ok_or_else(|| {
        RolloutError::FetchFailed {
            slot,
            source: FetchError::InvalidUrl {
                url: url.to_string(),
                // A malformed manifest hash is not really an HTTP error, but reusing the
                // FetchFailed slot-stays-Installing contract is the honest behavior here: we
                // never fetched, and we never installed.
                source: crate::fetch::fake_reqwest_error(&format!(
                    "manifest artifact_sha256 is not valid lowercase hex SHA-256: {expected_sha256_hex}"
                )),
            },
        }
    })?;

    // Create the slot directory up front so `download_artifact` can write its `.partial` file
    // directly beside the final installed artifact path. This mirrors `write_installed_artifact`'s
    // directory-creation step for the local-file path.
    let slot_dir = installed_root.join(slot.as_str());
    fs::create_dir_all(&slot_dir).map_err(|source| RolloutError::ArtifactWriteFailed {
        path: slot_dir.clone(),
        source,
    })?;
    let installed_path = slot_dir.join("artifact");

    // Use the injected client if one was supplied (tests), otherwise construct a real
    // `RealHttpClient`. Both branches call `download_artifact` with a `&dyn HttpClient`.
    let real_client_storage: RealHttpClient;
    let client: &dyn HttpClient = match http_client {
        Some(injected) => injected,
        None => {
            real_client_storage = RealHttpClient::new();
            &real_client_storage
        }
    };

    download_artifact(
        client,
        url,
        &installed_path,
        &expected_sha256,
        FetchBackoffConfig::default(),
    )
    .map_err(|source| RolloutError::FetchFailed { slot, source })?;

    Ok(installed_path)
}

fn write_installed_artifact(
    installed_root: &Path,
    slot: Slot,
    bytes: &[u8],
) -> Result<PathBuf, RolloutError> {
    let slot_dir = installed_root.join(slot.as_str());
    fs::create_dir_all(&slot_dir).map_err(|source| RolloutError::ArtifactWriteFailed {
        path: slot_dir.clone(),
        source,
    })?;
    let installed_path = slot_dir.join("artifact");
    fs::write(&installed_path, bytes).map_err(|source| RolloutError::ArtifactWriteFailed {
        path: installed_path.clone(),
        source,
    })?;
    Ok(installed_path)
}

/// Errors from [`run_demo_rollout`]. See its docs -- this is a demo/manual-testing helper only,
/// not part of the real rollout contract.
#[derive(Debug)]
pub enum DemoRolloutError {
    Journal(JournalError),
    WriteDemoArtifact {
        path: PathBuf,
        source: std::io::Error,
    },
    Rollout(RolloutError),
}

impl fmt::Display for DemoRolloutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Journal(err) => write!(f, "journal error: {err}"),
            Self::WriteDemoArtifact { path, source } => write!(
                f,
                "failed to write demo artifact at {}: {source}",
                path.display()
            ),
            Self::Rollout(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for DemoRolloutError {}

impl From<JournalError> for DemoRolloutError {
    fn from(error: JournalError) -> Self {
        Self::Journal(error)
    }
}

impl From<RolloutError> for DemoRolloutError {
    fn from(error: RolloutError) -> Self {
        Self::Rollout(error)
    }
}

/// Runs one self-contained demonstration rollout against `journal`, using an ephemeral, freshly
/// generated signing key that trusts only itself. See this module's "Manual testing/demo
/// trigger" docs above for exactly what this proves (real `perform_rollout` wiring) and does not
/// prove (nothing about real release signing/distribution).
///
/// The demo candidate's `security_counter` is always one greater than whatever is currently
/// installed (or `1` on the very first call), so repeated invocations (for example, restarting
/// `canvas-edge-updaterd` with `CANVAS_EDGE_UPDATER_DEMO_ROLLOUT=1` set multiple times) always
/// look like a normal forward upgrade rather than a downgrade requiring a rollback authorization.
///
/// The demo artifact is written to `<data_dir>/demo-candidate-artifact.bin` (the local-file
/// "download" source, per this module's docs) and, on success, installed to
/// `<data_dir>/installed/<slot>/artifact` exactly like a real rollout.
pub fn run_demo_rollout(
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
        "canvas-edge-updaterd demo artifact, security_counter={candidate_security_counter}"
    )
    .into_bytes();
    let artifact_path = data_dir.join("demo-candidate-artifact.bin");
    fs::write(&artifact_path, &artifact_bytes).map_err(|source| {
        DemoRolloutError::WriteDemoArtifact {
            path: artifact_path.clone(),
            source,
        }
    })?;

    let manifest = ReleaseManifest {
        product: "canvas-edge-updaterd-demo".to_string(),
        version: format!("demo-{candidate_security_counter}"),
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

    let installed_root = data_dir.join("installed");

    perform_rollout(
        journal,
        &trust_root,
        &signed_manifest,
        artifact_path
            .to_str()
            .expect("demo artifact path is valid UTF-8"),
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
