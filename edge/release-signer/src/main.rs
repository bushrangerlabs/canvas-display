//! CLI tool for signing release manifests for the Canvas Edge Agent.
//!
//! Usage:
//!
//!   # Generate a dev signing key (prints hex-encoded private key to stdout)
//!   canvas-edge-release-signer generate-key
//!
//!   # Sign a release manifest from a JSON file, outputting signed manifest + detached signature
//!   canvas-edge-release-signer sign \
//!     --manifest manifest.json \
//!     --key <hex-private-key> \
//!     --output-signed signed-manifest.json \
//!     --output-sig manifest.sig
//!
//!   # Verify a signed manifest
//!   canvas-edge-release-signer verify \
//!     --signed signed-manifest.json \
//!     --trust-root <hex-public-key>
//!
//! The signing key should be set via RELEASE_SIGNING_KEY env var in CI, or
//! generated fresh for development. Per ADR 0008, the release signing private
//! key is offline or isolated in CI.

use std::fs;
use std::path::PathBuf;
use std::process;

use canvas_edge_updater::manifest::{ReleaseManifest, ReleaseTrustRoot, SignedReleaseManifest};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: canvas-edge-release-signer <command> [options]");
        eprintln!();
        eprintln!("Commands:");
        eprintln!("  generate-key                    Generate a new Ed25519 signing key");
        eprintln!(
            "  sign --manifest <file> --key <hex> [--output-signed <file>] [--output-sig <file>]"
        );
        eprintln!("  verify --signed <file> --trust-root <hex>");
        process::exit(1);
    }

    match args[1].as_str() {
        "generate-key" => cmd_generate_key(),
        "sign" => cmd_sign(&args[1..]),
        "verify" => cmd_verify(&args[1..]),
        other => {
            eprintln!("Unknown command: {other}");
            process::exit(1);
        }
    }
}

fn cmd_generate_key() {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key: VerifyingKey = signing_key.verifying_key();

    eprintln!("# Ed25519 release signing key pair");
    eprintln!("# SECRET KEY — keep offline or in CI secrets, never commit");
    eprintln!(
        "RELEASE_SIGNING_KEY={}",
        hex::encode(signing_key.to_bytes().as_slice())
    );
    eprintln!(
        "RELEASE_TRUST_ROOT={}",
        hex::encode(verifying_key.to_bytes().as_slice())
    );
}

fn cmd_sign(args: &[String]) {
    let mut manifest_path: Option<PathBuf> = None;
    let mut key_hex: Option<String> = None;
    let mut output_signed: Option<PathBuf> = None;
    let mut output_sig: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--manifest" => {
                i += 1;
                manifest_path = Some(PathBuf::from(&args[i]));
            }
            "--key" => {
                i += 1;
                key_hex = Some(args[i].clone());
            }
            "--output-signed" => {
                i += 1;
                output_signed = Some(PathBuf::from(&args[i]));
            }
            "--output-sig" => {
                i += 1;
                output_sig = Some(PathBuf::from(&args[i]));
            }
            _ => {}
        }
        i += 1;
    }

    let manifest_path = manifest_path.unwrap_or_else(|| {
        eprintln!("Error: --manifest <file> is required");
        process::exit(1);
    });

    let key_hex = key_hex.unwrap_or_else(|| {
        eprintln!("Error: --key <hex> is required");
        process::exit(1);
    });

    let key_bytes = hex::decode(&key_hex).unwrap_or_else(|e| {
        eprintln!("Error: invalid hex key: {e}");
        process::exit(1);
    });
    let key_array: [u8; 32] = key_bytes.as_slice().try_into().unwrap_or_else(|_| {
        eprintln!("Error: key must be exactly 32 bytes (64 hex chars)");
        process::exit(1);
    });
    let signing_key = SigningKey::from_bytes(&key_array);

    let manifest_json = fs::read_to_string(&manifest_path).unwrap_or_else(|e| {
        eprintln!(
            "Error reading manifest file {}: {e}",
            manifest_path.display()
        );
        process::exit(1);
    });
    let manifest: ReleaseManifest = serde_json::from_str(&manifest_json).unwrap_or_else(|e| {
        eprintln!("Error parsing manifest JSON: {e}");
        process::exit(1);
    });

    let signed = SignedReleaseManifest::sign(manifest, &signing_key);

    let signed_json = serde_json::to_string_pretty(&signed).unwrap_or_else(|e| {
        eprintln!("Error serializing signed manifest: {e}");
        process::exit(1);
    });

    let out_signed = output_signed.unwrap_or_else(|| PathBuf::from("signed-manifest.json"));
    fs::write(&out_signed, &signed_json).unwrap_or_else(|e| {
        eprintln!("Error writing {}: {e}", out_signed.display());
        process::exit(1);
    });
    eprintln!("✓ Signed manifest written to {}", out_signed.display());

    // Also write the detached signature file
    if let Some(sig_path) = output_sig {
        fs::write(&sig_path, signed.signature_hex()).unwrap_or_else(|e| {
            eprintln!("Error writing {}: {e}", sig_path.display());
            process::exit(1);
        });
        eprintln!("✓ Detached signature written to {}", sig_path.display());
    }
}

fn cmd_verify(args: &[String]) {
    let mut signed_path: Option<PathBuf> = None;
    let mut trust_root_hex: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--signed" => {
                i += 1;
                signed_path = Some(PathBuf::from(&args[i]));
            }
            "--trust-root" => {
                i += 1;
                trust_root_hex = Some(args[i].clone());
            }
            _ => {}
        }
        i += 1;
    }

    let signed_path = signed_path.unwrap_or_else(|| {
        eprintln!("Error: --signed <file> is required");
        process::exit(1);
    });

    let trust_root_hex = trust_root_hex.unwrap_or_else(|| {
        eprintln!("Error: --trust-root <hex> is required");
        process::exit(1);
    });

    let trust_root_bytes = hex::decode(&trust_root_hex).unwrap_or_else(|e| {
        eprintln!("Error: invalid hex trust root: {e}");
        process::exit(1);
    });
    let trust_root_array: [u8; 32] = trust_root_bytes.as_slice().try_into().unwrap_or_else(|_| {
        eprintln!("Error: trust root must be exactly 32 bytes (64 hex chars)");
        process::exit(1);
    });
    let trust_root =
        ReleaseTrustRoot::from_public_key_bytes(&trust_root_array).unwrap_or_else(|e| {
            eprintln!("Error: invalid Ed25519 public key: {e}");
            process::exit(1);
        });

    let signed_json = fs::read_to_string(&signed_path).unwrap_or_else(|e| {
        eprintln!("Error reading {}: {e}", signed_path.display());
        process::exit(1);
    });
    let signed: SignedReleaseManifest = serde_json::from_str(&signed_json).unwrap_or_else(|e| {
        eprintln!("Error parsing signed manifest: {e}");
        process::exit(1);
    });

    match signed.verify(&trust_root) {
        Ok(manifest) => {
            eprintln!("✓ Signature VERIFIED");
            eprintln!("  Product:     {}", manifest.product);
            eprintln!("  Version:     {}", manifest.version);
            eprintln!("  Arch:        {:?}", manifest.architecture);
            eprintln!("  Security:    {}", manifest.security_counter);
            eprintln!(
                "  Protocol:    {}-{}",
                manifest.protocol_min, manifest.protocol_max
            );
            eprintln!(
                "  Schema:      {}-{}",
                manifest.schema_min, manifest.schema_max
            );
            println!("{}", serde_json::to_string_pretty(manifest).unwrap());
        }
        Err(e) => {
            eprintln!("✗ Signature INVALID: {e}");
            process::exit(1);
        }
    }
}

/// Minimal hex encoding/decoding to avoid adding the `hex` crate as a dependency.
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        let mut hex = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            hex.push_str(&format!("{byte:02x}"));
        }
        hex
    }

    pub fn decode(hex_str: &str) -> Result<Vec<u8>, String> {
        if hex_str.len() % 2 != 0 {
            return Err("odd hex string length".into());
        }
        let bytes = hex_str.as_bytes();
        let mut out = Vec::with_capacity(bytes.len() / 2);
        for pair in bytes.chunks(2) {
            let byte_str = std::str::from_utf8(pair).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(byte_str, 16).map_err(|e| e.to_string())?);
        }
        Ok(out)
    }
}
