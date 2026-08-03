use canvas_edge_agent::scene::{
    canonicalize_scene_manifest_v1, compute_scene_manifest_digest_v1,
    validate_scene_manifest_semantics, verify_scene_manifest_digest_v1, SceneDigestErrorCode,
};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

const BASIC_DIGEST: &str =
    "sha256:b55c6f69f62c6116bfb9e70fc13304162ef8aca655fa94bbfe88fb13527bd390";

#[derive(Debug, Deserialize)]
struct SharedVectors {
    schema_version: u8,
    valid: Vec<DigestVector>,
    mismatch: Vec<DigestVector>,
    invalid: Vec<InvalidVector>,
}

#[derive(Debug, Deserialize)]
struct DigestVector {
    name: String,
    file: String,
    expected_digest: String,
    expected_canonical: Option<String>,
    expected_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InvalidVector {
    name: String,
    file: String,
    expected_error: String,
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("agent crate must live under the repository root")
}

fn canonicalization_directory() -> PathBuf {
    repository_root().join("contracts/scene/v1/fixtures/canonicalization")
}

fn shared_vectors() -> SharedVectors {
    serde_json::from_slice(
        &fs::read(canonicalization_directory().join("vectors.json"))
            .expect("shared digest vector index must be readable"),
    )
    .expect("shared digest vector index must be valid JSON")
}

fn vector_bytes(file: &str) -> Vec<u8> {
    fs::read(canonicalization_directory().join(file)).expect("digest vector must be readable")
}

#[test]
fn existing_valid_basic_scene_has_its_frozen_digest() {
    let raw =
        fs::read(repository_root().join("contracts/scene/v1/fixtures/valid/basic-scene.json"))
            .expect("basic scene fixture must be readable");

    assert_eq!(
        compute_scene_manifest_digest_v1(&raw).expect("basic scene must canonicalize"),
        BASIC_DIGEST
    );
    let verified = verify_scene_manifest_digest_v1(&raw).expect("basic scene digest must verify");
    assert_eq!(verified["manifest_digest"], BASIC_DIGEST);
    validate_scene_manifest_semantics(&verified).expect("basic scene semantics must remain valid");
}

#[test]
fn shared_valid_vectors_canonicalize_and_verify() {
    let vectors = shared_vectors();
    assert_eq!(vectors.schema_version, 1);

    for vector in &vectors.valid {
        let raw = vector_bytes(&vector.file);
        assert_eq!(
            compute_scene_manifest_digest_v1(&raw)
                .unwrap_or_else(|error| panic!("{} failed to digest: {error}", vector.name)),
            vector.expected_digest,
            "{}",
            vector.name
        );
        let verified = verify_scene_manifest_digest_v1(&raw)
            .unwrap_or_else(|error| panic!("{} failed to verify: {error}", vector.name));
        assert_eq!(verified["manifest_digest"], vector.expected_digest);
        if let Some(expected) = &vector.expected_canonical {
            assert_eq!(
                canonicalize_scene_manifest_v1(&raw).unwrap_or_else(|error| panic!(
                    "{} failed to canonicalize: {error}",
                    vector.name
                )),
                *expected,
                "{}",
                vector.name
            );
        }
    }

    let reordered = vectors
        .valid
        .iter()
        .find(|vector| vector.name == "key-order-and-whitespace-invariance")
        .expect("key-order vector must be present");
    let basic =
        fs::read(repository_root().join("contracts/scene/v1/fixtures/valid/basic-scene.json"))
            .expect("basic scene fixture must be readable");
    assert_eq!(
        canonicalize_scene_manifest_v1(vector_bytes(&reordered.file)).unwrap(),
        canonicalize_scene_manifest_v1(basic).unwrap()
    );

    let unicode = vectors
        .valid
        .iter()
        .find(|vector| vector.name == "unicode-string-handling")
        .expect("Unicode vector must be present");
    let canonical = canonicalize_scene_manifest_v1(vector_bytes(&unicode.file)).unwrap();
    assert!(canonical.contains("夜空 🌌 — café"));
    assert!(canonical.contains(r"line\ncontrol:\u000f"));
}

#[test]
fn array_reordering_and_field_mutation_reject_stale_digests() {
    for vector in shared_vectors().mismatch {
        let raw = vector_bytes(&vector.file);
        assert_eq!(
            compute_scene_manifest_digest_v1(&raw).unwrap(),
            vector.expected_digest,
            "{}",
            vector.name
        );
        assert_ne!(vector.expected_digest, BASIC_DIGEST, "{}", vector.name);
        let error = verify_scene_manifest_digest_v1(&raw)
            .expect_err("a stale embedded digest must not verify");
        assert_eq!(
            error.code().as_str(),
            vector
                .expected_error
                .as_deref()
                .unwrap_or("digest_mismatch"),
            "{}",
            vector.name
        );
    }
}

#[test]
fn shared_invalid_raw_inputs_fail_before_digest_comparison() {
    for vector in shared_vectors().invalid {
        let error = compute_scene_manifest_digest_v1(vector_bytes(&vector.file))
            .expect_err("invalid raw input must not canonicalize");
        assert_eq!(
            error.code().as_str(),
            vector.expected_error,
            "{}",
            vector.name
        );
    }
}

#[test]
fn strict_parser_rejects_invalid_utf8_and_escape_equivalent_duplicate_keys() {
    let invalid_utf8 = b"{\"x\":\"\xff\"}";
    let error =
        compute_scene_manifest_digest_v1(invalid_utf8).expect_err("invalid UTF-8 must be rejected");
    assert_eq!(error.code(), SceneDigestErrorCode::InvalidUnicode);

    let duplicate = br#"{
        "manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "a":1,
        "\u0061":2
    }"#;
    let error = compute_scene_manifest_digest_v1(duplicate)
        .expect_err("escape-equivalent duplicate names must be rejected");
    assert_eq!(error.code(), SceneDigestErrorCode::DuplicateKey);
}

#[test]
fn verification_requires_the_lowercase_sha256_digest_encoding() {
    let basic = fs::read_to_string(
        repository_root().join("contracts/scene/v1/fixtures/valid/basic-scene.json"),
    )
    .expect("basic scene fixture must be readable");
    let uppercase_digest = basic.replace(BASIC_DIGEST, &BASIC_DIGEST.to_uppercase());
    let error = verify_scene_manifest_digest_v1(uppercase_digest)
        .expect_err("uppercase digest encoding must be rejected");
    assert_eq!(error.code(), SceneDigestErrorCode::InvalidDigest);
}

#[test]
fn object_keys_use_rfc_8785_utf16_code_unit_ordering() {
    let raw = br#"{
        "manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "\uE000":1,
        "\uD83D\uDE00":2
    }"#;
    assert_eq!(
        canonicalize_scene_manifest_v1(raw).unwrap(),
        "{\"😀\":2,\"\":1}"
    );
}
