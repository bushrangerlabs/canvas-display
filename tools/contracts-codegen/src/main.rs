use schemars::schema::RootSchema;
use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use typify::{TypeSpace, TypeSpaceSettings};

struct ContractTarget {
    schema: &'static str,
    output: &'static str,
}

const CONTRACTS: &[ContractTarget] = &[
    ContractTarget {
        schema: "contracts/device/v1/control-message.schema.json",
        output: "edge/agent/src/protocol/generated.rs",
    },
    ContractTarget {
        schema: "contracts/scene/v1/scene-manifest.schema.json",
        output: "edge/agent/src/scene/generated.rs",
    },
];

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("contracts code generator must live under the repository root")
}

fn generate(schema_path: &Path, source: &str) -> Result<String, Box<dyn Error>> {
    let schema_text = fs::read_to_string(schema_path)?;
    let schema: RootSchema = serde_json::from_str(&schema_text)?;
    let settings = TypeSpaceSettings::default();
    let mut type_space = TypeSpace::new(&settings);
    type_space.add_root_schema(schema)?;

    let syntax: syn::File = syn::parse2(type_space.to_stream())?;
    let body = prettyplease::unparse(&syntax);
    Ok(format!(
        "// GENERATED FILE — DO NOT EDIT.\n// Source: {source}\n// Regenerate with: npm run contracts:generate:rust\n\n{body}"
    ))
}

fn main() -> Result<(), Box<dyn Error>> {
    let mode = env::args()
        .nth(1)
        .ok_or("usage: canvas-contracts-codegen --write|--check")?;
    if mode != "--write" && mode != "--check" {
        return Err("usage: canvas-contracts-codegen --write|--check".into());
    }

    let root = repository_root();

    for contract in CONTRACTS {
        let schema_path = root.join(contract.schema);
        let output_path = root.join(contract.output);
        let generated = generate(&schema_path, contract.schema)?;

        if mode == "--write" {
            let output_directory = output_path
                .parent()
                .ok_or("generated contract output must have a parent directory")?;
            fs::create_dir_all(output_directory)?;
            fs::write(&output_path, generated)?;
            println!("Generated {}.", contract.output);
            continue;
        }

        let existing = fs::read_to_string(&output_path).map_err(|_| {
            format!(
                "{} is missing; run npm run contracts:generate:rust",
                contract.output
            )
        })?;
        if existing != generated {
            return Err(format!(
                "{} is stale; run npm run contracts:generate:rust",
                contract.output
            )
            .into());
        }
    }

    if mode == "--check" {
        println!("Generated Rust contracts are current.");
    }
    Ok(())
}
