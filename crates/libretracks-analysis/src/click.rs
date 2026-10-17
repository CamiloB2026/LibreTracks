//! Tempo map and meter from a click track.
//!
//! A multitrack's click stem is the most reliable tempo source there is: it is
//! the exact grid the band plays to, and its accent says where each bar starts.
//! So instead of estimating a tempo from the music, this reads the clicks:
//!
//! 1. find every click and measure its level and apparent pitch;
//! 2. group the clicks into classes (accent, beat, subdivision);
//! 3. drop subdivisions, take the accents as downbeats;
//! 4. cut the beats into bars and the bars into constant-tempo segments.
//!
//! Segments always start on a downbeat. The engine's metronome restarts the
//! bar at every tempo marker (`timing_segment_start` in
//! `metronome_renderer.cpp`), so a marker anywhere else would make the app's
//! click disagree with the multitrack's.

use serde::Serialize;

/// Largest distance from a beat to the straight line fitted through its
/// segment before the segment is cut. A generated click sits within a
/// millisecond of its grid; 10 ms still keeps a sloppy bounce together.
const MAX_FIT_RESIDUAL_SECONDS: f64 = 0.010;
/// Largest drift a rounded BPM may build up across its segment.
const MAX_ROUNDING_DRIFT_SECONDS: f64 = 0.008;
/// Shortest gap between two clicks: a 16th at 300 BPM is 50 ms.
const REFRACTORY_SECONDS: f64 = 0.050;
/// Part of each click its features are measured on.
const FEATURE_WINDOW_SECONDS: f64 = 0.015;
/// Smallest pitch jump that may separate two click sounds (~1/3 semitone).
/// The real test is the jump against the spread inside each group, see
/// `feature_levels`.
const PITCH_GAP_OCTAVES: f64 = 0.03;
/// Smallest level jump that may separate two click sounds. Real clicks have
/// shown beats only 2.3 dB above their off-beats.
const LEVEL_GAP_DB: f64 = 1.0;
/// A group split must jump this many times the spread of either side.
const SPLIT_OVER_SPREAD: f64 = 2.0;
/// Below this pulse, 3, 6, 9 or 12 clicks per accent are eighths of a
/// compound meter (6/8 at 74 is an eighth every 0.405 s).
const COMPOUND_EIGHTH_MAX_SECONDS: f64 = 0.45;
/// Clicks closer than this (over 270 a minute) are subdivisions: the beat is
/// every other one. A real 6/8 at 76 clicked in sixteenths runs at 0.197 s.
const SUBDIVISION_MAX_SECONDS: f64 = 0.22;
/// The same for a click without accent: nothing says it is a compound meter,
/// so anything over 200 a minute is read as eighths (128 BPM clicked in
/// eighths is 0.234 s).
const UNACCENTED_SUBDIVISION_MAX_SECONDS: f64 = 0.3;
/// Fewer beats than this is not a click track.
const MIN_BEATS: usize = 4;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoSegment {
    /// First downbeat of the segment, in seconds from the start of the
    /// analysed audio.
    pub start_seconds: f64,
    /// Quarter-note BPM, the unit `Song::bpm` uses whatever the meter.
    pub bpm: f64,
    pub beats_per_bar: u32,
    pub beat_unit: u32,
    /// Bars the segment spans (the last one may be incomplete).
    pub bars: u32,
}

impl TempoSegment {
    pub fn signature(&self) -> String {
        format!("{}/{}", self.beats_per_bar, self.beat_unit)
    }

    pub fn beat_seconds(&self) -> f64 {
        240.0 / (self.bpm * f64::from(self.beat_unit))
    }

    pub fn bar_seconds(&self) -> f64 {
        self.beat_seconds() * f64::from(self.beats_per_bar)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClickWarningKind {
    /// No click in the audio.
    NoClick,
    /// Every click sounds the same: where the bar starts is a guess.
    NoAccent,
    /// The click stops and starts again inside the song.
    ClickGap,
    /// The tempo changes bar after bar (ritardando, accelerando).
    VariableTempo,
    /// One bar of a different length between bars of the same meter.
    IrregularBar,
    /// Eighths accented every three were read as 6/8: which accent starts
    /// the bar is a guess.
    CompoundGuess,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickWarning {
    pub seconds: f64,
    pub kind: ClickWarningKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickAnalysis {
    pub segments: Vec<TempoSegment>,
    pub warnings: Vec<ClickWarning>,
    pub beat_count: usize,
    /// false: no accent, bars counted from the first click.
    pub downbeat_known: bool,
}

/// Analyse a mono click track. `fallback_beats_per_bar` is the meter used when
/// the click has no accent (normally the song's current numerator).
pub fn analyze_click(
    samples: &[f32],
    sample_rate: u32,
    fallback_beats_per_bar: u32,
) -> ClickAnalysis {
    let onsets = detect_onsets(samples, sample_rate);
    let (beats, downbeat_known) = classify(&onsets);
    let beats = if downbeat_known {
        beats
    } else {
        fold_subdivisions(beats, UNACCENTED_SUBDIVISION_MAX_SECONDS)
    };
    let mut warnings = Vec::new();
    if beats.len() < MIN_BEATS {
        warnings.push(ClickWarning {
            seconds: 0.0,
            kind: ClickWarningKind::NoClick,
        });
        return ClickAnalysis {
            segments: Vec::new(),
            warnings,
            beat_count: beats.len(),
            downbeat_known: false,
        };
    }
    if !downbeat_known {
        warnings.push(ClickWarning {
            seconds: beats[0].seconds,
            kind: ClickWarningKind::NoAccent,
        });
    }
    let bars = build_bars(
        &beats,
        downbeat_known,
        fallback_beats_per_bar.max(1),
        &mut warnings,
    );
    let segments = segment_bars(&bars, &mut warnings);
    flag_tempo_and_meter_oddities(&segments, &mut warnings);
    warnings.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
    ClickAnalysis {
        segments,
        warnings,
        beat_count: beats.len(),
        downbeat_known,
    }
}

// ── 1. Clicks ───────────────────────────────────────────────────────────────

/// (seconds, level dB, apparent pitch Hz) of every click, for the
/// `analyze_click` example's `--onsets` dump. Not part of the analysis API.
#[doc(hidden)]
pub fn debug_onsets(samples: &[f32], sample_rate: u32) -> Vec<(f64, f64, f64)> {
    detect_onsets(samples, sample_rate)
        .into_iter()
        .map(|onset| (onset.seconds, onset.level_db, onset.pitch_octaves.exp2()))
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct Onset {
    seconds: f64,
    level_db: f64,
    pitch_octaves: f64,
}

fn detect_onsets(samples: &[f32], sample_rate: u32) -> Vec<Onset> {
    let rate = f64::from(sample_rate.max(1));
    // A peak envelope at 1 ms: fine enough to find clicks, cheap on a whole song.
    let hop = ((rate / 1000.0).round() as usize).max(1);
    let envelope: Vec<f32> = samples
        .chunks(hop)
        .map(|chunk| chunk.iter().fold(0.0_f32, |max, x| max.max(x.abs())))
        .collect();
    let global_peak = envelope.iter().copied().fold(0.0_f32, f32::max);
    if global_peak < 1.0e-4 {
        return Vec::new();
    }
    // A click stem is mostly silence; the median is its noise floor (bleed,
    // dither). The 5 % floor keeps a quiet subdivision above the threshold.
    let threshold = (0.05 * global_peak).max(4.0 * median(&envelope));
    let release = 0.5 * threshold;
    let refractory_blocks = ((REFRACTORY_SECONDS * rate) as usize / hop).max(1);
    let window = ((FEATURE_WINDOW_SECONDS * rate) as usize).max(4);

    let mut onsets = Vec::new();
    let mut armed = true;
    let mut last_block: Option<usize> = None;
    for (block, &level) in envelope.iter().enumerate() {
        let in_refractory = last_block.is_some_and(|last| block < last + refractory_blocks);
        if !armed {
            // Re-arm only once the previous click's tail has died away.
            if level < release && !in_refractory {
                armed = true;
            }
            continue;
        }
        if level < threshold || in_refractory {
            continue;
        }
        armed = false;
        last_block = Some(block);

        let from = (block * hop).saturating_sub(2 * hop);
        let to = (block * hop + window).min(samples.len());
        let local_peak = samples[from..to]
            .iter()
            .fold(0.0_f32, |max, x| max.max(x.abs()));
        // The start, to the sample: the first one past a quarter of the peak.
        let onset = from
            + samples[from..to]
                .iter()
                .position(|x| x.abs() >= 0.25 * local_peak)
                .unwrap_or(0);
        let feature_end = (onset + window).min(samples.len());
        let frequency = zero_crossing_frequency(&samples[onset..feature_end], local_peak, rate);
        onsets.push(Onset {
            seconds: onset as f64 / rate,
            level_db: 20.0 * f64::from(local_peak.max(1.0e-9)).log10(),
            pitch_octaves: frequency.max(1.0).log2(),
        });
    }
    onsets
}

/// Apparent pitch from zero crossings, with hysteresis so the decaying tail
/// does not add crossings of its own.
fn zero_crossing_frequency(window: &[f32], peak: f32, rate: f64) -> f64 {
    if window.len() < 2 {
        return 0.0;
    }
    let hysteresis = 0.05 * peak;
    let mut sign = 0_i8;
    let mut crossings = 0_usize;
    for &x in window {
        let current = if x > hysteresis {
            1
        } else if x < -hysteresis {
            -1
        } else {
            continue;
        };
        if sign != 0 && current != sign {
            crossings += 1;
        }
        sign = current;
    }
    crossings as f64 * rate / (2.0 * window.len() as f64)
}

fn median(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    let middle = sorted.len() / 2;
    sorted.select_nth_unstable_by(middle, f32::total_cmp);
    sorted[middle]
}

// ── 2–3. Classes, subdivisions and downbeats ────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct Beat {
    seconds: f64,
    downbeat: bool,
}

/// Spread of a sorted run, ignoring its outer 5 % on each side (a stray
/// click must not make a whole group look noisy).
fn spread(sorted: &[f64]) -> f64 {
    if sorted.len() < 2 {
        return 0.0;
    }
    let trim = sorted.len() / 20;
    sorted[sorted.len() - 1 - trim] - sorted[trim]
}

/// Levels of one feature (0 = lowest). A group is split at the jump between
/// two neighbours (in sorted order) when the jump is above `min_gap` AND well
/// above the spread inside both halves: a real click measures its own pitch
/// with ±10 % of noise, so a fixed threshold either misses quiet accents or
/// splits one sound in two at random. At most three levels; each must hold a
/// few clicks.
fn feature_levels(values: &[f64], min_gap: f64) -> Vec<usize> {
    let n = values.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|a, b| values[*a].total_cmp(&values[*b]));
    let sorted: Vec<f64> = order.iter().map(|&index| values[index]).collect();
    let min_members = (n / 50).max(2);

    // Groups as [start, end) ranges of `sorted`.
    let mut groups: Vec<(usize, usize)> = vec![(0, n)];
    while groups.len() < 3 {
        let mut best: Option<(usize, usize, f64)> = None;
        for (group, &(start, end)) in groups.iter().enumerate() {
            if end - start < 2 * min_members {
                continue;
            }
            for split in (start + min_members)..=(end - min_members) {
                let gap = sorted[split] - sorted[split - 1];
                if gap <= min_gap {
                    continue;
                }
                let noise = spread(&sorted[start..split]).max(spread(&sorted[split..end]));
                let ratio = gap / noise.max(1.0e-9);
                if ratio > SPLIT_OVER_SPREAD && best.is_none_or(|(_, _, r)| ratio > r) {
                    best = Some((group, split, ratio));
                }
            }
        }
        let Some((group, split, _)) = best else { break };
        let (start, end) = groups[group];
        groups[group] = (start, split);
        groups.insert(group + 1, (split, end));
    }

    let mut levels = vec![0; n];
    for (level, &(start, end)) in groups.iter().enumerate() {
        for &index in &order[start..end] {
            levels[index] = level;
        }
    }
    levels
}

fn classify(onsets: &[Onset]) -> (Vec<Beat>, bool) {
    let n = onsets.len();
    let all_beats = |downbeat: &dyn Fn(usize) -> bool| -> Vec<Beat> {
        onsets
            .iter()
            .enumerate()
            .map(|(index, onset)| Beat {
                seconds: onset.seconds,
                downbeat: downbeat(index),
            })
            .collect()
    };
    if n < MIN_BEATS {
        return (all_beats(&|_| false), false);
    }

    let pitch = feature_levels(
        &onsets.iter().map(|o| o.pitch_octaves).collect::<Vec<_>>(),
        PITCH_GAP_OCTAVES,
    );
    let level = feature_levels(
        &onsets.iter().map(|o| o.level_db).collect::<Vec<_>>(),
        LEVEL_GAP_DB,
    );
    // Classes from most to least salient: higher pitch first, then louder.
    let mut keys: Vec<(usize, usize)> = (0..n).map(|i| (pitch[i], level[i])).collect();
    keys.sort_unstable();
    keys.dedup();
    keys.reverse();
    let class_of: Vec<usize> = (0..n)
        .map(|i| {
            keys.iter()
                .position(|key| *key == (pitch[i], level[i]))
                .unwrap_or(0)
        })
        .collect();
    let count = |class: usize| class_of.iter().filter(|c| **c == class).count();

    if keys.len() < 2 || count(0) * 10 > n * 6 {
        return (all_beats(&|_| false), false);
    }

    // Subdivisions: the least salient of three or more classes, if dropping
    // it leaves a regular grid with more beats than accents. With only two
    // classes "accent + beats" and "beats + subdivisions" look the same, and
    // the tempo check below sorts them out.
    let mut keep: Vec<bool> = vec![true; n];
    if keys.len() >= 3 {
        let weakest = keys.len() - 1;
        let accents = count(0);
        let weak = count(weakest);
        let rest = n - weak;
        let rest_times: Vec<f64> = (0..n)
            .filter(|i| class_of[*i] != weakest)
            .map(|i| onsets[i].seconds)
            .collect();
        if (rest - accents) as f64 >= 1.5 * accents as f64
            && weak as f64 >= 0.9 * rest as f64
            && is_regular(&rest_times)
        {
            for (index, class) in class_of.iter().enumerate() {
                if *class == weakest {
                    keep[index] = false;
                }
            }
        }
    }

    let beats: Vec<Beat> = (0..n)
        .filter(|i| keep[*i])
        .map(|i| Beat {
            seconds: onsets[i].seconds,
            downbeat: class_of[i] == 0,
        })
        .collect();

    // Strong and weak clicks taking turns are a beat and its off-beat (a
    // ballad at 79 clicked in eighths), not bars of two: seen on real
    // multitracks, where a 2/4 bar accent is the rare case. Kept as bars only
    // when the "beat" would be slower than 40 BPM.
    let accent_times: Vec<f64> = beats
        .iter()
        .filter(|b| b.downbeat)
        .map(|b| b.seconds)
        .collect();
    let accent_period = median_interval(&accent_times);
    let beats_per_accent = beats.len() as f64 / accent_times.len().max(1) as f64;
    if accent_period.is_some_and(|period| (0.3..=1.5).contains(&period))
        && (beats_per_accent - 2.0).abs() < 0.25
    {
        let beats = accent_times
            .iter()
            .map(|&seconds| Beat {
                seconds,
                downbeat: false,
            })
            .collect();
        return (beats, false);
    }
    (fold_subdivisions(beats, SUBDIVISION_MAX_SECONDS), true)
}

/// Keep every other click, counted from each accent, while the clicks are
/// too fast to be beats: under `SUBDIVISION_MAX_SECONDS` apart, or 8 or 16 to
/// an accent (eighths of a 4/4 that all sound alike).
fn fold_subdivisions(mut beats: Vec<Beat>, max_subdivision_seconds: f64) -> Vec<Beat> {
    for _ in 0..3 {
        let times: Vec<f64> = beats.iter().map(|b| b.seconds).collect();
        let Some(period) = median_interval(&times) else {
            break;
        };
        let accents = beats.iter().filter(|b| b.downbeat).count().max(1);
        let per_accent = (beats.len() as f64 / accents as f64).round() as usize;
        let accented = beats.iter().any(|b| b.downbeat);
        let too_fast = period < max_subdivision_seconds
            || (accented && matches!(per_accent, 8 | 16) && period < COMPOUND_EIGHTH_MAX_SECONDS);
        if !too_fast || (accented && per_accent % 2 != 0) {
            break;
        }
        let mut offset = 0_usize;
        beats.retain(|beat| {
            if beat.downbeat {
                offset = 0;
            }
            let keep = offset % 2 == 0;
            offset += 1;
            keep
        });
    }
    beats
}

fn median_interval(times: &[f64]) -> Option<f64> {
    if times.len() < 2 {
        return None;
    }
    let mut intervals: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    intervals.sort_by(f64::total_cmp);
    Some(intervals[intervals.len() / 2])
}

/// At least 80 % of the intervals within 20 % of the median.
fn is_regular(times: &[f64]) -> bool {
    let Some(median) = median_interval(times) else {
        return false;
    };
    let intervals: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    let close = intervals
        .iter()
        .filter(|interval| (**interval - median).abs() <= 0.2 * median)
        .count();
    close * 5 >= intervals.len() * 4
}

// ── 4. Bars and segments ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Bar {
    beats: Vec<f64>,
    /// The next bar starts right where this one ends (no gap in the click).
    continues: bool,
}

/// A gap: an interval much longer than the ones around it. A tempo halving is
/// not a gap, because the interval after it is just as long.
fn is_gap(beats: &[Beat], index: usize) -> bool {
    let interval = beats[index].seconds - beats[index - 1].seconds;
    let previous = (index >= 2).then(|| beats[index - 1].seconds - beats[index - 2].seconds);
    let next = beats
        .get(index + 1)
        .map(|beat| beat.seconds - beats[index].seconds);
    match (previous, next) {
        (Some(p), Some(n)) => interval > 1.8 * p && interval > 1.8 * n,
        (Some(p), None) => interval > 1.8 * p,
        (None, Some(n)) => interval > 1.8 * n,
        (None, None) => false,
    }
}

fn build_bars(
    beats: &[Beat],
    downbeat_known: bool,
    fallback_beats_per_bar: u32,
    warnings: &mut Vec<ClickWarning>,
) -> Vec<Bar> {
    let mut bars: Vec<Bar> = Vec::new();
    let mut current: Option<Bar> = None;
    for (index, beat) in beats.iter().enumerate() {
        let gap = index > 0 && is_gap(beats, index);
        if gap {
            warnings.push(ClickWarning {
                seconds: beats[index - 1].seconds,
                kind: ClickWarningKind::ClickGap,
            });
            if let Some(mut bar) = current.take() {
                bar.continues = false;
                bars.push(bar);
            }
        }
        let starts_bar = match &current {
            None => !downbeat_known || beat.downbeat,
            Some(bar) => {
                if downbeat_known {
                    beat.downbeat
                } else {
                    bar.beats.len() as u32 >= fallback_beats_per_bar
                }
            }
        };
        if starts_bar {
            if let Some(bar) = current.take() {
                bars.push(bar);
            }
            current = Some(Bar {
                beats: vec![beat.seconds],
                continues: true,
            });
        } else if let Some(bar) = current.as_mut() {
            bar.beats.push(beat.seconds);
        }
        // Beats before the first downbeat (a pickup) belong to no bar.
    }
    if let Some(mut bar) = current {
        bar.continues = false;
        bars.push(bar);
    }
    bars
}

/// Least-squares line through `times` against their index: (intercept,
/// period, largest residual).
fn fit_line(times: &[f64]) -> (f64, f64, f64) {
    let n = times.len() as f64;
    if times.len() < 2 {
        return (times.first().copied().unwrap_or(0.0), 0.0, 0.0);
    }
    let mean_k = (n - 1.0) / 2.0;
    let mean_t = times.iter().sum::<f64>() / n;
    let mut covariance = 0.0;
    let mut variance = 0.0;
    for (k, t) in times.iter().enumerate() {
        let dk = k as f64 - mean_k;
        covariance += dk * (t - mean_t);
        variance += dk * dk;
    }
    let period = covariance / variance;
    let intercept = mean_t - period * mean_k;
    let residual = times
        .iter()
        .enumerate()
        .map(|(k, t)| (t - (intercept + period * k as f64)).abs())
        .fold(0.0, f64::max);
    (intercept, period, residual)
}

struct SegmentDraft {
    times: Vec<f64>,
    beats_per_bar: u32,
    bars: u32,
}

fn segment_bars(bars: &[Bar], warnings: &mut Vec<ClickWarning>) -> Vec<TempoSegment> {
    let mut drafts: Vec<SegmentDraft> = Vec::new();
    let mut current: Option<SegmentDraft> = None;
    let mut previous_continues = false;
    for bar in bars {
        let length = bar.beats.len() as u32;
        let joins = current.as_ref().is_some_and(|draft| {
            // The last bar before a gap or the end may be cut short.
            let fits_meter = if bar.continues {
                length == draft.beats_per_bar
            } else {
                length <= draft.beats_per_bar
            };
            previous_continues && fits_meter && {
                let mut times = draft.times.clone();
                times.extend_from_slice(&bar.beats);
                fit_line(&times).2 <= MAX_FIT_RESIDUAL_SECONDS
            }
        });
        if joins {
            if let Some(draft) = current.as_mut() {
                draft.times.extend_from_slice(&bar.beats);
                draft.bars += 1;
            }
        } else {
            // A last bar cut short (the song's final hit after a ritardando)
            // keeps the meter it was in.
            let beats_per_bar = match current.as_ref() {
                Some(previous) if !bar.continues && length < previous.beats_per_bar => {
                    previous.beats_per_bar
                }
                _ => length,
            };
            if let Some(draft) = current.take() {
                drafts.push(draft);
            }
            current = Some(SegmentDraft {
                times: bar.beats.clone(),
                beats_per_bar,
                bars: 1,
            });
        }
        previous_continues = bar.continues;
    }
    if let Some(draft) = current {
        drafts.push(draft);
    }

    let mut segments: Vec<TempoSegment> = Vec::new();
    for draft in drafts {
        let period = if draft.times.len() >= 2 {
            fit_line(&draft.times).1
        } else if let Some(previous) = segments.last() {
            // A lone click (a final hit): the tempo it was played at.
            previous.beat_seconds()
        } else {
            continue;
        };
        if !(period.is_finite() && period > 0.0) {
            continue;
        }
        // Compound meters are clicked in eighths: 6, 9 or 12 fast clicks a
        // bar, or an accent every 3 (on 1 and 4 of a 6/8).
        let compound = period < COMPOUND_EIGHTH_MAX_SECONDS;
        let (beats_per_bar, beat_unit, bars) = match draft.beats_per_bar.max(1) {
            n @ (6 | 9 | 12) if compound => (n, 8, draft.bars),
            3 if compound => (6, 8, draft.bars.div_ceil(2)),
            n => (n, 4, draft.bars),
        };
        let (start_seconds, bpm) = round_tempo(&draft.times, period, beat_unit);
        if draft.beats_per_bar == 3 && beat_unit == 8 {
            warnings.push(ClickWarning {
                seconds: start_seconds,
                kind: ClickWarningKind::CompoundGuess,
            });
        }
        segments.push(TempoSegment {
            start_seconds,
            bpm,
            beats_per_bar,
            beat_unit,
            bars,
        });
    }
    segments
}

/// The coarsest BPM (whole, half, tenth, hundredth) that still lands every
/// beat within `MAX_ROUNDING_DRIFT_SECONDS`, and the start that goes with it.
fn round_tempo(times: &[f64], period: f64, beat_unit: u32) -> (f64, f64) {
    let unit = f64::from(beat_unit);
    let raw_bpm = 240.0 / (period * unit);
    let fit = |bpm: f64| {
        let rounded_period = 240.0 / (bpm * unit);
        let intercept = times
            .iter()
            .enumerate()
            .map(|(k, t)| t - k as f64 * rounded_period)
            .sum::<f64>()
            / times.len().max(1) as f64;
        let drift = times
            .iter()
            .enumerate()
            .map(|(k, t)| (t - (intercept + k as f64 * rounded_period)).abs())
            .fold(0.0, f64::max);
        (intercept, drift)
    };
    let mut fallback = None;
    for step in [1.0, 0.5, 0.1, 0.01] {
        let bpm = (raw_bpm / step).round() * step;
        // Strip float noise: 92.50000000001 → 92.5.
        let bpm = (bpm * 100.0).round() / 100.0;
        let (intercept, drift) = fit(bpm);
        if drift <= MAX_ROUNDING_DRIFT_SECONDS || times.len() < 2 {
            return (intercept, bpm);
        }
        fallback = Some((intercept, bpm));
    }
    fallback.unwrap_or((times.first().copied().unwrap_or(0.0), raw_bpm))
}

fn flag_tempo_and_meter_oddities(segments: &[TempoSegment], warnings: &mut Vec<ClickWarning>) {
    // Three or more one-bar segments in a row: the tempo is drifting.
    let mut run_start: Option<usize> = None;
    for index in 0..=segments.len() {
        let short = segments.get(index).is_some_and(|s| s.bars == 1);
        match (short, run_start) {
            (true, None) => run_start = Some(index),
            (false, Some(start)) => {
                if index - start >= 3 {
                    warnings.push(ClickWarning {
                        seconds: segments[start].start_seconds,
                        kind: ClickWarningKind::VariableTempo,
                    });
                }
                run_start = None;
            }
            _ => {}
        }
    }
    // A lone bar of another meter between two of the same.
    for window in segments.windows(3) {
        let [before, odd, after] = window else {
            continue;
        };
        if odd.bars == 1
            && before.beats_per_bar == after.beats_per_bar
            && odd.beats_per_bar != before.beats_per_bar
        {
            warnings.push(ClickWarning {
                seconds: odd.start_seconds,
                kind: ClickWarningKind::IrregularBar,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const HIGH: f64 = 1500.0;
    const LOW: f64 = 1000.0;

    /// A click: a decaying sine burst, like most generated click sounds.
    fn add_click(buffer: &mut [f32], seconds: f64, frequency: f64, amplitude: f32) {
        let start = (seconds * f64::from(RATE)).round() as usize;
        let length = (0.030 * f64::from(RATE)) as usize;
        for i in 0..length {
            let Some(sample) = buffer.get_mut(start + i) else {
                break;
            };
            let t = i as f64 / f64::from(RATE);
            let envelope = (-t / 0.006).exp();
            *sample +=
                amplitude * (envelope * (std::f64::consts::TAU * frequency * t).sin()) as f32;
        }
    }

    struct Click {
        seconds: f64,
        frequency: f64,
        amplitude: f32,
    }

    fn render(clicks: &[Click]) -> Vec<f32> {
        let end = clicks.iter().map(|c| c.seconds).fold(0.0, f64::max) + 1.0;
        let mut buffer = vec![0.0_f32; (end * f64::from(RATE)) as usize];
        for click in clicks {
            add_click(&mut buffer, click.seconds, click.frequency, click.amplitude);
        }
        buffer
    }

    /// `bars` bars at `bpm` (beat-unit BPM) from `start`, accent on beat 1.
    fn bars_at(start: f64, bpm: f64, beats_per_bar: u32, bars: u32) -> (Vec<Click>, f64) {
        let period = 60.0 / bpm;
        let mut clicks = Vec::new();
        let mut t = start;
        for _ in 0..bars {
            for beat in 0..beats_per_bar {
                clicks.push(Click {
                    seconds: t,
                    frequency: if beat == 0 { HIGH } else { LOW },
                    amplitude: 0.8,
                });
                t += period;
            }
        }
        (clicks, t)
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected}, got {actual}"
        );
    }

    fn kinds(analysis: &ClickAnalysis) -> Vec<ClickWarningKind> {
        analysis.warnings.iter().map(|w| w.kind).collect()
    }

    #[test]
    fn steady_four_four_click_is_one_segment() {
        let (clicks, _) = bars_at(0.5, 120.0, 4, 16);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(analysis.downbeat_known);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        let segment = &analysis.segments[0];
        assert_eq!(segment.bpm, 120.0);
        assert_eq!(segment.signature(), "4/4");
        assert_eq!(segment.bars, 16);
        assert_close(segment.start_seconds, 0.5, 0.001);
        assert!(analysis.warnings.is_empty(), "{:?}", analysis.warnings);
    }

    #[test]
    fn accent_every_three_beats_is_three_four() {
        let (clicks, _) = bars_at(0.0, 100.0, 3, 12);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 100.0);
        assert_eq!(analysis.segments[0].signature(), "3/4");
    }

    #[test]
    fn tempo_change_starts_a_segment_on_the_new_downbeat() {
        let (mut clicks, end) = bars_at(0.5, 120.0, 4, 8);
        let (more, _) = bars_at(end, 90.0, 4, 8);
        clicks.extend(more);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 2, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 120.0);
        assert_eq!(analysis.segments[0].bars, 8);
        assert_eq!(analysis.segments[1].bpm, 90.0);
        assert_close(analysis.segments[1].start_seconds, 0.5 + 8.0 * 2.0, 0.001);
    }

    #[test]
    fn six_fast_clicks_per_bar_is_six_eight_in_quarter_bpm() {
        // Eighths at 0.25 s: quarter = 0.5 s = 120 BPM.
        let (clicks, _) = bars_at(0.0, 240.0, 6, 8);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].signature(), "6/8");
        assert_eq!(analysis.segments[0].bpm, 120.0);
    }

    #[test]
    fn quieter_subdivisions_are_ignored() {
        let (mut clicks, _) = bars_at(0.0, 100.0, 4, 8);
        let half = 0.3;
        let offbeats: Vec<Click> = clicks
            .iter()
            .map(|c| Click {
                seconds: c.seconds + half,
                frequency: LOW,
                amplitude: 0.25,
            })
            .collect();
        clicks.extend(offbeats);
        clicks.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 100.0);
        assert_eq!(analysis.segments[0].signature(), "4/4");
    }

    #[test]
    fn click_without_accent_keeps_the_fallback_meter_and_warns() {
        let clicks: Vec<Click> = (0..32)
            .map(|i| Click {
                seconds: 0.25 + i as f64 * 0.5,
                frequency: LOW,
                amplitude: 0.8,
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 3);
        assert!(!analysis.downbeat_known);
        assert!(kinds(&analysis).contains(&ClickWarningKind::NoAccent));
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 120.0);
        assert_eq!(analysis.segments[0].signature(), "3/4");
        assert_close(analysis.segments[0].start_seconds, 0.25, 0.001);
    }

    #[test]
    fn silence_is_no_click() {
        let analysis = analyze_click(&vec![0.0; RATE as usize * 5], RATE, 4);
        assert!(analysis.segments.is_empty());
        assert_eq!(kinds(&analysis), vec![ClickWarningKind::NoClick]);
    }

    #[test]
    fn half_bpm_is_kept_when_the_click_needs_it() {
        let (clicks, _) = bars_at(0.0, 92.5, 4, 16);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 92.5);
    }

    #[test]
    fn ritardando_warns_of_variable_tempo() {
        let (mut clicks, mut t) = bars_at(0.0, 120.0, 4, 8);
        let mut period = 0.5;
        for _ in 0..5 {
            for beat in 0..4 {
                clicks.push(Click {
                    seconds: t,
                    frequency: if beat == 0 { HIGH } else { LOW },
                    amplitude: 0.8,
                });
                t += period;
                period *= 1.04;
            }
        }
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(
            kinds(&analysis).contains(&ClickWarningKind::VariableTempo),
            "{analysis:?}"
        );
        assert_eq!(analysis.segments[0].bpm, 120.0);
    }

    #[test]
    fn a_gap_in_the_click_warns_and_restarts() {
        let (mut clicks, end) = bars_at(0.0, 120.0, 4, 8);
        let (more, _) = bars_at(end + 7.3, 120.0, 4, 8);
        clicks.extend(more);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(kinds(&analysis).contains(&ClickWarningKind::ClickGap));
        assert_eq!(analysis.segments.len(), 2, "{analysis:?}");
        assert_close(analysis.segments[1].start_seconds, end + 7.3, 0.001);
    }

    #[test]
    fn a_lone_two_four_bar_is_flagged() {
        let (mut clicks, end) = bars_at(0.0, 120.0, 4, 4);
        let (odd, end) = bars_at(end, 120.0, 2, 1);
        let (rest, _) = bars_at(end, 120.0, 4, 4);
        clicks.extend(odd);
        clicks.extend(rest);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        let signatures: Vec<String> = analysis.segments.iter().map(|s| s.signature()).collect();
        assert_eq!(signatures, vec!["4/4", "2/4", "4/4"]);
        assert!(kinds(&analysis).contains(&ClickWarningKind::IrregularBar));
    }

    #[test]
    fn sixteenths_under_a_dotted_quarter_accent_fold_to_six_eight() {
        // A real 6/8 at 76: clicks every 0.197 s, accent every six. The beat
        // is every other click: eighths of 0.395 s, accent every three.
        let clicks: Vec<Click> = (0..96)
            .map(|i| Click {
                seconds: i as f64 * 0.1975,
                frequency: if i % 6 == 0 { 2000.0 } else { LOW },
                amplitude: 0.8,
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].signature(), "6/8");
        assert_close(analysis.segments[0].bpm, 76.0, 0.05);
        assert!(kinds(&analysis).contains(&ClickWarningKind::CompoundGuess));
    }

    #[test]
    fn strong_and_weak_clicks_taking_turns_are_beats_and_off_beats() {
        // A ballad at 79 clicked in eighths: beats 2.3 dB above off-beats,
        // with the beat's pitch wobbling (as measured on a real stem).
        let clicks: Vec<Click> = (0..120)
            .map(|i| {
                let on_beat = i % 2 == 0;
                Click {
                    seconds: i as f64 * 60.0 / 158.0,
                    frequency: if on_beat {
                        [967.0, 901.0, 867.0][i % 3]
                    } else {
                        834.0
                    },
                    amplitude: if on_beat { 0.67 } else { 0.51 },
                }
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 79.0);
        assert_eq!(analysis.segments[0].signature(), "4/4");
        assert!(!analysis.downbeat_known);
    }

    #[test]
    fn unaccented_clicks_over_200_a_minute_are_eighths() {
        let clicks: Vec<Click> = (0..64)
            .map(|i| Click {
                seconds: i as f64 * 60.0 / 256.0,
                frequency: LOW,
                amplitude: 0.8,
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments[0].bpm, 128.0, "{analysis:?}");
    }

    #[test]
    fn a_final_hit_after_the_last_bar_keeps_the_meter() {
        let (mut clicks, end) = bars_at(0.0, 120.0, 4, 8);
        // One last accented hit, late (a held ending).
        clicks.push(Click {
            seconds: end + 0.9,
            frequency: HIGH,
            amplitude: 0.8,
        });
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(
            analysis.segments.iter().all(|s| s.signature() == "4/4"),
            "{analysis:?}"
        );
    }

    #[test]
    fn low_noise_floor_does_not_add_clicks() {
        let (clicks, _) = bars_at(0.5, 120.0, 4, 8);
        let mut buffer = render(&clicks);
        let mut seed = 12345_u32;
        for sample in &mut buffer {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            *sample += ((seed >> 16) as f32 / 32768.0 - 1.0) * 0.002;
        }
        let analysis = analyze_click(&buffer, RATE, 4);
        assert_eq!(analysis.beat_count, 32);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 120.0);
    }
}
