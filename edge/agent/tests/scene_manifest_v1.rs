use canvas_edge_agent::scene::{
    validate_scene_manifest_semantics, SceneManifestV1, MAX_SCENE_OBJECT_BYTES,
    MAX_SCENE_TOTAL_BYTES,
};
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
    schema_valid: Option<bool>,
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

#[test]
fn shared_scene_fixtures_match_schema_semantics_and_generated_type() {
    let root = repository_root();
    let schema = read_json(root.join("contracts/scene/v1/scene-manifest.schema.json"));
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .expect("canonical scene schema must compile");
    let manifest: FixtureManifest = serde_json::from_value(read_json(
        root.join("contracts/scene/v1/fixtures/manifest.json"),
    ))
    .expect("scene fixture manifest must deserialize");

    let mut semantic_negative_count = 0;

    for fixture in manifest.fixtures {
        let value = read_json(root.join(&fixture.path));
        let schema_valid = validator.is_valid(&value);
        let expected_schema_valid = fixture.schema_valid.unwrap_or(fixture.valid);
        assert_eq!(
            schema_valid, expected_schema_valid,
            "schema validity mismatch: {}",
            fixture.path
        );

        let semantic_error = schema_valid
            .then(|| validate_scene_manifest_semantics(&value).err())
            .flatten();
        let contract_valid = schema_valid && semantic_error.is_none();
        assert_eq!(
            contract_valid, fixture.valid,
            "contract validity mismatch for {}: {:?}",
            fixture.path, semantic_error
        );

        if expected_schema_valid && !fixture.valid {
            semantic_negative_count += 1;
        }

        if fixture.valid {
            serde_json::from_value::<SceneManifestV1>(value).unwrap_or_else(|error| {
                panic!(
                    "generated Rust scene type rejected {}: {error}",
                    fixture.path
                )
            });
        }
    }

    assert!(
        semantic_negative_count >= 3,
        "fixtures must cover cross-field path, hash, and aggregate-size rules"
    );
}

#[test]
fn scene_size_limits_are_frozen_for_edge_validation() {
    assert_eq!(MAX_SCENE_OBJECT_BYTES, 268_435_456);
    assert_eq!(MAX_SCENE_TOTAL_BYTES, 1_073_741_824);
}
