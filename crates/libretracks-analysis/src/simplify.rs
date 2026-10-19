//! Fewer tempo changes than the click has.
//!
//! A live click that follows the band through a free passage changes tempo
//! bar after bar ("Digno de adorar", Miel San Marcos: 69, 56, 58, 60, 59,
//! 67... for a minute and a half). Following it to the bar is right for a
//! metronome in the ears, but it fills the ruler with dozens of markers. The
//! simplified map keeps one tempo per stretch: the passage gets the tempo
//! that spans it exactly (its bars over its duration), so the grid leaves it
//! on the click again; tempos that only differ by rounding become one.
//!
//! A passage that only speeds up or only slows down (a ritardando into the
//! last chord, an accelerando into a chorus) becomes one tempo RAMP instead,
//! as Ableton draws it: a sloped segment from where it starts to where it
//! lands. A zigzag can't be one line, and chaining exact ramps through it
//! swings wildly (measured on "Digno de adorar": 31, 85, 36, 82 BPM...), so it
//! keeps its average.

use crate::click::TempoSegment;

/// Segments shorter than this, one after another, are a passage whose tempo
/// drifts: no stretch of it holds a tempo. In seconds, not bars: the same
/// click read in quarters (142) has bars half as long as read in eighths (71).
const DRIFTING_MAX_SECONDS: f64 = 12.0;
/// Neighbouring tempos this close (as a fraction) are the same tempo read
/// twice (70.84 for 3 bars between two long stretches of 71).
const SAME_TEMPO_FRACTION: f64 = 0.01;
/// A segment that starts within this share of a beat of where the previous
/// one's bars end follows it with no gap in the click.
const CONTIGUOUS_BEATS: f64 = 0.5;

/// Tempo changes smaller than this (as a fraction) are the click's own
/// jitter, not the passage turning around.
const TURN_FRACTION: f64 = 0.015;
/// A drift this large overall (start to end) is worth a ramp.
const RAMP_MIN_CHANGE: f64 = 0.03;
/// A ramp's ends may sit this far (as a fraction) from the tempos the click
/// plays at its first and last bars.
const RAMP_END_TOLERANCE: f64 = 0.15;
/// Every downbeat inside the passage must stay this close (a share of a beat)
/// to where the ramp puts it.
const RAMP_FIT_BEATS: f64 = 0.5;

fn end_seconds(segment: &TempoSegment) -> f64 {
    segment.start_seconds + segment.duration_seconds()
}

fn drifting(segment: &TempoSegment) -> bool {
    segment.duration_seconds() < DRIFTING_MAX_SECONDS
}

fn contiguous(before: &TempoSegment, after: &TempoSegment) -> bool {
    (after.start_seconds - end_seconds(before)).abs() <= CONTIGUOUS_BEATS * before.beat_seconds()
        && before.signature() == after.signature()
}

/// A quarter-note BPM rounded to a hundredth, as the click's own tempos.
fn round_bpm(bpm: f64) -> f64 {
    (bpm * 100.0).round() / 100.0
}

/// One tempo over `run` (contiguous, same meter): its bars over its span.
/// The span ends where the segment after it starts, when it follows on.
fn spanning(run: &[TempoSegment], until: Option<f64>) -> TempoSegment {
    let first = &run[0];
    let last = &run[run.len() - 1];
    let bars: u32 = run.iter().map(|segment| segment.bars).sum();
    let end = until.unwrap_or_else(|| end_seconds(last));
    let beats = f64::from(bars * first.beats_per_bar);
    let seconds = end - first.start_seconds;
    let bpm = if seconds > 0.0 {
        round_bpm(240.0 * beats / (seconds * f64::from(first.beat_unit)))
    } else {
        first.bpm
    };
    TempoSegment {
        bpm,
        bars,
        ..first.clone()
    }
}

/// The passage only speeds up or only slows down, by enough to matter.
fn monotonic(run: &[TempoSegment]) -> bool {
    let mut direction = 0.0_f64;
    for pair in run.windows(2) {
        let change = (pair[1].bpm - pair[0].bpm) / pair[0].bpm;
        if change.abs() <= TURN_FRACTION {
            continue;
        }
        if direction != 0.0 && change.signum() != direction {
            return false;
        }
        direction = change.signum();
    }
    let first = run[0].bpm;
    let last = run[run.len() - 1].bpm;
    direction != 0.0 && ((last - first) / first).abs() >= RAMP_MIN_CHANGE
}

/// One ramp over `run` that lands on its bars exactly: it spans them in the
/// passage's time, so its average tempo is fixed and one end sets the other.
/// It ends on `next_bpm` when a steady stretch follows (the ramp glides into
/// it), else it starts where the click does (or on the steady tempo before
/// it, when that is close). None when the line doesn't follow the click.
fn ramp_over(
    run: &[TempoSegment],
    until: Option<f64>,
    previous_bpm: Option<f64>,
    next_bpm: Option<f64>,
) -> Option<TempoSegment> {
    let first = &run[0];
    let last = &run[run.len() - 1];
    let start = first.start_seconds;
    let end = until.unwrap_or_else(|| end_seconds(last));
    let quarters: f64 = run.iter().map(TempoSegment::quarters).sum();
    let seconds = end - start;
    if seconds <= 0.0 {
        return None;
    }
    let average = 60.0 * quarters / seconds;
    let near = |bpm: f64, target: f64| ((bpm - target) / target).abs() <= RAMP_END_TOLERANCE;
    let (from, to) = match next_bpm {
        Some(to) => (2.0 * average - to, to),
        None => {
            let from = previous_bpm
                .filter(|bpm| near(*bpm, first.bpm))
                .unwrap_or(first.bpm);
            (from, 2.0 * average - from)
        }
    };
    let from = (from * 1000.0).round() / 1000.0;
    if !(20.0..=300.0).contains(&from)
        || !(20.0..=300.0).contains(&to)
        || !near(from, first.bpm)
        || !near(to, last.bpm)
        || (to - from).signum() != (last.bpm - first.bpm).signum()
    {
        return None;
    }
    // Each downbeat inside, against the line's.
    let slope = (to - from) / seconds;
    let beat_seconds = first.beat_seconds() * first.bpm / average;
    let mut elapsed = 0.0;
    for segment in &run[..run.len() - 1] {
        elapsed += segment.quarters();
        let q60 = 60.0 * elapsed;
        let predicted =
            start + 2.0 * q60 / (from + (from * from + 2.0 * slope * q60).max(0.0).sqrt());
        let actual = end_seconds(segment);
        if (predicted - actual).abs() > RAMP_FIT_BEATS * beat_seconds {
            return None;
        }
    }
    Some(TempoSegment {
        bpm: from,
        end_bpm: Some(to),
        bars: run.iter().map(|segment| segment.bars).sum(),
        ..first.clone()
    })
}

/// Neighbours with the same tempo, give or take rounding, become one at the
/// tempo of the longer, when its grid still lands on the click at the end.
fn merge_same_tempo(segments: Vec<TempoSegment>) -> Vec<TempoSegment> {
    let mut merged: Vec<TempoSegment> = Vec::with_capacity(segments.len());
    for segment in segments {
        let Some(previous) = merged.last_mut() else {
            merged.push(segment);
            continue;
        };
        let close = ((segment.bpm - previous.bpm) / previous.bpm).abs() <= SAME_TEMPO_FRACTION;
        let steady = previous.end_bpm.is_none() && segment.end_bpm.is_none();
        if close && steady && contiguous(previous, &segment) {
            let bpm = if segment.bars > previous.bars {
                segment.bpm
            } else {
                previous.bpm
            };
            let candidate = TempoSegment {
                bpm,
                bars: previous.bars + segment.bars,
                ..previous.clone()
            };
            let drift = (end_seconds(&candidate) - end_seconds(&segment)).abs();
            if drift <= CONTIGUOUS_BEATS * candidate.beat_seconds() {
                *previous = candidate;
                continue;
            }
        }
        merged.push(segment);
    }
    merged
}

/// The simplified tempo map: a drifting passage becomes a ramp when it only
/// speeds up or slows down, else one tempo; tempos that only differ by
/// rounding become one. Meter changes and gaps in the click stay as they are.
pub fn simplify_segments(segments: &[TempoSegment]) -> Vec<TempoSegment> {
    let mut simplified: Vec<TempoSegment> = Vec::with_capacity(segments.len());
    let mut index = 0;
    while index < segments.len() {
        let mut end = index + 1;
        if drifting(&segments[index]) {
            while end < segments.len()
                && drifting(&segments[end])
                && contiguous(&segments[end - 1], &segments[end])
            {
                end += 1;
            }
        }
        if end - index >= 2 {
            let run = &segments[index..end];
            let next = segments
                .get(end)
                .filter(|next| contiguous(&segments[end - 1], next));
            let until = next.map(|next| next.start_seconds);
            let previous_bpm = index
                .checked_sub(1)
                .map(|before| &segments[before])
                .filter(|before| contiguous(before, &run[0]))
                .map(|before| before.bpm);
            let ramp = monotonic(run)
                .then(|| ramp_over(run, until, previous_bpm, next.map(|next| next.bpm)))
                .flatten();
            simplified.push(ramp.unwrap_or_else(|| spanning(run, until)));
        } else {
            simplified.push(segments[index].clone());
        }
        index = end;
    }
    merge_same_tempo(simplified)
}

/// Only the tempo the song starts at, across the whole click.
pub fn initial_tempo_only(segments: &[TempoSegment]) -> Vec<TempoSegment> {
    let Some(first) = segments.first() else {
        return Vec::new();
    };
    let end = segments
        .iter()
        .map(end_seconds)
        .fold(end_seconds(first), f64::max);
    let bar = first.bar_seconds();
    let bars = if bar > 0.0 {
        (((end - first.start_seconds) / bar - 1.0e-6).ceil() as u32).max(1)
    } else {
        first.bars
    };
    vec![TempoSegment {
        bars,
        ..first.clone()
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(start: f64, bpm: f64, bars: u32) -> TempoSegment {
        TempoSegment {
            start_seconds: start,
            bpm,
            beats_per_bar: 4,
            beat_unit: 4,
            bars,
            end_bpm: None,
        }
    }

    /// Segments that follow each other exactly, from (bpm, bars).
    fn chain(start: f64, parts: &[(f64, u32)]) -> Vec<TempoSegment> {
        let mut at = start;
        parts
            .iter()
            .map(|&(bpm, bars)| {
                let s = segment(at, bpm, bars);
                at = end_seconds(&s);
                s
            })
            .collect()
    }

    #[test]
    fn a_free_passage_becomes_one_tempo_that_spans_it() {
        // "Digno de adorar" read as eighths: 71, then a minute of drifting
        // one-bar tempos, then 71 again.
        let segments = chain(
            0.0,
            &[
                (71.0, 92),
                (69.39, 1),
                (56.0, 1),
                (58.5, 1),
                (60.5, 1),
                (59.0, 1),
                (67.5, 1),
                (63.5, 1),
                (60.5, 1),
                (71.0, 48),
            ],
        );
        let simplified = simplify_segments(&segments);
        assert_eq!(simplified.len(), 3, "{simplified:#?}");
        assert_eq!(simplified[0].bpm, 71.0);
        assert_eq!(simplified[1].bars, 8);
        assert_eq!(simplified[2].bpm, 71.0);
        // The passage's grid ends where the click goes back to 71.
        let landing = end_seconds(&simplified[1]) - simplified[2].start_seconds;
        assert!(landing.abs() < 0.02, "{landing}");
        assert!(simplified[1].bpm > 56.0 && simplified[1].bpm < 69.39);
    }

    #[test]
    fn tempos_that_only_differ_by_rounding_are_one() {
        let segments = chain(404.65, &[(71.0, 13), (70.84, 3), (71.0, 48)]);
        let simplified = simplify_segments(&segments);
        assert_eq!(simplified.len(), 1, "{simplified:#?}");
        assert_eq!(simplified[0].bpm, 71.0);
        assert_eq!(simplified[0].bars, 64);
    }

    #[test]
    fn a_real_tempo_change_stays() {
        let segments = chain(0.0, &[(120.0, 16), (90.0, 16)]);
        assert_eq!(simplify_segments(&segments), segments);
    }

    #[test]
    fn a_meter_change_stays() {
        let mut segments = chain(0.0, &[(120.0, 8), (120.0, 1), (120.0, 1), (120.0, 8)]);
        segments[1].beats_per_bar = 2;
        segments[1].start_seconds = 16.0;
        segments[2].start_seconds = 17.0;
        segments[3].start_seconds = 19.0;
        let simplified = simplify_segments(&segments);
        assert!(
            simplified.iter().any(|s| s.beats_per_bar == 2),
            "{simplified:#?}"
        );
    }

    #[test]
    fn a_gap_in_the_click_is_not_bridged() {
        let mut segments = chain(0.0, &[(100.0, 1), (80.0, 1)]);
        segments[1].start_seconds += 10.0;
        assert_eq!(simplify_segments(&segments), segments);
    }

    #[test]
    fn a_ritardando_into_the_end_is_one_ramp() {
        // "Fallos en cantos": 72, then 68.7 and 62 into the last chord.
        let segments = chain(
            0.0,
            &[(72.0, 40), (70.0, 1), (66.0, 1), (62.0, 1), (58.0, 1)],
        );
        let simplified = simplify_segments(&segments);
        assert_eq!(simplified.len(), 2, "{simplified:#?}");
        let ramp = &simplified[1];
        // It starts on the steady 72 and lands on its bars exactly.
        assert_eq!(ramp.bpm, 72.0);
        assert!(ramp.end_bpm.is_some_and(|to| to < 62.0), "{ramp:?}");
        let landing = end_seconds(ramp) - end_seconds(&segments[4]);
        assert!(landing.abs() < 1e-6, "{landing}");
    }

    #[test]
    fn an_accelerando_ramps_into_the_tempo_that_follows() {
        let segments = chain(
            0.0,
            &[(90.0, 16), (92.0, 1), (95.0, 1), (98.0, 1), (100.0, 16)],
        );
        let simplified = simplify_segments(&segments);
        assert_eq!(simplified.len(), 3, "{simplified:#?}");
        assert_eq!(simplified[1].end_bpm, Some(100.0));
        let landing = end_seconds(&simplified[1]) - segments[4].start_seconds;
        assert!(landing.abs() < 0.01, "{landing}");
    }

    #[test]
    fn a_zigzag_keeps_its_average_not_a_ramp() {
        let segments = chain(
            0.0,
            &[
                (71.0, 40),
                (60.0, 1),
                (68.0, 1),
                (56.0, 1),
                (66.0, 1),
                (71.0, 20),
            ],
        );
        let simplified = simplify_segments(&segments);
        assert!(
            simplified.iter().all(|s| s.end_bpm.is_none()),
            "{simplified:#?}"
        );
    }

    #[test]
    fn initial_tempo_spans_the_whole_click() {
        let segments = chain(0.5, &[(142.0, 184), (122.0, 2), (138.0, 2), (142.0, 30)]);
        let initial = initial_tempo_only(&segments);
        assert_eq!(initial.len(), 1);
        assert_eq!(initial[0].bpm, 142.0);
        assert_eq!(initial[0].start_seconds, 0.5);
        assert!(end_seconds(&initial[0]) >= end_seconds(segments.last().unwrap()) - 1e-9);
    }
}
