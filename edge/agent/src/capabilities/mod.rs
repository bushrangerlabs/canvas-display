//! Real hardware/OS capability detection and per-domain application-state reporting.
//!
//! `session::state::EdgeSession::create_hello` currently hardcodes a fixed, fake
//! `EdgeCapabilities` value, and its `report_applied_state` helper `applied_domain` unconditionally
//! reports `DomainApplicationStatus::Applied` for every domain present in desired state --
//! neither is backed by real hardware/OS inspection. This module provides the real detection logic
//! and pure data model that a **future, separate integration task** should wire into those two call
//! sites (see [`detect`] and [`domain`] module docs for exactly how). Wiring that in is explicitly
//! out of scope for the work that introduced this module.
//!
//! Two independent pieces live here:
//!
//! - [`detect`]: real, best-effort OS/hardware capability probing
//!   ([`CapabilityDetector`]/[`SystemCapabilityProbe`]), to replace the hardcoded
//!   `EdgeCapabilities` value in `create_hello`.
//! - [`domain`]: a pure per-domain application-state model ([`DomainOutcome`]) and its conversion
//!   into the generated `DomainApplication` wire type ([`to_domain_application`]), to replace the
//!   always-`Applied` `applied_domain` helper in `report_applied_state`.
//!
//! Both follow the injectable-dependency-for-testability convention already established by
//! `ipc::peer::PeerCredentialSource` (`SoPeercredSource` / `FakePeerCredentialSource`): production
//! code gets a real implementation that touches the real OS, and tests get a fake/injectable one
//! that returns canned results, so this module's test suite (`tests/capabilities_v1.rs`) never
//! depends on the actual hardware/OS state of whatever machine happens to run `cargo test`.
//!
//! See `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` Phase 1 checklist item "Report
//! renderer/hardware capabilities and per-domain application state."

mod detect;
mod domain;

pub use detect::{
    CapabilityDetector, FakeSystemCapabilityProbe, RealSystemCapabilityProbe,
    SystemCapabilityProbe, HARDWARE_BRIGHTNESS, HARDWARE_DPMS, MEDIA_MPV, MEDIA_YOUTUBE_IFRAME,
    RENDERER_CANVAS_SCENE_V1, VOICE_OPUS_WSS, VOICE_WAKEWORD_LOCAL,
};
pub use domain::{to_domain_application, Domain, DomainOutcome};
