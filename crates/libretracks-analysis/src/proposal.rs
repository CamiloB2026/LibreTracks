//! From a click analysis to the tempo and time signature markers of one song.
//!
//! The analysis speaks in seconds from the start of the song; the session
//! keeps one tempo map for every song in it. This places the segments in that
//! map without disturbing the songs around: applying replaces the markers
//! inside the song and, when the next song relied on the tempo leaking into
//! it, puts that tempo back at its start.
//!
//! Where the bar must restart (the song's first downbeat, the click coming
//! back off the previous grid, the next song's start) the proposal puts a
//! TIME SIGNATURE marker, even with the same meter. The engine's metronome
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
/// continues its grid.
const GRID_CONTINUES_SECONDS: f64 = 0.005;
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
    let mut tempo_markers: Vec<ProposedTempoMarker> = Vec::new();
    let mut signature_markers: Vec<ProposedSignatureMarker> = Vec::new();
    let mut previous_grid_end: Option<f64> = None;

    for (index, segment) in analysis.segments.iter().enumerate() {
        let bar = segment.bar_seconds();
        let downbeat = span.start_seconds + segment.start_seconds;
        let mut start = downbeat;
        if index == 0 && bar > 0.0 {
            // Carry the grid back to the song start, so the bars before the
            // first click (a silent intro, a pickup) are on it too.
            let bars_back = ((downbeat - span.start_seconds) / bar + 1.0e-3)
                .floor()
                .max(0.0);
            start -= bars_back * bar;
        }
        if (start - span.start_seconds).abs() < SNAP_TO_SONG_START_SECONDS {
            start = span.start_seconds;
        }
        if !inside(start) {
            continue;
        }
        let signature = segment.signature();
        let grid_continues =
            previous_grid_end.is_some_and(|end| (end - start).abs() < GRID_CONTINUES_SECONDS);
        // The engine restarts the bar at the song start, so a first marker
        // there that changes nothing is redundant.
        let redundant_at_song_start = index == 0
            && start == span.start_seconds
            && segment.bpm == running_bpm
            && signature == running_signature;
        let needs_tempo = if index == 0 {
            !redundant_at_song_start
        } else {
            segment.bpm != running_bpm || !grid_continues
        };
        // The bar restarts here: the song's first downbeat, or the click
        // coming back off the previous segment's grid.
        let restarts_bar = (index == 0 || !grid_continues) && start > SESSION_ORIGIN_SECONDS;
        if needs_tempo {
            tempo_markers.push(ProposedTempoMarker {
                start_seconds: start,
                bpm: segment.bpm,
                restores_next_song: false,
            });
            running_bpm = segment.bpm;
        }
        if signature != running_signature || restarts_bar {
            signature_markers.push(ProposedSignatureMarker {
                start_seconds: start,
                signature: signature.clone(),
                restores_next_song: false,
            });
            running_signature = signature;
        }
        previous_grid_end = Some(downbeat + f64::from(segment.bars) * bar);
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
                restores_next_song: false
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
                restores_next_song: true
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
