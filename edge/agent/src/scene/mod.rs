pub(crate) mod digest;
mod generated;

pub use digest::{
    canonicalize_scene_manifest_v1, compute_scene_manifest_digest_v1,
    parse_scene_manifest_json_strict, verify_scene_manifest_digest_v1, SceneDigestError,
    SceneDigestErrorCode,
};
pub use generated::*;

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;

pub const MAX_SCENE_OBJECT_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_SCENE_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SceneManifestSemanticError(String);

impl SceneManifestSemanticError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for SceneManifestSemanticError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SceneManifestSemanticError {}

fn required_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, SceneManifestSemanticError> {
    object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| SceneManifestSemanticError::new(format!("{field} must be an object")))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, SceneManifestSemanticError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| SceneManifestSemanticError::new(format!("{field} must be a string")))
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_canonical_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 || value.starts_with('/') || value.contains('\\') {
        return false;
    }

    value.split('/').all(|segment| {
        if segment.is_empty() || segment == "." || segment == ".." || segment.len() > 128 {
            return false;
        }

        let bytes = segment.as_bytes();
        bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            && bytes
                .last()
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'-'))
    })
}

fn is_canonical_http_origin(value: &str) -> bool {
    let authority = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    authority.is_some_and(|authority| {
        !authority.is_empty()
            && !authority
                .bytes()
                .any(|byte| matches!(byte, b'/' | b'@' | b'?' | b'#'))
    })
}

/// Applies Scene Manifest v1 rules that JSON Schema cannot express, such as
/// logical-path uniqueness, aggregate byte limits, and repeated-hash metadata consistency.
pub fn validate_scene_manifest_semantics(value: &Value) -> Result<(), SceneManifestSemanticError> {
    let manifest = value
        .as_object()
        .ok_or_else(|| SceneManifestSemanticError::new("manifest must be an object"))?;
    let document = required_object(manifest, "document")?;

    if required_string(document, "logical_path")? != "scene.json" {
        return Err(SceneManifestSemanticError::new(
            "document.logical_path must be scene.json",
        ));
    }
    if required_string(document, "media_type")? != "application/vnd.canvas.scene+json" {
        return Err(SceneManifestSemanticError::new(
            "document.media_type must be application/vnd.canvas.scene+json",
        ));
    }

    let assets = manifest
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| SceneManifestSemanticError::new("assets must be an array"))?;
    let mut references: Vec<&Map<String, Value>> = Vec::with_capacity(assets.len() + 1);
    references.push(document);
    for (index, asset) in assets.iter().enumerate() {
        references.push(asset.as_object().ok_or_else(|| {
            SceneManifestSemanticError::new(format!("assets[{index}] must be an object"))
        })?);
    }

    let mut logical_paths = HashSet::new();
    let mut hash_sizes = HashMap::new();
    let mut total_bytes = 0_u64;

    for reference in references {
        let logical_path = required_string(reference, "logical_path")?;
        let hash = required_string(reference, "hash")?;
        let size = reference
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(|| SceneManifestSemanticError::new("size must be a positive integer"))?;

        if !is_canonical_logical_path(logical_path) {
            return Err(SceneManifestSemanticError::new(format!(
                "logical path is not canonical: {logical_path}"
            )));
        }
        if !logical_paths.insert(logical_path.to_owned()) {
            return Err(SceneManifestSemanticError::new(format!(
                "duplicate logical path: {logical_path}"
            )));
        }
        if !is_sha256_digest(hash) {
            return Err(SceneManifestSemanticError::new(format!(
                "invalid SHA-256 digest for {logical_path}"
            )));
        }
        if size == 0 || size > MAX_SCENE_OBJECT_BYTES {
            return Err(SceneManifestSemanticError::new(format!(
                "object {logical_path} exceeds the {MAX_SCENE_OBJECT_BYTES}-byte limit"
            )));
        }
        if let Some(prior_size) = hash_sizes.insert(hash.to_owned(), size) {
            if prior_size != size {
                return Err(SceneManifestSemanticError::new(format!(
                    "hash {hash} has conflicting declared sizes"
                )));
            }
        }

        total_bytes = total_bytes
            .checked_add(size)
            .ok_or_else(|| SceneManifestSemanticError::new("scene byte total overflowed"))?;
        if total_bytes > MAX_SCENE_TOTAL_BYTES {
            return Err(SceneManifestSemanticError::new(format!(
                "scene exceeds the {MAX_SCENE_TOTAL_BYTES}-byte aggregate limit"
            )));
        }
    }

    let security = required_object(manifest, "security")?;
    let origins = security
        .get("allowed_origins")
        .and_then(Value::as_array)
        .ok_or_else(|| SceneManifestSemanticError::new("allowed_origins must be an array"))?;
    for origin in origins {
        let origin = origin
            .as_str()
            .ok_or_else(|| SceneManifestSemanticError::new("allowed origin must be a string"))?;
        if !is_canonical_http_origin(origin) {
            return Err(SceneManifestSemanticError::new(format!(
                "allowed origin contains credentials, a path, query, or fragment: {origin}"
            )));
        }
    }

    Ok(())
}
