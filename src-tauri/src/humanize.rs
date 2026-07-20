//! Humanized keystroke timing for the credential auto-login flow.
//!
//! Filling a login form by typing the whole string in one shot is the single
//! most obvious automation tell. This module produces a per-character delay
//! schedule that imitates a human typing cadence: a base rhythm with random
//! jitter, plus occasional longer "thinking" pauses. It is deliberately
//! transport-free and deterministic given a seed, so the timing model is
//! unit-testable without a live browser — the browser flow seeds it from
//! `getrandom` at runtime, while tests seed it with a fixed value and assert the
//! resulting delays fall within their configured bounds.

use std::time::Duration;

/// A tiny SplitMix64 PRNG. The crate already depends on `getrandom` but not on
/// `rand`, so this keeps the humanizer dependency-free. It is deterministic
/// given a seed and more than adequate for jittering keystroke timing — this is
/// jitter, never anything cryptographic.
#[derive(Debug, Clone)]
pub struct Prng {
    state: u64,
}

impl Prng {
    /// A PRNG seeded with an explicit value (used by tests for determinism).
    pub fn new(seed: u64) -> Self {
        Prng { state: seed }
    }

    /// Seed from the OS entropy source so each auto-login has its own cadence.
    /// Falls back to a time-derived seed if `getrandom` is somehow unavailable —
    /// still varied enough that two runs never share an identical rhythm.
    pub fn from_entropy() -> Self {
        let mut buf = [0u8; 8];
        let seed = if getrandom::getrandom(&mut buf).is_ok() {
            u64::from_le_bytes(buf)
        } else {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x9E37_79B9_7F4A_7C15)
        };
        Prng::new(seed)
    }

    /// SplitMix64 step.
    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform integer in `[low, high]` (inclusive). Returns `low` when
    /// `high <= low`, so callers never need to pre-validate degenerate bounds.
    pub fn range(&mut self, low: u64, high: u64) -> u64 {
        if high <= low {
            return low;
        }
        low + self.next_u64() % (high - low + 1)
    }

    /// True with probability `numerator / denominator`. A zero denominator is
    /// treated as "never" so a disabled pause config can't divide by zero.
    pub fn chance(&mut self, numerator: u32, denominator: u32) -> bool {
        if denominator == 0 {
            return false;
        }
        (self.next_u64() % u64::from(denominator)) < u64::from(numerator)
    }
}

/// Tunables for the typing rhythm. All bounds are inclusive milliseconds.
#[derive(Debug, Clone)]
pub struct TypingRhythm {
    /// Fastest inter-keystroke interval.
    pub min_ms: u64,
    /// Slowest ordinary inter-keystroke interval (before any pause).
    pub max_ms: u64,
    /// Probability numerator that a given keystroke is preceded by a longer
    /// "thinking" pause (numerator / denominator).
    pub pause_numerator: u32,
    /// Probability denominator for a thinking pause.
    pub pause_denominator: u32,
    /// Shortest thinking pause, added on top of the base interval.
    pub pause_min_ms: u64,
    /// Longest thinking pause, added on top of the base interval.
    pub pause_max_ms: u64,
}

impl Default for TypingRhythm {
    /// A calm, unhurried human cadence: ~55–165 ms between keystrokes with an
    /// occasional (~9%) 260–620 ms pause. These are conservative on purpose — a
    /// visibly deliberate fill reads far more natural than a fast one.
    fn default() -> Self {
        TypingRhythm {
            min_ms: 55,
            max_ms: 165,
            pause_numerator: 9,
            pause_denominator: 100,
            pause_min_ms: 260,
            pause_max_ms: 620,
        }
    }
}

impl TypingRhythm {
    /// The delay to wait BEFORE emitting the next character: a base keystroke
    /// interval, plus — occasionally — an extra "thinking" pause.
    pub fn next_delay(&self, prng: &mut Prng) -> Duration {
        let mut ms = prng.range(self.min_ms, self.max_ms);
        if prng.chance(self.pause_numerator, self.pause_denominator) {
            ms += prng.range(self.pause_min_ms, self.pause_max_ms);
        }
        Duration::from_millis(ms)
    }

    /// One delay per character in `text`, in order. Used to preview / test the
    /// full schedule; the live flow calls [`Self::next_delay`] per keystroke.
    pub fn schedule(&self, prng: &mut Prng, text: &str) -> Vec<Duration> {
        text.chars().map(|_| self.next_delay(prng)).collect()
    }

    /// Inclusive `(min, max)` milliseconds a single keystroke delay can take:
    /// `min_ms` with no pause, up to `max_ms + pause_max_ms` with one. Tests use
    /// this to bound-check every emitted delay.
    pub fn per_char_bounds(&self) -> (u64, u64) {
        (self.min_ms, self.max_ms + self.pause_max_ms)
    }

    /// A short, human pause to insert between fields (after the username, before
    /// the password) or before pressing submit — deliberately longer than a
    /// keystroke gap.
    pub fn field_switch_delay(&self, prng: &mut Prng) -> Duration {
        Duration::from_millis(prng.range(self.pause_min_ms, self.pause_max_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_stays_within_inclusive_bounds() {
        let mut prng = Prng::new(1);
        for _ in 0..10_000 {
            let v = prng.range(50, 60);
            assert!((50..=60).contains(&v), "out of range: {v}");
        }
    }

    #[test]
    fn range_returns_low_for_degenerate_bounds() {
        let mut prng = Prng::new(42);
        assert_eq!(prng.range(100, 100), 100);
        assert_eq!(prng.range(100, 10), 100);
    }

    #[test]
    fn chance_zero_denominator_never_fires() {
        let mut prng = Prng::new(7);
        for _ in 0..1_000 {
            assert!(!prng.chance(5, 0));
        }
    }

    #[test]
    fn chance_full_probability_always_fires() {
        let mut prng = Prng::new(7);
        for _ in 0..1_000 {
            assert!(prng.chance(10, 10));
        }
    }

    #[test]
    fn next_delay_respects_per_char_bounds() {
        let rhythm = TypingRhythm::default();
        let (low, high) = rhythm.per_char_bounds();
        let mut prng = Prng::new(123);
        for _ in 0..50_000 {
            let ms = rhythm.next_delay(&mut prng).as_millis() as u64;
            assert!((low..=high).contains(&ms), "delay {ms} outside [{low},{high}]");
        }
    }

    #[test]
    fn schedule_yields_one_delay_per_character() {
        let rhythm = TypingRhythm::default();
        let mut prng = Prng::new(9);
        // Multi-byte chars: the schedule counts Unicode scalar values, not bytes.
        let text = "usér_náme😀";
        let expected = text.chars().count();
        assert_eq!(rhythm.schedule(&mut prng, text).len(), expected);
    }

    #[test]
    fn schedule_is_deterministic_for_a_fixed_seed() {
        let rhythm = TypingRhythm::default();
        let a = rhythm.schedule(&mut Prng::new(2024), "password123");
        let b = rhythm.schedule(&mut Prng::new(2024), "password123");
        assert_eq!(a, b);
    }

    #[test]
    fn thinking_pauses_do_occur_over_many_keystrokes() {
        // With a 9% pause chance, a long schedule must contain at least one delay
        // pushed above the no-pause ceiling (max_ms), proving pauses are applied.
        let rhythm = TypingRhythm::default();
        let mut prng = Prng::new(555);
        let delays = rhythm.schedule(&mut prng, &"x".repeat(2_000));
        let paused = delays
            .iter()
            .any(|d| d.as_millis() as u64 > rhythm.max_ms);
        assert!(paused, "expected at least one thinking pause in 2000 keystrokes");
    }

    #[test]
    fn field_switch_delay_is_within_pause_window() {
        let rhythm = TypingRhythm::default();
        let mut prng = Prng::new(88);
        for _ in 0..5_000 {
            let ms = rhythm.field_switch_delay(&mut prng).as_millis() as u64;
            assert!(
                (rhythm.pause_min_ms..=rhythm.pause_max_ms).contains(&ms),
                "field switch {ms} outside pause window"
            );
        }
    }
}
