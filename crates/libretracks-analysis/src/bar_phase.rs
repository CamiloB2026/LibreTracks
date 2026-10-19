//! Where the bar starts in a click without accent, from the guide.
//!
//! Every click sounds the same, so the click alone counts bars from its first
//! beat: a song whose bar 1 comes two beats after the first click ("Es Él",
//! Felipe S. Santos: the click starts on beat 3) got every bar, and with them
//! every guide marker, half a bar off. The guide knows better: it speaks in
//! the bar before its section and finishes right before the section's
//! downbeat ("Coro, dos, tres, cuatro"). So, among the beats of a bar, the
//! downbeat is the one the announcements end closest before.
//!
//! The announcement STARTS do not tell: a guide speaks on beats 1 and 3 alike.

use crate::guide::GuideAnalysis;

/// Fragments closer than this (in beats) are one announcement: "Coro" and
/// its count-in, or the numbers of a count. The intro's "Intro… uno, dos"
/// leaves 1.3 beats between them.
const CHAIN_GAP_BEATS: f64 = 1.5;
/// The last word can run a little past the downbeat (see
/// `ANNOUNCEMENT_TAIL_BEATS` in songAnalysisPlan.ts): that downbeat still
/// follows it.
const TAIL_BEATS: f64 = 0.3;
/// Fewer announcements than this is too little to move the bar.
const MIN_ANNOUNCEMENTS: usize = 2;
/// The best phase must beat the runner-up by this much (mean beats from an
/// announcement's end to the next downbeat). On the real guide above the
/// right phase averages ~1 beat and the one two beats off ~3.
const MIN_MARGIN_BEATS: f64 = 0.75;

/// How many beats of `beat_times` (one run of a click without accent, with
/// no gap) come before its first downbeat: 0..beats_per_bar. None when the
/// guide does not say clearly, and the bars stay counted from the first beat.
/// Guide and click must share a time base (the same render).
pub(crate) fn pickup_from_guide(
    beat_times: &[f64],
    beats_per_bar: usize,
    guide: &GuideAnalysis,
) -> Option<usize> {
    if beats_per_bar < 2 || beat_times.len() < beats_per_bar * 2 {
        return None;
    }
    let first = beat_times[0];
    let last = *beat_times.last()?;
    let beat = (last - first) / (beat_times.len() - 1) as f64;
    if !(beat > 0.0) {
        return None;
    }
    let ends = announcement_ends(guide, beat);
    let ends: Vec<f64> = ends
        .into_iter()
        .filter(|&end| end > first && end < last - beat * beats_per_bar as f64)
        .collect();
    if ends.len() < MIN_ANNOUNCEMENTS {
        return None;
    }
    let mut scores: Vec<(usize, f64)> = (0..beats_per_bar)
        .map(|phase| {
            let total: f64 = ends
                .iter()
                .map(|&end| {
                    let from = end - TAIL_BEATS * beat;
                    // The first beat at or after `from`, then on to a downbeat.
                    let index = beat_times.partition_point(|&t| t < from);
                    let ahead = (beats_per_bar + phase - index % beats_per_bar) % beats_per_bar;
                    let downbeat = beat_times
                        .get(index + ahead)
                        .copied()
                        .unwrap_or(last + beat * ahead as f64);
                    (downbeat - end) / beat
                })
                .sum();
            (phase, total / ends.len() as f64)
        })
        .collect();
    scores.sort_by(|a, b| a.1.total_cmp(&b.1));
    (scores[1].1 - scores[0].1 >= MIN_MARGIN_BEATS).then_some(scores[0].0)
}

/// Where each announcement ends: the end of its last fragment.
fn announcement_ends(guide: &GuideAnalysis, beat: f64) -> Vec<f64> {
    let mut fragments: Vec<(f64, f64)> = guide
        .announcements
        .iter()
        .map(|a| (a.start_seconds, a.end_seconds))
        .collect();
    fragments.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut ends: Vec<f64> = Vec::new();
    for (index, &(_, end)) in fragments.iter().enumerate() {
        let chained = fragments
            .get(index + 1)
            .is_some_and(|&(next_start, _)| next_start - end < CHAIN_GAP_BEATS * beat);
        if !chained {
            ends.push(end);
        }
    }
    ends
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guide::GuideAnnouncement;

    fn guide(fragments: &[(f64, f64)]) -> GuideAnalysis {
        GuideAnalysis {
            announcements: fragments
                .iter()
                .map(|&(start_seconds, end_seconds)| GuideAnnouncement {
                    start_seconds,
                    end_seconds,
                    group: 0,
                    count_words: Vec::new(),
                })
                .collect(),
            groups: Vec::new(),
        }
    }

    /// The fragments the guide analysis found on "Es Él" (Felipe S. Santos,
    /// 70 BPM): its bars start at 1.714 s, two beats after the click's first.
    const ES_EL: &[(f64, f64)] = &[
        (0.08, 0.57),
        (1.71, 2.12),
        (2.57, 3.02),
        (3.43, 4.71),
        (22.30, 25.28),
        (51.43, 52.12),
        (77.15, 77.57),
        (78.00, 80.14),
        (97.72, 100.71),
        (126.86, 127.55),
        (152.58, 153.00),
        (153.42, 154.73),
        (155.14, 155.57),
        (174.86, 175.29),
        (193.72, 195.02),
        (195.43, 196.71),
        (216.01, 217.15),
        (234.86, 235.29),
        (235.71, 237.86),
        (257.15, 257.57),
        (276.01, 278.16),
        (278.57, 279.00),
        (296.58, 298.73),
        (299.14, 299.57),
        (318.86, 319.40),
        (337.72, 338.15),
        (338.57, 339.02),
        (339.43, 340.71),
        (360.00, 360.43),
        (380.58, 381.05),
    ];

    fn beats(start: f64, bpm: f64, count: usize) -> Vec<f64> {
        (0..count).map(|i| start + i as f64 * 60.0 / bpm).collect()
    }

    #[test]
    fn a_real_guide_finds_the_bar_two_beats_after_the_click() {
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(ES_EL)),
            Some(2)
        );
    }

    #[test]
    fn a_click_already_on_the_bar_keeps_it() {
        let shifted: Vec<(f64, f64)> = ES_EL
            .iter()
            .map(|&(s, e)| (s + 120.0 / 70.0, e + 120.0 / 70.0))
            .collect();
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&shifted)),
            Some(0)
        );
    }

    #[test]
    fn too_little_guide_says_nothing() {
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&[(51.43, 52.12)])),
            None
        );
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&[])),
            None
        );
    }

    #[test]
    fn announcements_spread_over_the_bar_say_nothing() {
        // Ends on every beat alike: no phase stands out.
        let spread: Vec<(f64, f64)> = (0..16)
            .map(|i| {
                let end = 10.0 + i as f64 * (3.0 * 60.0 / 70.0 * 4.0 + 60.0 / 70.0) + 0.4;
                (end - 0.5, end)
            })
            .collect();
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&spread)),
            None
        );
    }
}
