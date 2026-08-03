//! Scene manifest rollback: a small JSON file outside the SQLite database that records the last
//! known-good scene manifest. This file survives database corruption, so the Agent can roll back
//! to the last working scene after a corruption event.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// The file name for the scene manifest checkpoint, stored in the data directory alongside the
/// SQLite database.
pub const SCENE_MANIFEST_FILE: &str = "scene_manifest.json";

/// A checkpoint of the last known-good scene manifest, stored outside the SQLite database so it
/// survives database corruption.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SceneManifestCheckpoint {
    /// The JSON scene manifest that was last successfully activated.
    pub manifest_json: String,
    /// The timestamp (ISO 8601) when this checkpoint was written.
    pub activated_at: String,
}

/// Writes the scene manifest checkpoint to disk. Called on every successful scene activation.
/// Returns `Ok(())` on success, or `Err` with an IO error description.
pub fn write_scene_manifest_checkpoint(data_dir: &Path, manifest_json: &str) -> Result<(), String> {
    let path = data_dir.join(SCENE_MANIFEST_FILE);
    let checkpoint = SceneManifestCheckpoint {
        manifest_json: manifest_json.to_string(),
        activated_at: chrono::Utc::now().to_rfc3339(),
    };
    let json = serde_json::to_string_pretty(&checkpoint)
        .map_err(|e| format!("failed to serialize scene manifest checkpoint: {e}"))?;
    // Write atomically: write to a temp file, then rename.
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &json)
        .map_err(|e| format!("failed to write scene manifest checkpoint: {e}"))?;
    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("failed to rename scene manifest checkpoint: {e}"))?;
    Ok(())
}

/// Loads the last known-good scene manifest checkpoint from disk. Returns `None` if no checkpoint
/// exists or if it cannot be read/parsed.
pub fn load_scene_manifest_checkpoint(data_dir: &Path) -> Option<SceneManifestCheckpoint> {
    let path = data_dir.join(SCENE_MANIFEST_FILE);
    if !path.exists() {
        return None;
    }
    let json = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

/// Clears (deletes) the scene manifest checkpoint file. Useful when the user explicitly resets
/// the scene or when a fresh start is desired.
pub fn clear_scene_manifest_checkpoint(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join(SCENE_MANIFEST_FILE);
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("failed to remove scene manifest checkpoint: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn manifest_checkpoint_is_written_and_read_back() {
        let dir = tempdir().expect("tempdir");
        let manifest = r#"{"document":{"logical_path":"scene.json","media_type":"application/vnd.canvas.scene+json","hash":"sha256:abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890","size":42},"assets":[],"security":{"allowed_origins":[]}}"#;
        write_scene_manifest_checkpoint(dir.path(), manifest).expect("write checkpoint");
        let loaded = load_scene_manifest_checkpoint(dir.path()).expect("load checkpoint");
        assert_eq!(loaded.manifest_json, manifest);
        assert!(!loaded.activated_at.is_empty());
    }

    #[test]
    fn manifest_checkpoint_none_when_no_file() {
        let dir = tempdir().expect("tempdir");
        assert!(load_scene_manifest_checkpoint(dir.path()).is_none());
    }

    #[test]
    fn manifest_checkpoint_clear_removes_file() {
        let dir = tempdir().expect("tempdir");
        let manifest = r#"{"document":{"logical_path":"scene.json","media_type":"application/vnd.canvas.scene+json","hash":"sha256:abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890","size":42},"assets":[],"security":{"allowed_origins":[]}}"#;
        write_scene_manifest_checkpoint(dir.path(), manifest).expect("write checkpoint");
        assert!(load_scene_manifest_checkpoint(dir.path()).is_some());
        clear_scene_manifest_checkpoint(dir.path()).expect("clear checkpoint");
        assert!(load_scene_manifest_checkpoint(dir.path()).is_none());
    }
}
