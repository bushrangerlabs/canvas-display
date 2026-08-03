use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::fmt::{self, Write as _};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SAFE_SIGNED_INTEGER: i64 = 9_007_199_254_740_991;
const SHA256_PREFIX: &str = "sha256:";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SceneDigestErrorCode {
    InvalidJson,
    DuplicateKey,
    InvalidUnicode,
    InvalidNumber,
    InvalidManifest,
    MissingDigest,
    InvalidDigest,
    DigestMismatch,
}

impl SceneDigestErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::DuplicateKey => "duplicate_key",
            Self::InvalidUnicode => "invalid_unicode",
            Self::InvalidNumber => "invalid_number",
            Self::InvalidManifest => "invalid_manifest",
            Self::MissingDigest => "missing_digest",
            Self::InvalidDigest => "invalid_digest",
            Self::DigestMismatch => "digest_mismatch",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SceneDigestError {
    code: SceneDigestErrorCode,
    message: String,
}

impl SceneDigestError {
    fn new(code: SceneDigestErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub const fn code(&self) -> SceneDigestErrorCode {
        self.code
    }
}

impl fmt::Display for SceneDigestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SceneDigestError {}

#[derive(Debug)]
enum StrictParseViolation {
    DuplicateKey(String),
    InvalidNumber(String),
}

#[derive(Default)]
struct StrictParseState {
    violation: Option<StrictParseViolation>,
}

struct StrictValueSeed<'state> {
    state: &'state RefCell<StrictParseState>,
}

struct StrictValueVisitor<'state> {
    state: &'state RefCell<StrictParseState>,
}

impl StrictValueVisitor<'_> {
    fn reject_number<E>(self, number: impl Into<String>) -> Result<Value, E>
    where
        E: de::Error,
    {
        let number = number.into();
        self.state.borrow_mut().violation =
            Some(StrictParseViolation::InvalidNumber(number.clone()));
        Err(E::custom(format!(
            "scene manifest number {number} is not a safe integer"
        )))
    }
}

impl<'de> DeserializeSeed<'de> for StrictValueSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor { state: self.state })
    }
}

impl<'de> Visitor<'de> for StrictValueVisitor<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an I-JSON value containing only safe integer numbers")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if !(-MAX_SAFE_SIGNED_INTEGER..=MAX_SAFE_SIGNED_INTEGER).contains(&value) {
            return self.reject_number(value.to_string());
        }
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value > MAX_SAFE_INTEGER {
            return self.reject_number(value.to_string());
        }
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.reject_number(value.to_string())
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
        while let Some(value) = sequence.next_element_seed(StrictValueSeed { state: self.state })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                self.state.borrow_mut().violation =
                    Some(StrictParseViolation::DuplicateKey(key.clone()));
                return Err(de::Error::custom(format!(
                    "duplicate object member name {key:?}"
                )));
            }
            let value = object.next_value_seed(StrictValueSeed { state: self.state })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

fn hex_quad(bytes: &[u8], start: usize) -> Option<u16> {
    let digits = bytes.get(start..start + 4)?;
    let mut value = 0_u16;
    for digit in digits {
        value = value.checked_mul(16)?;
        value = value.checked_add(match digit {
            b'0'..=b'9' => u16::from(*digit - b'0'),
            b'a'..=b'f' => u16::from(*digit - b'a' + 10),
            b'A'..=b'F' => u16::from(*digit - b'A' + 10),
            _ => return None,
        })?;
    }
    Some(value)
}

fn validate_unicode_escapes(source: &str) -> Result<(), SceneDigestError> {
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut in_string = false;

    while index < bytes.len() {
        if !in_string {
            if bytes[index] == b'"' {
                in_string = true;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            b'"' => {
                in_string = false;
                index += 1;
            }
            b'\\' => {
                if bytes.get(index + 1) != Some(&b'u') {
                    index += 2;
                    continue;
                }

                let Some(code_unit) = hex_quad(bytes, index + 2) else {
                    index += 2;
                    continue;
                };
                if (0xd800..=0xdbff).contains(&code_unit) {
                    let low_start = index + 6;
                    let low = (bytes.get(low_start) == Some(&b'\\')
                        && bytes.get(low_start + 1) == Some(&b'u'))
                    .then(|| hex_quad(bytes, low_start + 2))
                    .flatten();
                    if !low.is_some_and(|value| (0xdc00..=0xdfff).contains(&value)) {
                        return Err(SceneDigestError::new(
                            SceneDigestErrorCode::InvalidUnicode,
                            "scene manifest strings cannot contain unpaired UTF-16 surrogates",
                        ));
                    }
                    index = low_start + 6;
                } else if (0xdc00..=0xdfff).contains(&code_unit) {
                    return Err(SceneDigestError::new(
                        SceneDigestErrorCode::InvalidUnicode,
                        "scene manifest strings cannot contain unpaired UTF-16 surrogates",
                    ));
                } else {
                    index += 6;
                }
            }
            _ => index += 1,
        }
    }

    Ok(())
}

/// Parses raw Scene Manifest JSON while rejecting invalid UTF-8, duplicate member names,
/// invalid Unicode scalar values, floats, and integers outside the I-JSON safe range.
pub fn parse_scene_manifest_json_strict(
    raw_json: impl AsRef<[u8]>,
) -> Result<Value, SceneDigestError> {
    let source = std::str::from_utf8(raw_json.as_ref()).map_err(|error| {
        SceneDigestError::new(
            SceneDigestErrorCode::InvalidUnicode,
            format!("scene manifest JSON must be valid UTF-8: {error}"),
        )
    })?;
    validate_unicode_escapes(source)?;

    let state = RefCell::new(StrictParseState::default());
    let mut deserializer = serde_json::Deserializer::from_str(source);
    let parsed = StrictValueSeed { state: &state }.deserialize(&mut deserializer);
    let value = match parsed {
        Ok(value) => value,
        Err(error) => {
            return Err(match state.into_inner().violation {
                Some(StrictParseViolation::DuplicateKey(key)) => SceneDigestError::new(
                    SceneDigestErrorCode::DuplicateKey,
                    format!("duplicate object member name {key:?}"),
                ),
                Some(StrictParseViolation::InvalidNumber(number)) => SceneDigestError::new(
                    SceneDigestErrorCode::InvalidNumber,
                    format!("scene manifest number {number} is not a safe integer"),
                ),
                None => SceneDigestError::new(
                    SceneDigestErrorCode::InvalidJson,
                    format!("invalid scene manifest JSON: {error}"),
                ),
            });
        }
    };
    deserializer.end().map_err(|error| {
        SceneDigestError::new(
            SceneDigestErrorCode::InvalidJson,
            format!("invalid trailing scene manifest JSON: {error}"),
        )
    })?;
    Ok(value)
}

fn validate_bounded_integer(
    object: &Map<String, Value>,
    field: &str,
    path: &str,
    minimum: i64,
    maximum: i64,
) -> Result<(), SceneDigestError> {
    let Some(Value::Number(number)) = object.get(field) else {
        return Ok(());
    };
    let Some(value) = number.as_i64() else {
        return Err(SceneDigestError::new(
            SceneDigestErrorCode::InvalidNumber,
            format!("{path} is not a supported integer"),
        ));
    };
    if value < minimum || value > maximum {
        return Err(SceneDigestError::new(
            SceneDigestErrorCode::InvalidNumber,
            format!("{path} must be an integer between {minimum} and {maximum}"),
        ));
    }
    Ok(())
}

fn validate_scene_numeric_bounds(manifest: &Map<String, Value>) -> Result<(), SceneDigestError> {
    validate_bounded_integer(manifest, "schema_version", "schema_version", 1, 1)?;
    validate_bounded_integer(
        manifest,
        "revision_number",
        "revision_number",
        1,
        MAX_SAFE_SIGNED_INTEGER,
    )?;

    if let Some(Value::Object(canvas)) = manifest.get("canvas") {
        validate_bounded_integer(canvas, "width", "canvas.width", 1, 16_384)?;
        validate_bounded_integer(canvas, "height", "canvas.height", 1, 16_384)?;
    }
    if let Some(Value::Object(document)) = manifest.get("document") {
        validate_bounded_integer(document, "size", "document.size", 1, 268_435_456)?;
    }
    if let Some(Value::Array(assets)) = manifest.get("assets") {
        for (index, asset) in assets.iter().enumerate() {
            if let Value::Object(asset) = asset {
                validate_bounded_integer(
                    asset,
                    "size",
                    &format!("assets[{index}].size"),
                    1,
                    268_435_456,
                )?;
            }
        }
    }
    if let Some(Value::Object(offline)) = manifest.get("offline") {
        validate_bounded_integer(
            offline,
            "max_stale_seconds",
            "offline.max_stale_seconds",
            0,
            31_536_000,
        )?;
    }
    Ok(())
}

fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn write_canonical_value(value: &Value, output: &mut String) -> Result<(), SceneDigestError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                if !(-MAX_SAFE_SIGNED_INTEGER..=MAX_SAFE_SIGNED_INTEGER).contains(&value) {
                    return Err(SceneDigestError::new(
                        SceneDigestErrorCode::InvalidNumber,
                        format!("scene manifest number {number} is not a safe integer"),
                    ));
                }
                write!(output, "{value}").expect("writing to a String cannot fail");
            } else if let Some(value) = number.as_u64() {
                if value > MAX_SAFE_INTEGER {
                    return Err(SceneDigestError::new(
                        SceneDigestErrorCode::InvalidNumber,
                        format!("scene manifest number {number} is not a safe integer"),
                    ));
                }
                write!(output, "{value}").expect("writing to a String cannot fail");
            } else {
                return Err(SceneDigestError::new(
                    SceneDigestErrorCode::InvalidNumber,
                    format!("scene manifest number {number} is not an integer"),
                ));
            }
        }
        Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .expect("a Rust UTF-8 string is always serializable as JSON"),
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(object) => write_canonical_object(object, output, false)?,
    }
    Ok(())
}

pub(crate) fn canonicalize_safe_integer_value(value: &Value) -> Result<String, SceneDigestError> {
    let mut canonical = String::new();
    write_canonical_value(value, &mut canonical)?;
    Ok(canonical)
}

fn write_canonical_object(
    object: &Map<String, Value>,
    output: &mut String,
    omit_top_level_digest: bool,
) -> Result<(), SceneDigestError> {
    let mut members: Vec<_> = object
        .iter()
        .filter(|(key, _)| !omit_top_level_digest || key.as_str() != "manifest_digest")
        .collect();
    members.sort_by(|(left, _), (right, _)| utf16_order(left, right));

    output.push('{');
    for (index, (key, value)) in members.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(
            &serde_json::to_string(key)
                .expect("a Rust UTF-8 string is always serializable as JSON"),
        );
        output.push(':');
        write_canonical_value(value, output)?;
    }
    output.push('}');
    Ok(())
}

fn canonicalize_parsed_manifest(value: &Value) -> Result<String, SceneDigestError> {
    let manifest = value.as_object().ok_or_else(|| {
        SceneDigestError::new(
            SceneDigestErrorCode::InvalidManifest,
            "a Scene Manifest v1 value must be a JSON object",
        )
    })?;
    validate_scene_numeric_bounds(manifest)?;

    let mut canonical = String::new();
    write_canonical_object(manifest, &mut canonical, true)?;
    Ok(canonical)
}

fn digest_parsed_manifest(value: &Value) -> Result<String, SceneDigestError> {
    let canonical = canonicalize_parsed_manifest(value)?;
    let hash = Sha256::digest(canonical.as_bytes());
    let mut digest = String::with_capacity(SHA256_PREFIX.len() + 64);
    digest.push_str(SHA256_PREFIX);
    for byte in hash {
        write!(&mut digest, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(digest)
}

fn has_canonical_digest_syntax(value: &str) -> bool {
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Canonicalizes the Scene Manifest v1 digest payload using RFC 8785 object/string/array
/// rules and the scene schema's safe-integer-only numeric subset.
pub fn canonicalize_scene_manifest_v1(
    raw_json: impl AsRef<[u8]>,
) -> Result<String, SceneDigestError> {
    canonicalize_parsed_manifest(&parse_scene_manifest_json_strict(raw_json)?)
}

pub fn compute_scene_manifest_digest_v1(
    raw_json: impl AsRef<[u8]>,
) -> Result<String, SceneDigestError> {
    digest_parsed_manifest(&parse_scene_manifest_json_strict(raw_json)?)
}

/// Strictly parses and verifies a raw Scene Manifest v1 JSON payload. JSON Schema and
/// cross-field semantic validation remain separate required checks after this succeeds.
pub fn verify_scene_manifest_digest_v1(
    raw_json: impl AsRef<[u8]>,
) -> Result<Value, SceneDigestError> {
    let manifest = parse_scene_manifest_json_strict(raw_json)?;
    let object = manifest.as_object().ok_or_else(|| {
        SceneDigestError::new(
            SceneDigestErrorCode::InvalidManifest,
            "a Scene Manifest v1 value must be a JSON object",
        )
    })?;
    let supplied = object
        .get("manifest_digest")
        .ok_or_else(|| {
            SceneDigestError::new(
                SceneDigestErrorCode::MissingDigest,
                "scene manifest is missing top-level manifest_digest",
            )
        })?
        .as_str()
        .ok_or_else(|| {
            SceneDigestError::new(
                SceneDigestErrorCode::InvalidDigest,
                "scene manifest_digest must be a string",
            )
        })?
        .to_owned();
    if !has_canonical_digest_syntax(&supplied) {
        return Err(SceneDigestError::new(
            SceneDigestErrorCode::InvalidDigest,
            "scene manifest_digest must use lowercase sha256:<64 lowercase hex characters>",
        ));
    }

    let computed = digest_parsed_manifest(&manifest)?;
    if supplied != computed {
        return Err(SceneDigestError::new(
            SceneDigestErrorCode::DigestMismatch,
            format!("scene manifest digest mismatch: supplied {supplied}, computed {computed}"),
        ));
    }
    Ok(manifest)
}
