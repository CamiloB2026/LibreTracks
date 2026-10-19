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
//! A drifting passage is cut into at most three stretches, each one steady
//! (its average) or a tempo RAMP, as Ableton draws a ritardando: a sloped
//! segment that lands on its bars exactly. A ramp is used only where it
//! follows the click clearly (every downbeat within half a beat); a zigzag
//! fits no line, and chaining ramps through one swings wildly (measured on
//! "Digno de adorar": 31, 85, 36, 82 BPM...), so it keeps its average. The
//! passage may also end before the click looks: the bars where it is back
//! on the steady tempo join that tempo.

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

/// A ramp must change the tempo this much (as a fraction of its average)
/// to be one; less is a steady stretch.
const RAMP_MIN_CHANGE: f64 = 0.03;
/// A cut with ramps is taken when every downbeat stays this close (a share
/// of a beat) to where its stretches put it: a third of a beat, so only a
/// clear ritardando or accelerando, not a zigzag a line happens to graze.
const RAMP_FIT_BEATS: f64 = 0.35;
/// And when it costs at most this many markers more than the plain average.
const RAMP_EXTRA_MARKERS: usize = 1;
/// At most this many stretches per drifting passage.
const MAX_STRETCHES: usize = 3;
/// A ramp needs this many of the click's bars (segments) to show it: with
/// one or two any line fits, the click proves nothing.
const RAMP_MIN_SEGMENTS: usize = 3;
/// A ramp's ends may sit this far (as a fraction) from the tempos the click
/// plays in its first and last bars.
const RAMP_END_TOLERANCE: f64 = 0.08;

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

/// A drifting passage as its downbeats: where each segment starts (and
/// where the passage ends) and the quarter notes elapsed by then.
struct Passage<'a> {
    run: &'a [TempoSegment],
    downbeats: Vec<f64>,
    quarters: Vec<f64>,
    quarters_per_beat: f64,
}

#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Steady,
    Ramp,
}

/// One stretch `run[from..to]` with its tempo and how far it strays.
struct Stretch {
    segment: TempoSegment,
    error_beats: f64,
}

impl<'a> Passage<'a> {
    fn new(run: &'a [TempoSegment], until: Option<f64>) -> Self {
        let last = &run[run.len() - 1];
        let mut downbeats: Vec<f64> = run.iter().map(|segment| segment.start_seconds).collect();
        downbeats.push(until.unwrap_or_else(|| end_seconds(last)));
        let mut quarters = vec![0.0];
        for segment in run {
            quarters.push(quarters[quarters.len() - 1] + segment.quarters());
        }
        Self {
            run,
            downbeats,
            quarters,
            quarters_per_beat: 4.0 / f64::from(run[0].beat_unit),
        }
    }

    fn average_bpm(&self, from: usize, to: usize) -> f64 {
        60.0 * (self.quarters[to] - self.quarters[from])
            / (self.downbeats[to] - self.downbeats[from])
    }

    /// Largest distance, in beats, from a downbeat inside the stretch to
    /// where a line from `start_bpm` to `end_bpm` across it puts it.
    fn error_beats(&self, from: usize, to: usize, start_bpm: f64, end_bpm: f64) -> f64 {
        let start = self.downbeats[from];
        let seconds = self.downbeats[to] - start;
        let slope = (end_bpm - start_bpm) / seconds;
        let beat = 60.0 * self.quarters_per_beat / ((start_bpm + end_bpm) / 2.0);
        ((from + 1)..to)
            .map(|m| {
                let q60 = 60.0 * (self.quarters[m] - self.quarters[from]);
                let root = (start_bpm * start_bpm + 2.0 * slope * q60).max(0.0).sqrt();
                let predicted = start + 2.0 * q60 / (start_bpm + root);
                (predicted - self.downbeats[m]).abs() / beat
            })
            .fold(0.0, f64::max)
    }

    fn steady(&self, from: usize, to: usize) -> Stretch {
        let segment = spanning(&self.run[from..to], Some(self.downbeats[to]));
        Stretch {
            error_beats: self.error_beats(from, to, segment.bpm, segment.bpm),
            segment,
        }
    }

    /// A ramp over the stretch that lands on its bars: its average is fixed,
    /// so it ends on `end_bpm` when the tempo after it is known (the ramp
    /// glides into it) and the start follows; else it starts on `start_bpm`,
    /// the steady tempo before it (a ritardando leaving it), or on the pair
    /// that strays least. Starting from the steady tempo takes two of the
    /// click's bars to show; otherwise three.
    fn ramp(
        &self,
        from: usize,
        to: usize,
        end_bpm: Option<f64>,
        start_bpm: Option<f64>,
    ) -> Option<Stretch> {
        let average = self.average_bpm(from, to);
        let pair = |start_bpm: f64| (start_bpm, 2.0 * average - start_bpm);
        let candidates: Vec<(f64, f64)> = match (end_bpm, start_bpm) {
            (Some(end_bpm), _) if to - from >= RAMP_MIN_SEGMENTS => {
                vec![(2.0 * average - end_bpm, end_bpm)]
            }
            (None, Some(start_bpm)) if to - from >= RAMP_MIN_SEGMENTS - 1 => {
                let mut all = vec![pair(start_bpm)];
                if to - from >= RAMP_MIN_SEGMENTS {
                    all.extend(self.free_pairs(average));
                }
                all
            }
            (None, None) if to - from >= RAMP_MIN_SEGMENTS => self.free_pairs(average),
            _ => return None,
        };
        // The ramp's tempo through the click's first and last bars against
        // what the click plays there (the middle of a bar, not its ends: a
        // bar's tempo is its average).
        let middle = |m: usize| (self.downbeats[m] + self.downbeats[m + 1]) / 2.0;
        let near = |bpm: f64, played: f64| ((bpm - played) / played).abs() <= RAMP_END_TOLERANCE;
        let start = self.downbeats[from];
        let seconds = self.downbeats[to] - start;
        let at = |start_bpm: f64, end_bpm: f64, t: f64| {
            start_bpm + (end_bpm - start_bpm) * (t - start) / seconds
        };
        let (first_bpm, last_bpm) = (self.run[from].bpm, self.run[to - 1].bpm);
        let (error_beats, start_bpm, end_bpm) = candidates
            .into_iter()
            .map(|(start, end)| ((start * 1000.0).round() / 1000.0, end))
            .filter(|(start, end)| {
                (20.0..=300.0).contains(start)
                    && (20.0..=300.0).contains(end)
                    && ((end - start) / average).abs() >= RAMP_MIN_CHANGE
                    && near(at(*start, *end, middle(from)), first_bpm)
                    && near(at(*start, *end, middle(to - 1)), last_bpm)
            })
            .map(|(start, end)| (self.error_beats(from, to, start, end), start, end))
            .min_by(|a, b| a.0.total_cmp(&b.0))?;
        Some(Stretch {
            segment: TempoSegment {
                bpm: start_bpm,
                end_bpm: Some(end_bpm),
                bars: self.run[from..to].iter().map(|segment| segment.bars).sum(),
                ..self.run[from].clone()
            },
            error_beats,
        })
    }

    /// Start/end pairs around `average`, for a ramp with neither end known.
    fn free_pairs(&self, average: f64) -> Vec<(f64, f64)> {
        (0..=400)
            .map(|step| {
                let start = average * (0.5 + 0.0025 * f64::from(step));
                (start, 2.0 * average - start)
            })
            .collect()
    }
}

/// Every way to cut `0..n` into `pieces` stretches, as cut points.
fn cuts(n: usize, pieces: usize) -> Vec<Vec<usize>> {
    if pieces == 1 {
        return vec![vec![0, n]];
    }
    let mut all = Vec::new();
    for first in 1..n {
        for rest in cuts(n - first, pieces - 1) {
            let mut points = vec![0];
            points.extend(rest.iter().map(|point| point + first));
            all.push(points);
        }
    }
    all
}

/// The passage's stretches. Candidates: one steady stretch (the plain
/// average); cuts with a ramp where every stretch follows the click closely
/// (`RAMP_FIT_BEATS`) for at most one marker more; and steady cuts that only
/// hand bars back to the steady tempo on either side, which cost no marker.
/// A ramp cut that fits wins (fewest markers, then least strayed); else the
/// steady candidate that strays least.
fn fit_passage(
    run: &[TempoSegment],
    until: Option<f64>,
    previous_bpm: Option<f64>,
    next_bpm: Option<f64>,
) -> Vec<TempoSegment> {
    let passage = Passage::new(run, until);
    let n = run.len();
    let same =
        |a: f64, b: Option<f64>| b.is_some_and(|b| ((a - b) / b).abs() <= SAME_TEMPO_FRACTION);
    let mut best_ramp: Option<(usize, f64, Vec<TempoSegment>)> = None;
    let mut best_steady: Option<(f64, Vec<TempoSegment>)> = None;
    for pieces in 1..=MAX_STRETCHES.min(n) {
        for points in cuts(n, pieces) {
            for mask in 0..(1_u32 << pieces) {
                let shapes: Vec<Shape> = (0..pieces)
                    .map(|i| {
                        if mask & (1 << i) != 0 {
                            Shape::Ramp
                        } else {
                            Shape::Steady
                        }
                    })
                    .collect();
                // A ramp ends on the next marker's tempo: never on a ramp's.
                if shapes.windows(2).any(|w| w == [Shape::Ramp, Shape::Ramp]) {
                    continue;
                }
                let has_ramp = shapes.contains(&Shape::Ramp);
                // Back to front: a ramp needs the tempo after it.
                let mut stretches: Vec<Stretch> = Vec::with_capacity(pieces);
                let mut after = next_bpm;
                let mut valid = true;
                for i in (0..pieces).rev() {
                    let (from, to) = (points[i], points[i + 1]);
                    let stretch = match shapes[i] {
                        Shape::Steady => passage.steady(from, to),
                        Shape::Ramp => {
                            match passage.ramp(from, to, after, previous_bpm.filter(|_| from == 0))
                            {
                                Some(stretch) => stretch,
                                None => {
                                    valid = false;
                                    break;
                                }
                            }
                        }
                    };
                    after = Some(stretch.segment.bpm);
                    stretches.push(stretch);
                }
                if !valid {
                    continue;
                }
                stretches.reverse();
                let error = stretches.iter().map(|s| s.error_beats).fold(0.0, f64::max);
                // Steady stretches at the tempo on either side join it.
                let joins = |stretch: &Stretch, neighbour: Option<f64>| {
                    stretch.segment.end_bpm.is_none() && same(stretch.segment.bpm, neighbour)
                };
                let markers = pieces
                    - usize::from(joins(&stretches[0], previous_bpm))
                    - usize::from(pieces > 1 && joins(&stretches[pieces - 1], next_bpm));
                let segments: Vec<TempoSegment> = stretches
                    .into_iter()
                    .map(|stretch| stretch.segment)
                    .collect();
                if has_ramp {
                    // Between cuts that fit alike, the one whose tempo jumps
                    // least where its stretches meet (no leap up to 73 just
                    // to slow down from there).
                    let mut jumps = 0.0;
                    let mut before = previous_bpm;
                    for segment in &segments {
                        if let Some(before) = before {
                            jumps += ((segment.bpm - before) / before).abs();
                        }
                        before = Some(segment.end_bpm.unwrap_or(segment.bpm));
                    }
                    let score = error + jumps;
                    let better = best_ramp
                        .as_ref()
                        .is_none_or(|(m, e, _)| (markers, score) < (*m, *e));
                    if error <= RAMP_FIT_BEATS && markers <= 1 + RAMP_EXTRA_MARKERS && better {
                        best_ramp = Some((markers, score, segments));
                    }
                } else if markers <= 1 && best_steady.as_ref().is_none_or(|(e, _)| error < *e) {
                    best_steady = Some((error, segments));
                }
            }
        }
    }
    best_ramp
        .map(|(_, _, segments)| segments)
        .or(best_steady.map(|(_, segments)| segments))
        .unwrap_or_else(|| vec![spanning(run, until)])
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

/// The simplified tempo map: a drifting passage becomes at most three
/// stretches, steady or ramps (see `fit_passage`); tempos that only differ by
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
            simplified.extend(fit_passage(
                run,
                until,
                previous_bpm,
                next.map(|next| next.bpm),
            ));
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
        // It slows down and lands on its bars exactly.
        assert!(
            ramp.end_bpm.is_some_and(|to| to < 62.0 && ramp.bpm > 66.0),
            "{ramp:?}"
        );
        let landing = end_seconds(ramp) - end_seconds(&segments[4]);
        assert!(landing.abs() < 1e-3, "{landing}");
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
    fn a_wavering_stretch_then_a_ritardando_is_a_tempo_and_a_ramp() {
        // The end of "Digno de adorar": around 66 for a while, then slowing
        // into the last chord.
        let segments = chain(
            0.0,
            &[
                (71.0, 40),
                (66.0, 1),
                (67.5, 1),
                (65.5, 1),
                (66.5, 1),
                (67.0, 1),
                (65.0, 1),
                (66.5, 1),
                (62.0, 1),
                (56.0, 1),
                (50.0, 1),
                (44.0, 1),
            ],
        );
        let simplified = simplify_segments(&segments);
        assert_eq!(simplified.len(), 3, "{simplified:#?}");
        assert!(simplified[1].end_bpm.is_none(), "{simplified:#?}");
        let ramp = &simplified[2];
        assert!(ramp.end_bpm.is_some_and(|to| to < 50.0), "{simplified:#?}");
        let landing = end_seconds(ramp) - end_seconds(&segments[11]);
        assert!(landing.abs() < 1e-3, "{landing}");
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
