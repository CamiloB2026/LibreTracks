//! From a click analysis to the tempo and time signature markers of one song.
//!
//! The analysis speaks in seconds from the start of the song; the session
//! keeps one tempo map for every song in it. This places the segments in that
//! map without disturbing the songs around: applying replaces the markers
//! inside the song and, when the next song relied on the tempo leaking into
//! it, puts that tempo back at its start.
//!
//! Where the bar must restart (the song's first downbeat, the click coming
//! back off the previous grid after a gap, the next song's start) the
//! proposal puts a TIME SIGNATURE marker, even with the same meter. A tempo
//! change in a click that goes on is placed on the grid instead, so the meter
//! only shows up again where it really changes. The engine's metronome
//! restarts the bar at any marker, but the timeline grid only at a time
//! signature marker: a tempo marker keeps the beat phase, as in Ableton. See
//! `docs/plans/song-analysis/00-DISENO.md` §3.

use serde::{Deserialize, Serialize};

use crate::click::ClickAnalysis;

/// Two positions this close are the same marker (the 1 ms the editors use).
const SAME_POSITION_SECONDS: f64 = 0.0005;
/// A first downbeat this close to the song start goes exactly on it.
const SNAP_TO_SONG_START_SECONDS: f64 = 0.003;
/// A segment that starts this close to where the previous one's bars end
/// continues its grid; its marker goes on the grid.
const GRID_SNAP_SECONDS: f64 = 0.030;
/// Right after the previous segment, a start this far off its grid (as a
/// share of a beat) is still the next bar: the previous tempo is adjusted to
/// land on it. Farther is the click coming back after a gap.
const CONTIGUOUS_BEATS: f64 = 0.5;
/// The session's own start: every grid starts a bar there.
const SESSION_ORIGIN_SECONDS: f64 = 0.0001;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SongSpan {
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// Start of the song after this one, if any.
    pub next_song_start_seconds: Option<f64>,
}

/// The session's tempo map today.
#[derive(Debug, Clone, PartialEq)]
pub struct ExistingTiming {
    pub bpm: f64,
    pub time_signature: String,
    /// (start, bpm)
    pub tempo_markers: Vec<(f64, f64)>,
    /// (start, signature)
    pub signature_markers: Vec<(f64, String)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedTempoMarker {
    pub start_seconds: f64,
    pub bpm: f64,
    /// Puts back the tempo the next song had (not part of the analysis).
    #[serde(default)]
    pub restores_next_song: bool,
    /// Ramps to the next marker's bpm (`TempoMarker::ramp`).
    #[serde(default)]
    pub ramp: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedSignatureMarker {
    pub start_seconds: f64,
    pub signature: String,
    #[serde(default)]
    pub restores_next_song: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoProposal {
    pub tempo_markers: Vec<ProposedTempoMarker>,
    pub signature_markers: Vec<ProposedSignatureMarker>,
    /// What rules the start of the song today, for the review screen.
    pub current_bpm: f64,
    pub current_signature: String,
    /// The song already has exactly these markers.
    pub unchanged: bool,
}

fn value_at<T: Clone>(base: &T, markers: &[(f64, T)], at: f64) -> T {
    let mut value = base.clone();
    let mut best = f64::NEG_INFINITY;
    for (start, marker_value) in markers {
        if *start <= at + SAME_POSITION_SECONDS && *start >= best {
            best = *start;
            value = marker_value.clone();
        }
    }
    value
}

/// One segment of the analysis on the session's timeline.
struct Placement {
    start: f64,
    bpm: f64,
    /// A ramp from `bpm` to this across its bars.
    end_bpm: Option<f64>,
    beats_per_bar: u32,
    beat_unit: u32,
    /// Bars from `start` to where the next segment follows on.
    bars: u32,
    restarts_bar: bool,
}

impl Placement {
    fn bar_seconds(&self) -> f64 {
        240.0 * f64::from(self.beats_per_bar) / (self.bpm * f64::from(self.beat_unit))
    }

    /// Whether this grid carries on into a segment whose first downbeat the
    /// click puts at `start`, so no time signature marker has to restart the
    /// bar there. A click that follows the band ends a bar a few dozen ms off
    /// its rounded tempo: within `GRID_SNAP_SECONDS` the next marker moves
    /// onto the grid, and right after this segment (no gap) up to
    /// `CONTIGUOUS_BEATS` this tempo is set to land exactly on it.
    fn continue_into(&mut self, start: &mut f64) -> bool {
        if let Some(end_bpm) = self.end_bpm {
            // A ramp was built to span its bars in the click's time: it lands
            // on the next downbeat but for rounding, unless the click stopped.
            let quarters = f64::from(self.bars) * f64::from(self.beats_per_bar) * 4.0
                / f64::from(self.beat_unit);
            let end = self.start + 120.0 * quarters / (self.bpm + end_bpm);
            let beat = 240.0 / ((self.bpm + end_bpm) / 2.0 * f64::from(self.beat_unit));
            if (*start - end).abs() <= CONTIGUOUS_BEATS * beat {
                *start = end;
                return true;
            }
            return false;
        }
        let bar = self.bar_seconds();
        if !(bar > 0.0) {
            return false;
        }
        let bars = ((*start - self.start) / bar).round().max(1.0);
        let grid_end = self.start + bars * bar;
        let off = *start - grid_end;
        if off.abs() <= GRID_SNAP_SECONDS {
            *start = grid_end;
            return true;
        }
        let beat = bar / f64::from(self.beats_per_bar.max(1));
        if bars as u32 == self.bars && off.abs() <= CONTIGUOUS_BEATS * beat {
            let beats = bars * f64::from(self.beats_per_bar);
            let exact = 240.0 * beats / ((*start - self.start) * f64::from(self.beat_unit));
            self.bpm = (exact * 1000.0).round() / 1000.0;
            *start = self.start + bars * self.bar_seconds();
            return true;
        }
        false
    }
}

pub fn propose_tempo_markers(
    analysis: &ClickAnalysis,
    span: SongSpan,
    existing: &ExistingTiming,
) -> TempoProposal {
    let inside = |start: f64| {
        start >= span.start_seconds - SAME_POSITION_SECONDS
            && start < span.end_seconds - SAME_POSITION_SECONDS
    };
    let kept_tempo: Vec<(f64, f64)> = existing
        .tempo_markers
        .iter()
        .filter(|(start, _)| !inside(*start))
        .cloned()
        .collect();
    let kept_signatures: Vec<(f64, String)> = existing
        .signature_markers
        .iter()
        .filter(|(start, _)| !inside(*start))
        .cloned()
        .collect();

    let mut running_bpm = value_at(&existing.bpm, &kept_tempo, span.start_seconds);
    let mut running_signature = value_at(
        &existing.time_signature,
        &kept_signatures,
        span.start_seconds,
    );
    // Where each segment's grid starts, and whether the bar restarts there.
    let mut placements: Vec<Placement> = Vec::new();
    for (index, segment) in analysis.segments.iter().enumerate() {
        let bar = segment.bar_seconds();
        let downbeat = span.start_seconds + segment.start_seconds;
        let mut start = downbeat;
        let mut bars = segment.bars;
        if index == 0 && bar > 0.0 {
            // Carry the grid back to the song start, so the bars before the
            // first click (a silent intro, a pickup) are on it too. A grid
            // estimated a hair before the song (from the music) moves forward
            // instead.
            let back = ((downbeat - span.start_seconds) / bar + 1.0e-3).floor();
            start -= back * bar;
            bars = (i64::from(bars) + back as i64).max(1) as u32;
        }
        if (start - span.start_seconds).abs() < SNAP_TO_SONG_START_SECONDS {
            start = span.start_seconds;
        }
        let mut continues = false;
        if let Some(previous) = placements.last_mut() {
            continues = previous.continue_into(&mut start);
        }
        if !inside(start) {
            continue;
        }
        placements.push(Placement {
            start,
            bpm: segment.bpm,
            end_bpm: segment.end_bpm,
            beats_per_bar: segment.beats_per_bar,
            beat_unit: segment.beat_unit,
            bars,
            // The bar restarts here: the song's first downbeat, or the click
            // coming back off the previous segment's grid (after a gap).
            restarts_bar: (index == 0 || !continues) && start > SESSION_ORIGIN_SECONDS,
        });
    }

    let mut tempo_markers: Vec<ProposedTempoMarker> = Vec::new();
    let mut signature_markers: Vec<ProposedSignatureMarker> = Vec::new();
    for (index, placement) in placements.iter().enumerate() {
        let signature = format!("{}/{}", placement.beats_per_bar, placement.beat_unit);
        // The engine restarts the bar at the song start, so a first marker
        // there that changes nothing is redundant.
        let redundant_at_song_start = index == 0
            && placement.start == span.start_seconds
            && placement.bpm == running_bpm
            && signature == running_signature;
        // A ramp needs its marker, and so does the stretch after one: the
        // ramp glides to the next marker, wherever that is.
        let after_ramp = index > 0 && placements[index - 1].end_bpm.is_some();
        let needs_tempo = if index == 0 {
            !redundant_at_song_start || placement.end_bpm.is_some()
        } else {
            placement.bpm != running_bpm
                || placement.restarts_bar
                || placement.end_bpm.is_some()
                || after_ramp
        };
        if needs_tempo {
            tempo_markers.push(ProposedTempoMarker {
                start_seconds: placement.start,
                bpm: placement.bpm,
                restores_next_song: false,
                ramp: placement.end_bpm.is_some(),
            });
            running_bpm = placement.end_bpm.unwrap_or(placement.bpm);
        }
        // Same meter where the grid goes on is no marker: only a new meter,
        // or a bar that must restart.
        if signature != running_signature || placement.restarts_bar {
            signature_markers.push(ProposedSignatureMarker {
                start_seconds: placement.start,
                signature: signature.clone(),
                restores_next_song: false,
            });
            running_signature = signature;
        }
    }

    // A ramp at the end (a ritardando into the last chord) lands on a marker
    // of its own, or it would glide on to the next song's.
    if let Some(last) = placements.last().filter(|last| last.end_bpm.is_some()) {
        let end_bpm = last.end_bpm.unwrap_or(last.bpm);
        let quarters =
            f64::from(last.bars) * f64::from(last.beats_per_bar) * 4.0 / f64::from(last.beat_unit);
        let end = (last.start + 120.0 * quarters / (last.bpm + end_bpm))
            .min(span.end_seconds - 2.0 * SAME_POSITION_SECONDS);
        if end > last.start {
            tempo_markers.push(ProposedTempoMarker {
                start_seconds: end,
                bpm: end_bpm,
                restores_next_song: false,
                ramp: false,
            });
        }
    }

    // The next song keeps the tempo and meter it plays at today.
    if let Some(next) = span.next_song_start_seconds {
        let mut new_tempo = kept_tempo.clone();
        new_tempo.extend(tempo_markers.iter().map(|m| (m.start_seconds, m.bpm)));
        let before = value_at(&existing.bpm, &existing.tempo_markers, next);
        if value_at(&existing.bpm, &new_tempo, next) != before {
            tempo_markers.push(ProposedTempoMarker {
                start_seconds: next,
                bpm: before,
                restores_next_song: true,
                ramp: false,
            });
        }
        let before = value_at(&existing.time_signature, &existing.signature_markers, next);
        // A marker at the next song's start (unless it has one), whenever
        // this song's map changes: the new tempo moves where the grid's bars
        // fall by the time they get there.
        let next_has_own = existing
            .signature_markers
            .iter()
            .any(|(start, _)| (start - next).abs() < SAME_POSITION_SECONDS);
        let changes_inside = !tempo_markers.is_empty() || !signature_markers.is_empty();
        if changes_inside && !next_has_own {
            signature_markers.push(ProposedSignatureMarker {
                start_seconds: next,
                signature: before,
                restores_next_song: true,
            });
        }
    }

    let existing_inside_tempo: Vec<(f64, f64)> = existing
        .tempo_markers
        .iter()
        .filter(|(start, _)| inside(*start))
        .cloned()
        .collect();
    let existing_inside_signatures: Vec<(f64, String)> = existing
        .signature_markers
        .iter()
        .filter(|(start, _)| inside(*start))
        .cloned()
        .collect();
    let same_positions = |a: f64, b: f64| (a - b).abs() < SAME_POSITION_SECONDS * 2.0;
    let unchanged = tempo_markers.len() == existing_inside_tempo.len()
        && signature_markers.len() == existing_inside_signatures.len()
        && tempo_markers
            .iter()
            .zip(&existing_inside_tempo)
            .all(|(new, old)| {
                !new.restores_next_song
                    && !new.ramp
                    && same_positions(new.start_seconds, old.0)
                    && (new.bpm - old.1).abs() < 0.005
            })
        && signature_markers
            .iter()
            .zip(&existing_inside_signatures)
            .all(|(new, old)| {
                !new.restores_next_song
                    && same_positions(new.start_seconds, old.0)
                    && new.signature == old.1
            });

    TempoProposal {
        tempo_markers,
        signature_markers,
        current_bpm: value_at(&existing.bpm, &existing.tempo_markers, span.start_seconds),
        current_signature: value_at(
            &existing.time_signature,
            &existing.signature_markers,
            span.start_seconds,
        ),
        unchanged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::click::TempoSegment;

    fn segment(start: f64, bpm: f64, beats_per_bar: u32, bars: u32) -> TempoSegment {
        TempoSegment {
            start_seconds: start,
            bpm,
            beats_per_bar,
            beat_unit: 4,
            bars,
            end_bpm: None,
        }
    }

    fn analysis(segments: Vec<TempoSegment>) -> ClickAnalysis {
        ClickAnalysis {
            segments,
            warnings: Vec::new(),
            beat_count: 0,
            downbeat_known: true,
        }
    }

    fn timing() -> ExistingTiming {
        ExistingTiming {
            bpm: 120.0,
            time_signature: "4/4".into(),
            tempo_markers: Vec::new(),
            signature_markers: Vec::new(),
        }
    }

    fn span(start: f64, end: f64, next: Option<f64>) -> SongSpan {
        SongSpan {
            start_seconds: start,
            end_seconds: end,
            next_song_start_seconds: next,
        }
    }

    #[test]
    fn first_downbeat_on_the_song_start_is_a_marker_there() {
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.001, 90.0, 4, 40)]),
            span(100.0, 220.0, None),
            &timing(),
        );
        assert_eq!(
            proposal.tempo_markers,
            vec![ProposedTempoMarker {
                start_seconds: 100.0,
                bpm: 90.0,
                restores_next_song: false,
                ramp: false
            }]
        );
        // Same meter, but the bar restarts on the song's first downbeat: the
        // timeline grid only does that at a time signature marker.
        assert_eq!(
            proposal.signature_markers,
            vec![ProposedSignatureMarker {
                start_seconds: 100.0,
                signature: "4/4".into(),
                restores_next_song: false
            }]
        );
        assert_eq!(proposal.current_bpm, 120.0);
        assert!(!proposal.unchanged);
    }

    #[test]
    fn a_grid_starting_just_before_the_song_moves_forward_a_bar() {
        // Estimated from the music: first downbeat 80 ms before the song.
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(-0.08, 127.0, 4, 40)]),
            span(100.0, 220.0, None),
            &timing(),
        );
        let bar = 4.0 * 60.0 / 127.0;
        assert_eq!(proposal.tempo_markers.len(), 1, "{proposal:?}");
        assert!((proposal.tempo_markers[0].start_seconds - (99.92 + bar)).abs() < 1e-9);
    }

    #[test]
    fn grid_is_carried_back_to_the_song_start() {
        // 90 BPM 4/4: a bar is 2.666 s. A downbeat 6 s in → 2 bars back.
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(6.0, 90.0, 4, 40)]),
            span(100.0, 220.0, None),
            &timing(),
        );
        let bar = 4.0 * 60.0 / 90.0;
        assert!((proposal.tempo_markers[0].start_seconds - (106.0 - 2.0 * bar)).abs() < 1e-9);
    }

    #[test]
    fn the_next_song_gets_its_tempo_and_meter_back() {
        let proposal = propose_tempo_markers(
            &analysis(vec![TempoSegment {
                beat_unit: 8,
                ..segment(0.0, 70.0, 6, 40)
            }]),
            span(100.0, 220.0, Some(224.0)),
            &timing(),
        );
        assert_eq!(proposal.tempo_markers.len(), 2);
        assert_eq!(
            proposal.tempo_markers[1],
            ProposedTempoMarker {
                start_seconds: 224.0,
                bpm: 120.0,
                restores_next_song: true,
                ramp: false
            }
        );
        assert_eq!(proposal.signature_markers[0].signature, "6/8");
        assert_eq!(proposal.signature_markers[1].signature, "4/4");
        assert!(proposal.signature_markers[1].restores_next_song);
    }

    #[test]
    fn a_next_song_with_its_own_marker_needs_nothing() {
        let mut existing = timing();
        existing.tempo_markers.push((224.0, 128.0));
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.0, 70.0, 4, 40)]),
            span(100.0, 220.0, Some(224.0)),
            &existing,
        );
        assert_eq!(proposal.tempo_markers.len(), 1);
    }

    #[test]
    fn markers_already_in_place_are_unchanged() {
        let mut existing = timing();
        existing.tempo_markers = vec![(100.0, 90.0), (224.0, 120.0)];
        existing.signature_markers = vec![(100.0, "4/4".into()), (224.0, "4/4".into())];
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.0, 90.0, 4, 40)]),
            span(100.0, 220.0, Some(224.0)),
            &existing,
        );
        assert!(proposal.unchanged, "{proposal:?}");
    }

    #[test]
    fn same_tempo_at_the_song_start_needs_no_marker() {
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.0, 120.0, 4, 40)]),
            span(0.0, 120.0, None),
            &timing(),
        );
        assert!(proposal.tempo_markers.is_empty());
        assert!(proposal.unchanged);
    }

    #[test]
    fn a_tempo_change_mid_song_is_a_second_marker() {
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(16.0, 90.0, 4, 8);
        let proposal = propose_tempo_markers(
            &analysis(vec![first, second]),
            span(10.0, 60.0, None),
            &timing(),
        );
        // 120 at the start is what already rules: only the change.
        assert_eq!(proposal.tempo_markers.len(), 1);
        assert_eq!(proposal.tempo_markers[0].start_seconds, 26.0);
        assert_eq!(proposal.tempo_markers[0].bpm, 90.0);
    }

    #[test]
    fn same_tempo_off_the_grid_restarts_it() {
        // After a gap the click comes back half a beat late: same BPM, but
        // the grid must restart there.
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(20.25, 120.0, 4, 8);
        let proposal = propose_tempo_markers(
            &analysis(vec![first, second]),
            span(0.0, 60.0, None),
            &timing(),
        );
        assert_eq!(proposal.tempo_markers.len(), 1);
        assert_eq!(proposal.tempo_markers[0].start_seconds, 20.25);
        // …and the grid only restarts at a time signature marker.
        let restarts: Vec<f64> = proposal
            .signature_markers
            .iter()
            .map(|m| m.start_seconds)
            .collect();
        assert_eq!(restarts, vec![20.25]);
    }

    #[test]
    fn a_tempo_change_on_the_grid_needs_no_signature_marker() {
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(16.0, 90.0, 4, 8);
        let proposal = propose_tempo_markers(
            &analysis(vec![first, second]),
            span(0.0, 60.0, None),
            &timing(),
        );
        assert!(proposal.signature_markers.is_empty(), "{proposal:?}");
    }

    #[test]
    fn the_next_song_start_gets_a_signature_marker_when_this_one_changes() {
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.0, 90.0, 4, 40)]),
            span(100.0, 220.0, Some(224.0)),
            &timing(),
        );
        let next = proposal
            .signature_markers
            .iter()
            .find(|m| m.start_seconds == 224.0)
            .expect("marker at the next song");
        assert_eq!(next.signature, "4/4");
        assert!(next.restores_next_song);
    }

    #[test]
    fn a_click_that_follows_the_band_restarts_no_bar() {
        // One-bar tempos as the click reads them: each fitted on its own
        // bar, so its grid ends a few dozen ms off the next downbeat.
        let mut segments = vec![segment(0.0, 71.0, 4, 8)];
        let mut at = 8.0 * 4.0 * 60.0 / 71.0;
        for (bpm, real_bar) in [(69.39, 3.73), (56.0, 4.28), (58.5, 4.10), (71.0, 3.38)] {
            segments.push(segment(at, bpm, 4, 1));
            at += real_bar;
        }
        segments.push(segment(at, 71.0, 4, 16));
        let proposal =
            propose_tempo_markers(&analysis(segments), span(100.0, 220.0, None), &timing());
        let mid_song: Vec<_> = proposal
            .signature_markers
            .iter()
            .filter(|m| m.start_seconds > 100.0)
            .collect();
        assert!(mid_song.is_empty(), "{proposal:#?}");
        // Every marker stays on the click's downbeat (the last 71 goes on
        // in the final stretch, which needs no marker of its own).
        let last = proposal.tempo_markers.last().expect("markers");
        assert_eq!(proposal.tempo_markers.len(), 5, "{proposal:#?}");
        assert!(
            (last.start_seconds - (100.0 + at - 3.38)).abs() < 0.03,
            "{proposal:#?}"
        );
    }

    #[test]
    fn a_tempo_a_few_ms_off_the_grid_goes_on_it() {
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(16.012, 90.0, 4, 8);
        let proposal = propose_tempo_markers(
            &analysis(vec![first, second]),
            span(0.0, 60.0, None),
            &timing(),
        );
        assert_eq!(proposal.tempo_markers[0].start_seconds, 16.0);
        assert!(proposal.signature_markers.is_empty(), "{proposal:?}");
    }

    #[test]
    fn a_ramp_is_a_ramp_marker_and_lands_on_one() {
        // 72 for 8 bars, then a 2-bar ritardando to 56 into the end.
        let steady = segment(0.0, 72.0, 4, 8);
        let start = 8.0 * 4.0 * 60.0 / 72.0;
        let ramp = TempoSegment {
            end_bpm: Some(56.0),
            ..segment(start, 72.0, 4, 2)
        };
        let proposal = propose_tempo_markers(
            &analysis(vec![steady, ramp]),
            span(100.0, 200.0, Some(210.0)),
            &timing(),
        );
        let markers: Vec<(f64, f64, bool)> = proposal
            .tempo_markers
            .iter()
            .filter(|m| !m.restores_next_song)
            .map(|m| (m.start_seconds, m.bpm, m.ramp))
            .collect();
        let ramp_end = 100.0 + start + 120.0 * 8.0 / (72.0 + 56.0);
        assert_eq!(markers.len(), 3, "{proposal:#?}");
        assert_eq!(markers[0], (100.0, 72.0, false));
        // 72 again at the ramp's start: it needs its own marker.
        assert!((markers[1].0 - (100.0 + start)).abs() < 1e-9 && markers[1].2);
        assert!((markers[2].0 - ramp_end).abs() < 1e-9 && markers[2].1 == 56.0 && !markers[2].2);
        assert!(
            proposal
                .signature_markers
                .iter()
                .all(|m| m.start_seconds == 100.0 || m.restores_next_song),
            "{proposal:#?}"
        );
    }

    #[test]
    fn nothing_found_proposes_nothing() {
        let proposal = propose_tempo_markers(
            &analysis(vec![]),
            span(100.0, 220.0, Some(224.0)),
            &timing(),
        );
        assert!(proposal.tempo_markers.is_empty());
        assert!(proposal.signature_markers.is_empty());
    }
}
