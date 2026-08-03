//! Unit tests for `canvas_edge_agent::transport::next_delay` (ADR 0009's exponential backoff with
//! jitter). Pure and deterministic -- no `tokio` runtime needed, `jitter_sample` is injected
//! directly rather than sampled from `rand`.

use std::time::Duration;

use canvas_edge_agent::transport::{next_delay, BackoffConfig};

fn config() -> BackoffConfig {
    BackoffConfig {
        base: Duration::from_secs(1),
        max: Duration::from_secs(60),
        jitter_fraction: 0.2,
    }
}

#[test]
fn first_attempt_is_base_delay_with_no_jitter_at_sample_half() {
    // jitter_sample = 0.5 maps to zero offset (the midpoint of the -range..+range mapping).
    let delay = next_delay(config(), 1, 0.5);
    assert_eq!(delay, Duration::from_secs(1));
}

#[test]
fn delay_doubles_each_attempt_before_hitting_the_cap() {
    let c = config();
    assert_eq!(next_delay(c, 1, 0.5), Duration::from_secs(1));
    assert_eq!(next_delay(c, 2, 0.5), Duration::from_secs(2));
    assert_eq!(next_delay(c, 3, 0.5), Duration::from_secs(4));
    assert_eq!(next_delay(c, 4, 0.5), Duration::from_secs(8));
}

#[test]
fn delay_never_exceeds_the_configured_maximum_even_at_high_attempt_counts() {
    let c = config();
    for attempt in [5, 10, 20, 100] {
        let delay = next_delay(c, attempt, 0.5);
        assert!(
            delay <= c.max,
            "attempt {attempt} produced {delay:?}, exceeding max {:?}",
            c.max
        );
    }
}

#[test]
fn jitter_sample_of_zero_and_one_bound_the_delay_within_the_configured_fraction() {
    let c = config();
    // At attempt 3 the unjittered delay is 4s; jitter_fraction 0.2 means +/-0.8s.
    let low = next_delay(c, 3, 0.0);
    let high = next_delay(c, 3, 1.0);
    assert_eq!(low, Duration::from_millis(3200));
    assert_eq!(high, Duration::from_millis(4800));
}

#[test]
fn jitter_never_produces_a_negative_or_overflowing_duration() {
    let c = config();
    // attempt 1 has an unjittered delay of 1s; jitter_sample 0.0 (fully negative offset) must
    // still clamp at zero, not panic/underflow.
    let delay = next_delay(c, 1, 0.0);
    assert!(delay <= Duration::from_secs(1));
}

#[test]
fn out_of_range_jitter_samples_are_clamped_rather_than_panicking() {
    let c = config();
    let below = next_delay(c, 2, -5.0);
    let above = next_delay(c, 2, 5.0);
    assert_eq!(below, next_delay(c, 2, 0.0));
    assert_eq!(above, next_delay(c, 2, 1.0));
}
