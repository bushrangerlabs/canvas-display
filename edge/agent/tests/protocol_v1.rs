use canvas_edge_agent::protocol::{DeviceV1ControlMessage, DiagnosticsEchoCommandIssue};
use canvas_edge_agent::reducer::{EchoCommandDecision, EchoExecutor, InMemoryCommandReducer};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct FixtureManifest {
    fixtures: Vec<FixtureEntry>,
}

#[derive(Debug, Deserialize)]
struct FixtureEntry {
    path: String,
    valid: bool,
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("agent crate must live under the repository root")
}

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("fixture must be readable"))
        .expect("fixture must contain JSON")
}

fn echo_command_fixture() -> DiagnosticsEchoCommandIssue {
    let value =
        read_json(repository_root().join("contracts/device/v1/fixtures/valid/command-issue.json"));
    match serde_json::from_value::<DeviceV1ControlMessage>(value)
        .expect("valid command fixture must deserialize")
    {
        DeviceV1ControlMessage::DiagnosticsEchoCommandIssue(command) => command,
        other => panic!("expected diagnostics echo command, got {other:?}"),
    }
}

#[test]
fn shared_fixtures_match_schema_and_valid_messages_deserialize() {
    let root = repository_root();
    let schema = read_json(root.join("contracts/device/v1/control-message.schema.json"));
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .expect("canonical schema must compile");
    let manifest: FixtureManifest = serde_json::from_value(read_json(
        root.join("contracts/device/v1/fixtures/manifest.json"),
    ))
    .expect("fixture manifest must deserialize");

    for fixture in manifest.fixtures {
        let value = read_json(root.join(&fixture.path));
        assert_eq!(
            validator.is_valid(&value),
            fixture.valid,
            "fixture validity mismatch: {}",
            fixture.path
        );

        if fixture.valid {
            serde_json::from_value::<DeviceV1ControlMessage>(value).unwrap_or_else(|error| {
                panic!("generated Rust type rejected {}: {error}", fixture.path)
            });
        }
    }
}

#[derive(Default)]
struct CountingEchoExecutor {
    calls: usize,
}

impl EchoExecutor for CountingEchoExecutor {
    type Error = String;

    fn execute(&mut self, message: &str) -> Result<String, Self::Error> {
        self.calls += 1;
        Ok(message.to_owned())
    }
}

#[test]
fn replay_safe_command_executes_once_and_rejects_digest_conflict() {
    let command = echo_command_fixture();
    let mut reducer = InMemoryCommandReducer::default();
    let mut executor = CountingEchoExecutor::default();

    let first = reducer
        .handle_echo(command.clone(), &mut executor)
        .expect("first execution must succeed");
    assert_eq!(
        first,
        EchoCommandDecision::Executed {
            echoed: "hello edge".to_owned()
        }
    );
    assert_eq!(executor.calls, 1);

    let replay = reducer
        .handle_echo(command, &mut executor)
        .expect("replay must return the stored result");
    assert_eq!(
        replay,
        EchoCommandDecision::Replayed {
            echoed: "hello edge".to_owned()
        }
    );
    assert_eq!(executor.calls, 1);

    let mut conflict_value =
        read_json(repository_root().join("contracts/device/v1/fixtures/valid/command-issue.json"));
    conflict_value["payload"]["request_digest"] = Value::String(
        "sha256:28bede070c136713d1410189d7ce119fbc8f4a63cdab872894f5f6dd9b4eb52b".to_owned(),
    );
    let conflict = match serde_json::from_value::<DeviceV1ControlMessage>(conflict_value)
        .expect("conflict command remains structurally valid")
    {
        DeviceV1ControlMessage::DiagnosticsEchoCommandIssue(command) => command,
        other => panic!("expected diagnostics echo command, got {other:?}"),
    };

    let decision = reducer
        .handle_echo(conflict, &mut executor)
        .expect("digest conflict is a protocol decision, not an executor error");
    assert_eq!(
        decision,
        EchoCommandDecision::IdempotencyConflict {
            existing_digest:
                "sha256:14936abe504f227d7748780024d679125eadb53c069397bcd5f61fca698c1c4f".to_owned(),
            received_digest:
                "sha256:28bede070c136713d1410189d7ce119fbc8f4a63cdab872894f5f6dd9b4eb52b".to_owned(),
        }
    );
    assert_eq!(executor.calls, 1);
}
