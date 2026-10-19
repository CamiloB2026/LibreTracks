//! Tempo ramps: the tempo gliding from one marker to the next.
//!
//! A tempo marker with `ramp` starts a stretch whose tempo goes linearly (in
//! time) from its bpm to the next tempo marker's, reached exactly there. It
//! is Ableton's sloped tempo-automation segment; a marker without it is a
//! step, as tempo markers always were.
//!
//! Linear in TIME, not in beats, so the beats elapsed are a quadratic in the
//! seconds and the inverse has a closed form. The same formulas live in the
//! timeline (`timelineMath.ts`) and in the engine's metronome
//! (`tempo_ramp.h`): keep the three in step.

use crate::model::{Song, TempoMarker};

/// One stretch of a tempo map: `start_bpm` at `start`, `end_bpm` at `end`,
/// linear between. A step has both equal (and `end` may be infinite).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TempoSpan {
    pub start: f64,
    pub end: f64,
    pub start_bpm: f64,
    pub end_bpm: f64,
}

impl TempoSpan {
    pub fn constant(start: f64, bpm: f64) -> Self {
        Self {
            start,
            end: f64::INFINITY,
            start_bpm: bpm,
            end_bpm: bpm,
        }
    }

    pub fn is_ramp(&self) -> bool {
        self.end.is_finite() && self.end > self.start && self.start_bpm != self.end_bpm
    }

    /// bpm per second over the ramp.
    fn slope(&self) -> f64 {
        if self.is_ramp() {
            (self.end_bpm - self.start_bpm) / (self.end - self.start)
        } else {
            0.0
        }
    }

    pub fn bpm_at(&self, seconds: f64) -> f64 {
        if !self.is_ramp() || seconds <= self.start {
            return self.start_bpm;
        }
        if seconds >= self.end {
            return self.end_bpm;
        }
        self.start_bpm + self.slope() * (seconds - self.start)
    }

    /// Quarter notes from `start` to `seconds` (negative before it). Past
    /// `end` the tempo holds `end_bpm`.
    fn quarters_from_start(&self, seconds: f64) -> f64 {
        let dt = seconds - self.start;
        if !self.is_ramp() || dt <= 0.0 {
            return dt * self.start_bpm / 60.0;
        }
        let ramp = (seconds.min(self.end) - self.start).max(0.0);
        let inside = (self.start_bpm * ramp + 0.5 * self.slope() * ramp * ramp) / 60.0;
        inside + (seconds - self.end).max(0.0) * self.end_bpm / 60.0
    }

    /// Quarter notes between two instants.
    pub fn quarters_between(&self, from: f64, to: f64) -> f64 {
        self.quarters_from_start(to) - self.quarters_from_start(from)
    }

    /// The instant `quarters` quarter notes after `from` (before it when
    /// negative).
    pub fn seconds_after(&self, from: f64, quarters: f64) -> f64 {
        let target = self.quarters_from_start(from) + quarters;
        if !self.is_ramp() || target <= 0.0 {
            return self.start + target * 60.0 / self.start_bpm;
        }
        let ramp_quarters = self.quarters_from_start(self.end);
        if target >= ramp_quarters {
            return self.end + (target - ramp_quarters) * 60.0 / self.end_bpm;
        }
        // a·dt + k/2·dt² = 60·q, the root that stays finite as k → 0.
        let a = self.start_bpm;
        let k = self.slope();
        let q60 = 60.0 * target;
        self.start + 2.0 * q60 / (a + (a * a + 2.0 * k * q60).max(0.0).sqrt())
    }

    /// The part of this span from `from` to `to`, with the bpm it has there.
    pub fn between(&self, from: f64, to: f64) -> Self {
        Self {
            start: from,
            end: to,
            start_bpm: self.bpm_at(from),
            end_bpm: if self.is_ramp() {
                self.bpm_at(to)
            } else {
                self.start_bpm
            },
        }
    }
}

/// Markers by position (the song keeps them sorted, but not every caller's
/// copy is).
fn sorted(markers: &[TempoMarker]) -> Vec<&TempoMarker> {
    let mut sorted: Vec<&TempoMarker> = markers.iter().collect();
    sorted.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    sorted
}

/// The stretch of the tempo map that `marker` starts: up to the next marker,
/// a ramp to its bpm when `marker.ramp`.
fn span_from(marker: &TempoMarker, next: Option<&TempoMarker>) -> TempoSpan {
    match next {
        Some(next) if next.start_seconds > marker.start_seconds => TempoSpan {
            start: marker.start_seconds,
            end: next.start_seconds,
            start_bpm: marker.bpm,
            end_bpm: if marker.ramp { next.bpm } else { marker.bpm },
        },
        _ => TempoSpan::constant(marker.start_seconds, marker.bpm),
    }
}

/// Every stretch of the song's tempo map from 0, in order: `song.bpm` until
/// the first marker, then one per marker.
pub fn tempo_spans(song: &Song) -> Vec<TempoSpan> {
    tempo_spans_of(song.bpm, &song.tempo_markers)
}

pub fn tempo_spans_of(base_bpm: f64, markers: &[TempoMarker]) -> Vec<TempoSpan> {
    let markers = sorted(markers);
    let mut spans = Vec::with_capacity(markers.len() + 1);
    let first_start = markers.first().map_or(f64::INFINITY, |m| m.start_seconds);
    if first_start > 0.0 {
        spans.push(TempoSpan {
            start: 0.0,
            end: first_start,
            start_bpm: base_bpm,
            end_bpm: base_bpm,
        });
    }
    for (index, marker) in markers.iter().enumerate() {
        spans.push(span_from(marker, markers.get(index + 1).copied()));
    }
    spans
}

/// The stretch of the tempo map that rules at `seconds`.
pub fn tempo_span_at(song: &Song, seconds: f64) -> TempoSpan {
    tempo_spans(song)
        .into_iter()
        .rev()
        .find(|span| span.start <= seconds)
        .unwrap_or_else(|| TempoSpan::constant(0.0, song.bpm))
}

/// The tempo at `seconds`, inside a ramp too.
pub fn bpm_at(song: &Song, seconds: f64) -> f64 {
    tempo_span_at(song, seconds).bpm_at(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(start: f64, end: f64, from: f64, to: f64) -> TempoSpan {
        TempoSpan {
            start,
            end,
            start_bpm: from,
            end_bpm: to,
        }
    }

    #[test]
    fn a_ramp_counts_the_average_tempo() {
        // 60 → 120 over 10 s: the average is 90, so 15 quarters.
        let span = ramp(0.0, 10.0, 60.0, 120.0);
        assert!((span.quarters_between(0.0, 10.0) - 15.0).abs() < 1e-12);
        assert_eq!(span.bpm_at(5.0), 90.0);
        // Past the end it holds 120: 2 more quarters a second.
        assert!((span.quarters_between(10.0, 11.0) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn seconds_after_inverts_quarters_between() {
        for span in [
            ramp(2.0, 12.0, 60.0, 120.0),
            ramp(2.0, 12.0, 140.0, 70.0),
            TempoSpan::constant(2.0, 98.0),
        ] {
            for from in [0.0, 2.0, 5.5, 11.9, 14.0] {
                for quarters in [-3.0, 0.0, 0.25, 1.0, 7.0, 30.0] {
                    let to = span.seconds_after(from, quarters);
                    let back = span.quarters_between(from, to);
                    assert!((back - quarters).abs() < 1e-9, "{span:?} {from} {quarters}");
                }
            }
        }
    }

    #[test]
    fn a_tiny_ramp_behaves_like_a_step() {
        let span = ramp(0.0, 10.0, 100.0, 100.000_000_1);
        assert!((span.seconds_after(0.0, 10.0) - 6.0).abs() < 1e-6);
    }

    #[test]
    fn the_map_ramps_to_the_next_marker_and_steps_otherwise() {
        let marker = |start: f64, bpm: f64, ramp: bool| TempoMarker {
            id: format!("t{start}"),
            start_seconds: start,
            bpm,
            ramp,
        };
        let markers = vec![
            marker(20.0, 80.0, false),
            marker(10.0, 60.0, true),
            marker(30.0, 90.0, true),
        ];
        let spans = tempo_spans_of(120.0, &markers);
        assert_eq!(spans.len(), 4);
        assert_eq!(spans[0], ramp(0.0, 10.0, 120.0, 120.0));
        assert_eq!(spans[1], ramp(10.0, 20.0, 60.0, 80.0));
        assert_eq!(spans[2], ramp(20.0, 30.0, 80.0, 80.0));
        // The last marker ramps to nothing: it holds its bpm.
        assert!(!spans[3].is_ramp());
        assert_eq!(spans[3].bpm_at(100.0), 90.0);
    }

    #[test]
    fn a_part_of_a_ramp_is_the_same_line() {
        let span = ramp(0.0, 10.0, 60.0, 120.0);
        let part = span.between(5.0, 10.0);
        assert_eq!(part.start_bpm, 90.0);
        assert_eq!(part.end_bpm, 120.0);
        assert!(
            (part.quarters_between(5.0, 10.0) - span.quarters_between(5.0, 10.0)).abs() < 1e-12
        );
    }
}
