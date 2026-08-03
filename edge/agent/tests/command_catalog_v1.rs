use canvas_edge_agent::command::{
    canonicalize_command_request_v1, compute_command_request_digest_v1,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const BASELINE_DIGEST: &str =
    "sha256:14936abe504f227d7748780024d679125eadb53c069397bcd5f61fca698c1c4f";
const CONFLICT_DIGEST: &str =
    "sha256:28bede070c136713d1410189d7ce119fbc8f4a63cdab872894f5f6dd9b4eb52b";

#[derive(Debug, Deserialize)]
struct DigestVectors {
    schema_version: u8,
    profile: String,
    valid: Vec<DigestVector>,
    invalid: Vec<InvalidDigestVector>,
}

#[derive(Debug, Deserialize)]
struct DigestVector {
    name: String,
    file: String,
    expected_digest: String,
}

#[derive(Debug, Deserialize)]
struct InvalidDigestVector {
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

fn digest_fixture_directory() -> PathBuf {
    repository_root().join("contracts/command/v1/fixtures/request-digest")
}

fn read_value(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).expect("JSON fixture must be readable"))
        .expect("fixture must be valid JSON")
}

fn vectors() -> DigestVectors {
    serde_json::from_value(read_value(digest_fixture_directory().join("vectors.json")))
        .expect("request digest vector manifest must deserialize")
}

fn vector_bytes(file: &str) -> Vec<u8> {
    fs::read(digest_fixture_directory().join(file)).expect("request digest vector must be readable")
}

#[test]
fn shared_request_digest_vectors_match_rust_and_reject_invalid_raw_inputs() {
    let vectors = vectors();
    assert_eq!(vectors.schema_version, 1);
    assert_eq!(vectors.profile, "canvas.command.request/v1");

    for vector in &vectors.valid {
        assert_eq!(
            compute_command_request_digest_v1(vector_bytes(&vector.file))
                .unwrap_or_else(|error| panic!("{} failed to digest: {error}", vector.name)),
            vector.expected_digest,
            "{}",
            vector.name
        );
    }

    let baseline = vectors
        .valid
        .iter()
        .find(|vector| vector.name == "diagnostics-echo")
        .expect("baseline vector must exist");
    let reordered = vectors
        .valid
        .iter()
        .find(|vector| vector.name == "key-order-and-whitespace-invariance")
        .expect("reordered vector must exist");
    assert_eq!(baseline.expected_digest, reordered.expected_digest);
    assert_eq!(
        canonicalize_command_request_v1(vector_bytes(&baseline.file)).unwrap(),
        canonicalize_command_request_v1(vector_bytes(&reordered.file)).unwrap()
    );

    let array_ab = vectors
        .valid
        .iter()
        .find(|vector| vector.name == "array-order-a-b")
        .unwrap();
    let array_ba = vectors
        .valid
        .iter()
        .find(|vector| vector.name == "array-order-b-a")
        .unwrap();
    assert_ne!(array_ab.expected_digest, array_ba.expected_digest);

    for vector in vectors.invalid {
        let error = compute_command_request_digest_v1(vector_bytes(&vector.file))
            .expect_err("invalid vector must fail closed");
        assert_eq!(
            error.code().as_str(),
            vector.expected_error,
            "{}",
            vector.name
        );
    }
}

#[test]
fn capability_and_command_catalogs_are_closed_consistent_linux_registries() {
    let root = repository_root();
    let registry = read_value(root.join("contracts/device/v1/capability-registry.json"));
    assert_eq!(registry["schema_version"], 1);
    assert_eq!(registry["platform"], "linux");
    assert_eq!(
        registry["architectures"],
        serde_json::json!(["amd64", "arm64"])
    );

    let categories = registry["categories"]
        .as_object()
        .expect("capability categories must be an object");
    assert_eq!(categories.len(), 4);
    let mut capabilities = HashSet::new();
    for (category, entries) in categories {
        let entries = entries
            .as_array()
            .expect("capability category must be an array");
        let mut category_tokens = HashSet::new();
        for entry in entries {
            let token = entry["token"]
                .as_str()
                .expect("capability token must be a string");
            assert!(
                category_tokens.insert(token.to_owned()),
                "duplicate {category}:{token}"
            );
            capabilities.insert(format!("{category}:{token}"));
        }
    }

    let catalog = read_value(root.join("contracts/command/v1/command-catalog.json"));
    assert_eq!(catalog["schema_version"], 1);
    assert_eq!(catalog["digest_profile"], "canvas.command.request/v1");
    let classes = catalog["execution_classes"]
        .as_object()
        .expect("execution classes must be an object");
    let commands = catalog["commands"]
        .as_array()
        .expect("commands must be an array");
    let mut identities = HashSet::new();
    let mut active = Vec::new();
    for command in commands {
        let kind = command["kind"]
            .as_str()
            .expect("command kind must be a string");
        let version = command["semantic_version"]
            .as_u64()
            .expect("semantic version must be an integer");
        assert!(
            identities.insert(format!("{kind}@{version}")),
            "duplicate command identity"
        );
        let execution_class = command["execution_class"]
            .as_str()
            .expect("execution class must be a string");
        assert!(classes.contains_key(execution_class));
        assert_ne!(execution_class, "externally_idempotent");

        if command["wire_status"] == "active_vertical_slice" {
            active.push(kind);
        }
        if let Some(required) = command["required_capability"].as_object() {
            let reference = format!(
                "{}:{}",
                required["category"].as_str().unwrap(),
                required["token"].as_str().unwrap()
            );
            assert!(
                capabilities.contains(&reference),
                "unknown capability {reference}"
            );
        }
    }
    assert_eq!(active, vec!["diagnostics.echo"]);

    let kinds: HashSet<_> = commands
        .iter()
        .map(|command| command["kind"].as_str().unwrap())
        .collect();
    for desired in catalog["desired_state_not_commands"].as_array().unwrap() {
        assert!(!kinds.contains(desired.as_str().unwrap()));
    }
}

#[test]
fn device_command_lifecycle_fixtures_use_real_canonical_request_digests() {
    let root = repository_root();
    let issue = read_value(root.join("contracts/device/v1/fixtures/valid/command-issue.json"));
    assert_eq!(issue["payload"]["request_digest"], BASELINE_DIGEST);

    let request = serde_json::json!({
        "kind": issue["payload"]["kind"],
        "semantic_version": issue["payload_version"],
        "parameters": issue["payload"]["parameters"],
        "preconditions": {}
    });
    assert_eq!(
        compute_command_request_digest_v1(serde_json::to_vec(&request).unwrap()).unwrap(),
        BASELINE_DIGEST
    );

    for file in ["command-received.json", "command-completed.json"] {
        let value = read_value(root.join("contracts/device/v1/fixtures/valid").join(file));
        assert_eq!(
            value["payload"]["request_digest"], BASELINE_DIGEST,
            "{file}"
        );
    }
    let rejected =
        read_value(root.join("contracts/device/v1/fixtures/valid/command-rejected.json"));
    assert_eq!(rejected["payload"]["request_digest"], CONFLICT_DIGEST);
}
