use crate::scene::digest::canonicalize_safe_integer_value;
use crate::scene::{parse_scene_manifest_json_strict, SceneDigestError, SceneDigestErrorCode};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fmt::{self, Write as _};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandRequestDigestErrorCode {
    InvalidJson,
    DuplicateKey,
    InvalidUnicode,
    InvalidNumber,
    InvalidRequest,
}

impl CommandRequestDigestErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::DuplicateKey => "duplicate_key",
            Self::InvalidUnicode => "invalid_unicode",
            Self::InvalidNumber => "invalid_number",
            Self::InvalidRequest => "invalid_request",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandRequestDigestError {
    code: CommandRequestDigestErrorCode,
    message: String,
}

impl CommandRequestDigestError {
    fn new(code: CommandRequestDigestErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn from_scene(error: SceneDigestError) -> Self {
        let code = match error.code() {
            SceneDigestErrorCode::InvalidJson => CommandRequestDigestErrorCode::InvalidJson,
            SceneDigestErrorCode::DuplicateKey => CommandRequestDigestErrorCode::DuplicateKey,
            SceneDigestErrorCode::InvalidUnicode => CommandRequestDigestErrorCode::InvalidUnicode,
            SceneDigestErrorCode::InvalidNumber => CommandRequestDigestErrorCode::InvalidNumber,
            SceneDigestErrorCode::InvalidManifest
            | SceneDigestErrorCode::MissingDigest
            | SceneDigestErrorCode::InvalidDigest
            | SceneDigestErrorCode::DigestMismatch => CommandRequestDigestErrorCode::InvalidRequest,
        };
        Self::new(code, error.to_string())
    }

    pub const fn code(&self) -> CommandRequestDigestErrorCode {
        self.code
    }
}

impl fmt::Display for CommandRequestDigestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CommandRequestDigestError {}

fn valid_command_kind(kind: &str) -> bool {
    let mut segment_count = 0;
    for segment in kind.split('.') {
        segment_count += 1;
        let mut bytes = segment.bytes();
        if !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase()) {
            return false;
        }
        if !bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_') {
            return false;
        }
    }
    segment_count >= 2
}

fn validate_request(value: &Value) -> Result<&Map<String, Value>, CommandRequestDigestError> {
    let object = value.as_object().ok_or_else(|| {
        CommandRequestDigestError::new(
            CommandRequestDigestErrorCode::InvalidRequest,
            "command request digest input must be an object",
        )
    })?;
    const REQUIRED: [&str; 4] = ["kind", "semantic_version", "parameters", "preconditions"];
    if object.len() != REQUIRED.len() || REQUIRED.iter().any(|field| !object.contains_key(*field)) {
        return Err(CommandRequestDigestError::new(
            CommandRequestDigestErrorCode::InvalidRequest,
            "command request digest input must contain exactly kind, semantic_version, parameters, and preconditions",
        ));
    }

    let kind = object.get("kind").and_then(Value::as_str).ok_or_else(|| {
        CommandRequestDigestError::new(
            CommandRequestDigestErrorCode::InvalidRequest,
            "command kind must be a string",
        )
    })?;
    if !valid_command_kind(kind) {
        return Err(CommandRequestDigestError::new(
            CommandRequestDigestErrorCode::InvalidRequest,
            "command kind must be a lowercase namespaced token",
        ));
    }

    let semantic_version = object
        .get("semantic_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            CommandRequestDigestError::new(
                CommandRequestDigestErrorCode::InvalidRequest,
                "semantic_version must be a positive safe integer",
            )
        })?;
    if semantic_version == 0 {
        return Err(CommandRequestDigestError::new(
            CommandRequestDigestErrorCode::InvalidRequest,
            "semantic_version must be a positive safe integer",
        ));
    }

    for field in ["parameters", "preconditions"] {
        if !object.get(field).is_some_and(Value::is_object) {
            return Err(CommandRequestDigestError::new(
                CommandRequestDigestErrorCode::InvalidRequest,
                format!("{field} must be a JSON object"),
            ));
        }
    }

    Ok(object)
}

pub fn canonicalize_command_request_v1(
    raw_json: impl AsRef<[u8]>,
) -> Result<String, CommandRequestDigestError> {
    let value = parse_scene_manifest_json_strict(raw_json)
        .map_err(CommandRequestDigestError::from_scene)?;
    validate_request(&value)?;
    canonicalize_safe_integer_value(&value).map_err(CommandRequestDigestError::from_scene)
}

pub fn compute_command_request_digest_v1(
    raw_json: impl AsRef<[u8]>,
) -> Result<String, CommandRequestDigestError> {
    let canonical = canonicalize_command_request_v1(raw_json)?;
    let hash = Sha256::digest(canonical.as_bytes());
    let mut digest = String::with_capacity(71);
    digest.push_str("sha256:");
    for byte in hash {
        write!(&mut digest, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(digest)
}
