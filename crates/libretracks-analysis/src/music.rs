//! Tempo estimated from the music, for songs whose multitrack has no click.
//!
//! 1. An onset envelope: how much the log spectrum rises from one frame to the
//!    next (spectral flux), every ~12 ms.
//! 2. The tempo: the envelope's autocorrelation, combed over the beat's
//!    multiples and weighted towards common tempos, picks the beat period.
//! 3. The beats: dynamic programming (Ellis 2007) lays a beat on the strong
//!    onsets while keeping the spacing close to that period.
//! 4. The bar: the beat phase where the low end (kick, bass) hits hardest is
//!    taken as beat 1. A guess, and reported as one.
//!
//! The result is ONE tempo for the whole song, fitted through every beat. A
//! multitrack without its click was still almost always recorded to one, so
//! its tempo is constant; fitting segment by segment as with a click cut real
//! songs into dozens of pieces on the band's natural looseness. When the beats
//! stray far from that one tempo, the song is flagged as variable.

use crate::click::{ClickAnalysis, ClickWarning, ClickWarningKind, TempoSegment};
use crate::dsp::decimate;
use crate::fft::fft;

const FRAME: usize = 1024;
const HOP: usize = 128;
/// Spectral flux range: below, rumble; above, cymbal hiss that blurs beats.
const FLUX_MIN_HZ: f64 = 30.0;
const FLUX_MAX_HZ: f64 = 5000.0;
/// The low end used to find beat 1 (kick and bass).
const LOW_MAX_HZ: f64 = 200.0;
/// Tempo search range.
const MIN_BPM: f64 = 50.0;
const MAX_BPM: f64 = 200.0;
/// Tempo preference: a log-normal around this BPM, one octave wide. Breaks
/// the tie between a tempo and its half or double. Chosen with
/// `TempoScoring` by a sweep over 11 real songs with click (see the plan):
/// worship ballads (63-79) are common, so the centre sits low.
const PRIOR_CENTER_BPM: f64 = 90.0;
const PRIOR_OCTAVES: f64 = 1.0;
/// How strongly the beat tracker sticks to the period (librosa's default).
const TIGHTNESS: f64 = 100.0;
/// Below this tempogram peak contrast the tempo is reported as doubtful.
const CONFIDENT_CONTRAST: f64 = 2.5;

/// How the tempogram is scored: the autocorrelation at the beat period, plus
/// some of it at twice and four times the period (a real beat lines up with
/// its bar), times a log-normal preference around `center_bpm`.
#[derive(Debug, Clone, Copy)]
pub struct TempoScoring {
    pub double_weight: f64,
    pub quadruple_weight: f64,
    pub center_bpm: f64,
    pub octaves: f64,
}

/// The sweep's best (9 of 11 right). Among the settings that tie, this one
/// misses by an octave (fixable with ×2 in the review) rather than by 4:3.
const TEMPO_SCORING: TempoScoring = TempoScoring {
    double_weight: 0.25,
    quadruple_weight: 0.0,
    center_bpm: PRIOR_CENTER_BPM,
    octaves: PRIOR_OCTAVES,
};
/// Fewer beats than this is not music with a pulse.
const MIN_BEATS: usize = 8;
/// Beats straying further than this (RMS) from the one fitted tempo: the
/// song speeds up or slows down, and one tempo does not describe it.
const VARIABLE_TEMPO_RMS_SECONDS: f64 = 0.06;
/// A rounded BPM is kept when it is this close to the fitted one (a
/// four-minute song pins its tempo to a few hundredths).
const ROUNDING_TOLERANCE_BPM: f64 = 0.08;
/// Where a beat really is, from the frame whose flux peaks. Measured against
/// the click on 9 real songs: the flux peaks a median 24 ms before the beat
/// sounds (the log spectrum jumps as soon as the attack enters the window).
const BEAT_DELAY_SECONDS: f64 = 0.024;
/// Beats further than this from the fitted grid (a beat laid on an off-beat
/// in a sparse passage) do not count for the fit.
const MIN_OUTLIER_SECONDS: f64 = 0.02;

/// Estimate the tempo map of a mono mix of the song's tracks (drums, bass,
/// everything but the cues). `fallback_beats_per_bar` is the meter assumed.
pub fn analyze_music_tempo(
    samples: &[f32],
    sample_rate: u32,
    fallback_beats_per_bar: u32,
) -> ClickAnalysis {
    let (signal, rate) = decimate(samples, f64::from(sample_rate.max(1)));
    let envelope = onset_envelope(&signal, rate);
    let fps = rate / HOP as f64;
    let mut warnings = vec![ClickWarning {
        seconds: 0.0,
        kind: ClickWarningKind::EstimatedWithoutClick,
    }];
    let no_pulse = |mut warnings: Vec<ClickWarning>| {
        warnings.push(ClickWarning {
            seconds: 0.0,
            kind: ClickWarningKind::NoClick,
        });
        ClickAnalysis {
            segments: Vec::new(),
            warnings,
            beat_count: 0,
            downbeat_known: false,
        }
    };
    let Some((period, contrast)) = estimate_period(&envelope.flux, fps, TEMPO_SCORING) else {
        return no_pulse(warnings);
    };
    if contrast < CONFIDENT_CONTRAST {
        warnings.push(ClickWarning {
            seconds: 0.0,
            kind: ClickWarningKind::UncertainTempo,
        });
    }
    let beat_frames = track_beats(&envelope.flux, period);
    if beat_frames.len() < MIN_BEATS {
        return no_pulse(warnings);
    }

    let beats_per_bar = fallback_beats_per_bar.max(1) as usize;
    let seconds_of = |frames: &[usize]| -> Vec<f64> {
        frames
            .iter()
            .map(|&frame| (frame * HOP + FRAME / 2) as f64 / rate + BEAT_DELAY_SECONDS)
            .collect()
    };
    let mut beat_frames = beat_frames;
    let mut times = seconds_of(&beat_frames);
    let mut fit = fit_grid(&times, period * HOP as f64 / rate);
    // The tracker holds the beats to the tempogram's period, which is only
    // as fine as its lag grid: track again with the fitted period, so a song
    // at 100 does not come out at 99.7.
    let retracked = track_beats(&envelope.flux, fit.period * rate / HOP as f64);
    if retracked.len() >= MIN_BEATS {
        let retimed = seconds_of(&retracked);
        let refit = fit_grid(&retimed, fit.period);
        if refit.inliers * 10 >= fit.inliers * 9 {
            fit = refit;
            times = retimed;
            beat_frames = retracked;
        }
    }
    let phase = downbeat_phase(&envelope.low, &beat_frames, beats_per_bar);
    let (intercept, beat_seconds) = (fit.intercept, fit.period);
    // Most beats far from one tempo: the band speeds up or slows down.
    if fit.rms > VARIABLE_TEMPO_RMS_SECONDS || fit.inliers * 5 < times.len() * 3 {
        warnings.push(ClickWarning {
            seconds: 0.0,
            kind: ClickWarningKind::VariableTempo,
        });
    }
    let bpm = round_bpm(60.0 / beat_seconds);
    // Re-anchor on the rounded tempo: the grid that best fits the beats.
    let rounded_beat = 60.0 / bpm;
    let grid_index = |t: f64| ((t - intercept) / beat_seconds).round();
    // Anchored on the beats that fit (the median resists the stray ones).
    let mut offsets: Vec<f64> = times
        .iter()
        .map(|&t| t - grid_index(t) * rounded_beat)
        .collect();
    offsets.sort_by(f64::total_cmp);
    let anchor = offsets[offsets.len() / 2];
    let first_downbeat_index = grid_index(times[phase.min(times.len() - 1)]);
    let start_seconds = anchor + first_downbeat_index * rounded_beat;
    let last_index = grid_index(*times.last().unwrap_or(&start_seconds));
    let bars = (((last_index - first_downbeat_index) / beats_per_bar as f64).floor() as u32) + 1;
    ClickAnalysis {
        segments: vec![TempoSegment {
            start_seconds,
            bpm,
            beats_per_bar: beats_per_bar as u32,
            beat_unit: 4,
            bars,
        }],
        warnings,
        beat_count: times.len(),
        downbeat_known: false,
    }
}

struct GridFit {
    intercept: f64,
    period: f64,
    /// RMS distance of the beats that fit.
    rms: f64,
    /// How many beats fit.
    inliers: usize,
}

/// Fit the beats to a regular grid: each beat gets the grid index nearest to
/// it (so a beat the tracker skipped or doubled does not bend the line), then
/// least squares, then again without the beats that land far off it.
fn fit_grid(times: &[f64], guess: f64) -> GridFit {
    let least_squares = |points: &[(f64, f64)]| -> Option<(f64, f64)> {
        let n = points.len() as f64;
        let mean_k = points.iter().map(|p| p.0).sum::<f64>() / n;
        let mean_t = points.iter().map(|p| p.1).sum::<f64>() / n;
        let (mut covariance, mut variance) = (0.0, 0.0);
        for (k, t) in points {
            covariance += (k - mean_k) * (t - mean_t);
            variance += (k - mean_k).powi(2);
        }
        (variance > 0.0).then(|| {
            let period = covariance / variance;
            (mean_t - period * mean_k, period)
        })
    };
    let mut period = guess;
    let mut intercept = times[0];
    let residual = |t: f64, intercept: f64, period: f64| {
        let k = ((t - intercept) / period).round();
        (k, t - (intercept + k * period))
    };
    // Twice on every beat: the first pass's period sharpens the indices.
    for _ in 0..2 {
        let points: Vec<(f64, f64)> = times
            .iter()
            .map(|&t| (residual(t, intercept, period).0, t))
            .collect();
        if let Some((i, p)) = least_squares(&points) {
            intercept = i;
            period = p;
        }
    }
    // Then without the stray beats: further than 2.5 robust deviations.
    let mut deviations: Vec<f64> = times
        .iter()
        .map(|&t| residual(t, intercept, period).1.abs())
        .collect();
    deviations.sort_by(f64::total_cmp);
    let mad = deviations[deviations.len() / 2] * 1.4826;
    let limit = (2.5 * mad).max(MIN_OUTLIER_SECONDS);
    let kept: Vec<(f64, f64)> = times
        .iter()
        .filter_map(|&t| {
            let (k, r) = residual(t, intercept, period);
            (r.abs() <= limit).then_some((k, t))
        })
        .collect();
    if kept.len() >= 2 {
        if let Some((i, p)) = least_squares(&kept) {
            intercept = i;
            period = p;
        }
    }
    let rms = (kept
        .iter()
        .map(|&(k, t)| (t - (intercept + k * period)).powi(2))
        .sum::<f64>()
        / kept.len().max(1) as f64)
        .sqrt();
    GridFit {
        intercept,
        period,
        rms,
        inliers: kept.len(),
    }
}

/// The coarsest of whole, half and tenth BPM within the tolerance, else two
/// decimals.
fn round_bpm(bpm: f64) -> f64 {
    for step in [1.0, 0.5, 0.1] {
        let rounded = (bpm / step).round() * step;
        if (rounded - bpm).abs() <= ROUNDING_TOLERANCE_BPM {
            return (rounded * 100.0).round() / 100.0;
        }
    }
    (bpm * 100.0).round() / 100.0
}

/// The best tempo candidates (BPM, score), for the example's `TEMPOGRAM=1`
/// dump. Not part of the analysis API.
#[doc(hidden)]
pub fn debug_tempogram(samples: &[f32], sample_rate: u32) -> Vec<(f64, f64, f64)> {
    let (signal, rate) = decimate(samples, f64::from(sample_rate.max(1)));
    let envelope = onset_envelope(&signal, rate);
    let fps = rate / HOP as f64;
    let flux = &envelope.flux;
    let autocorrelation = |lag: usize| -> f64 {
        if lag == 0 || lag >= flux.len() {
            return 0.0;
        }
        let pairs = flux.len() - lag;
        flux[..pairs]
            .iter()
            .zip(&flux[lag..])
            .map(|(a, b)| a * b)
            .sum::<f64>()
            / pairs as f64
    };
    let min_lag = (60.0 / 240.0 * fps).floor() as usize;
    let max_lag = (60.0 / 40.0 * fps).ceil() as usize;
    let mut peaks: Vec<(f64, f64, f64)> = Vec::new();
    for lag in min_lag + 1..max_lag {
        let (a, b, c) = (
            autocorrelation(lag - 1),
            autocorrelation(lag),
            autocorrelation(lag + 1),
        );
        if b > a && b >= c {
            peaks.push((60.0 * fps / lag as f64, b, b));
        }
    }
    peaks.sort_by(|x, y| y.1.total_cmp(&x.1));
    peaks.truncate(8);
    peaks
}

struct Envelope {
    /// Spectral flux, normalised (mean 0, unit deviation, negatives cut).
    flux: Vec<f64>,
    /// Flux of the low end only, for beat 1.
    low: Vec<f64>,
}

fn onset_envelope(signal: &[f32], rate: f64) -> Envelope {
    if signal.len() < FRAME * 2 {
        return Envelope {
            flux: Vec::new(),
            low: Vec::new(),
        };
    }
    let window: Vec<f32> = (0..FRAME)
        .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / FRAME as f64).cos()) as f32)
        .collect();
    let bin_hz = rate / FRAME as f64;
    let low_bin = ((FLUX_MIN_HZ / bin_hz).ceil() as usize).max(1);
    let high_bin = ((FLUX_MAX_HZ / bin_hz).floor() as usize).min(FRAME / 2);
    let bass_bin = ((LOW_MAX_HZ / bin_hz).floor() as usize).max(low_bin + 1);

    let frames = (signal.len() - FRAME) / HOP + 1;
    let mut flux = vec![0.0; frames];
    let mut low = vec![0.0; frames];
    let mut previous = vec![0.0_f64; high_bin + 1];
    let mut re = vec![0.0_f32; FRAME];
    let mut im = vec![0.0_f32; FRAME];
    for frame in 0..frames {
        let start = frame * HOP;
        for i in 0..FRAME {
            re[i] = signal[start + i] * window[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        let (mut total, mut bass) = (0.0, 0.0);
        for bin in low_bin..=high_bin {
            let magnitude = f64::from(re[bin] * re[bin] + im[bin] * im[bin]).sqrt();
            // Log compression: a soft hi-hat and a loud kick both count.
            let level = (1.0 + 1000.0 * magnitude).ln();
            let rise = (level - previous[bin]).max(0.0);
            previous[bin] = level;
            total += rise;
            if bin <= bass_bin {
                bass += rise;
            }
        }
        if frame > 0 {
            flux[frame] = total;
            low[frame] = bass;
        }
    }
    Envelope {
        flux: normalise(subtract_local_mean(&flux, 43)),
        low: normalise(subtract_local_mean(&low, 43)),
    }
}

/// Remove the slow level changes (a chorus is louder than a verse), keep the
/// onsets.
fn subtract_local_mean(values: &[f64], half_window: usize) -> Vec<f64> {
    let mut prefix = vec![0.0; values.len() + 1];
    for (i, value) in values.iter().enumerate() {
        prefix[i + 1] = prefix[i] + value;
    }
    (0..values.len())
        .map(|i| {
            let from = i.saturating_sub(half_window);
            let to = (i + half_window + 1).min(values.len());
            let mean = (prefix[to] - prefix[from]) / (to - from) as f64;
            (values[i] - mean).max(0.0)
        })
        .collect()
}

fn normalise(values: Vec<f64>) -> Vec<f64> {
    let n = values.len().max(1) as f64;
    let mean = values.iter().sum::<f64>() / n;
    let deviation = (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n).sqrt();
    if deviation <= 0.0 {
        return values;
    }
    values.iter().map(|v| v / deviation).collect()
}

/// The tempo `scoring` picks, in BPM, for the example's parameter sweep.
/// Not part of the analysis API.
#[doc(hidden)]
pub fn debug_pick_tempo(samples: &[f32], sample_rate: u32, scoring: TempoScoring) -> Option<f64> {
    let (signal, rate) = decimate(samples, f64::from(sample_rate.max(1)));
    let envelope = onset_envelope(&signal, rate);
    let fps = rate / HOP as f64;
    estimate_period(&envelope.flux, fps, scoring).map(|(period, _)| 60.0 * fps / period)
}

/// The beat period in frames and how much the winning peak stands out of the
/// tempogram (peak over median, in deviations).
fn estimate_period(envelope: &[f64], fps: f64, scoring: TempoScoring) -> Option<(f64, f64)> {
    let min_lag = (60.0 / MAX_BPM * fps).floor() as usize;
    let max_lag = (60.0 / MIN_BPM * fps).ceil() as usize;
    if envelope.len() < max_lag * 4 {
        return None;
    }
    let autocorrelation = |lag: usize| -> f64 {
        if lag == 0 || lag >= envelope.len() {
            return 0.0;
        }
        let pairs = envelope.len() - lag;
        envelope[..pairs]
            .iter()
            .zip(&envelope[lag..])
            .map(|(a, b)| a * b)
            .sum::<f64>()
            / pairs as f64
    };
    let scores: Vec<(usize, f64)> = (min_lag..=max_lag)
        .map(|lag| {
            let comb = autocorrelation(lag)
                + scoring.double_weight * autocorrelation(2 * lag)
                + scoring.quadruple_weight * autocorrelation(4 * lag);
            let bpm = 60.0 * fps / lag as f64;
            let octaves = (bpm / scoring.center_bpm).log2() / scoring.octaves;
            (lag, comb * (-0.5 * octaves * octaves).exp())
        })
        .collect();
    let (best_index, &(best_lag, best)) = scores
        .iter()
        .enumerate()
        .max_by(|a, b| a.1 .1.total_cmp(&b.1 .1))?;
    if best <= 0.0 {
        return None;
    }
    // Sub-frame period by parabolic interpolation.
    let period = match (
        scores.get(best_index.wrapping_sub(1)),
        scores.get(best_index + 1),
    ) {
        (Some(&(_, left)), Some(&(_, right))) => {
            let denominator = left - 2.0 * best + right;
            if denominator.abs() > 1e-12 {
                best_lag as f64 + (0.5 * (left - right) / denominator).clamp(-0.5, 0.5)
            } else {
                best_lag as f64
            }
        }
        _ => best_lag as f64,
    };
    let mut values: Vec<f64> = scores.iter().map(|s| s.1).collect();
    values.sort_by(f64::total_cmp);
    let median = values[values.len() / 2];
    let deviation =
        (values.iter().map(|v| (v - median).powi(2)).sum::<f64>() / values.len() as f64).sqrt();
    let contrast = if deviation > 0.0 {
        (best - median) / deviation
    } else {
        0.0
    };
    Some((period, contrast))
}

/// Ellis' dynamic-programming beat tracker: the frames of the beats.
fn track_beats(envelope: &[f64], period: f64) -> Vec<usize> {
    let n = envelope.len();
    if n == 0 || period < 2.0 {
        return Vec::new();
    }
    let mut score = vec![0.0_f64; n];
    let mut back = vec![usize::MAX; n];
    let reach_far = (2.0 * period).round() as usize;
    let reach_near = (period / 2.0).round().max(1.0) as usize;
    for t in 0..n {
        let mut best = 0.0;
        let mut best_previous = usize::MAX;
        if t >= reach_near {
            let from = t.saturating_sub(reach_far);
            for previous in from..=(t - reach_near) {
                let ratio = (t - previous) as f64 / period;
                let candidate = score[previous] - TIGHTNESS * ratio.ln().powi(2);
                if best_previous == usize::MAX || candidate > best {
                    best = candidate;
                    best_previous = previous;
                }
            }
        }
        if best_previous != usize::MAX && best > 0.0 {
            score[t] = envelope[t] + best;
            back[t] = best_previous;
        } else {
            score[t] = envelope[t];
        }
    }
    // End on the best-scoring frame of the last period.
    let tail_from = n.saturating_sub(period.round() as usize + 1);
    let mut frame = (tail_from..n)
        .max_by(|a, b| score[*a].total_cmp(&score[*b]))
        .unwrap_or(n - 1);
    let mut beats = vec![frame];
    while back[frame] != usize::MAX {
        frame = back[frame];
        beats.push(frame);
    }
    beats.reverse();
    // Leading/trailing silence: drop beats sitting on no onset at all.
    let strong = |frame: usize| {
        envelope[frame.saturating_sub(2)..(frame + 3).min(n)]
            .iter()
            .any(|v| *v > 0.5)
    };
    while beats.first().is_some_and(|f| !strong(*f)) {
        beats.remove(0);
    }
    while beats.last().is_some_and(|f| !strong(*f)) {
        beats.pop();
    }
    beats
}

/// The beat phase (0..beats_per_bar) whose beats carry the most low-end
/// onset: kick and bass land on beat 1 more than anywhere else.
fn downbeat_phase(low: &[f64], beats: &[usize], beats_per_bar: usize) -> usize {
    if beats_per_bar <= 1 {
        return 0;
    }
    let mut totals = vec![0.0; beats_per_bar];
    for (index, &frame) in beats.iter().enumerate() {
        let around = low[frame.saturating_sub(2)..(frame + 3).min(low.len())]
            .iter()
            .copied()
            .fold(0.0, f64::max);
        totals[index % beats_per_bar] += around;
    }
    totals
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(phase, _)| phase)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;

    /// A drum loop: kick on 1 and 3, snare on 2 and 4, hats in eighths, at
    /// `bpm` for `bars` 4/4 bars, starting at `start` seconds.
    fn drum_loop(bpm: f64, bars: usize, start: f64) -> Vec<f32> {
        let beat = 60.0 / bpm;
        let length = ((start + bars as f64 * 4.0 * beat + 1.0) * f64::from(RATE)) as usize;
        let mut out = vec![0.0_f32; length];
        let mut seed = 7_u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            ((seed >> 16) as f32 / 32_768.0) - 1.0
        };
        let mut hit = |at: f64, kind: u8| {
            let begin = (at * f64::from(RATE)) as usize;
            for i in 0..(0.15 * f64::from(RATE)) as usize {
                let Some(sample) = out.get_mut(begin + i) else {
                    break;
                };
                let t = i as f64 / f64::from(RATE);
                *sample += match kind {
                    // Kick: a falling sine.
                    0 => {
                        (0.9 * (-t / 0.05).exp()
                            * (std::f64::consts::TAU * (50.0 + 80.0 * (-t / 0.02).exp()) * t).sin())
                            as f32
                    }
                    // Snare: noise burst.
                    1 => 0.5 * (-t / 0.04).exp() as f32 * noise(),
                    // Hat: short quiet noise.
                    _ => 0.15 * (-t / 0.01).exp() as f32 * noise(),
                };
            }
        };
        for bar in 0..bars {
            for eighth in 0..8 {
                let at = start + (bar * 4) as f64 * beat + eighth as f64 * beat / 2.0;
                if eighth % 4 == 0 {
                    hit(at, 0);
                } else if eighth % 4 == 2 {
                    hit(at, 1);
                }
                hit(at, 2);
            }
        }
        out
    }

    fn kinds(analysis: &ClickAnalysis) -> Vec<ClickWarningKind> {
        analysis.warnings.iter().map(|w| w.kind).collect()
    }

    #[test]
    fn a_drum_loop_gives_its_tempo() {
        let analysis = analyze_music_tempo(&drum_loop(120.0, 24, 0.5), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert!(
            (analysis.segments[0].bpm - 120.0).abs() < 0.6,
            "{analysis:?}"
        );
        assert!(kinds(&analysis).contains(&ClickWarningKind::EstimatedWithoutClick));
        assert!(!analysis.downbeat_known);
    }

    #[test]
    fn a_slow_ballad_is_not_doubled() {
        let analysis = analyze_music_tempo(&drum_loop(72.0, 16, 0.0), RATE, 4);
        assert!(
            (analysis.segments[0].bpm - 72.0).abs() < 0.6,
            "{analysis:?}"
        );
    }

    #[test]
    fn beats_land_on_the_hits() {
        // Start 0.5 s in: the first downbeat must be on a beat of the loop,
        // within a frame or two.
        let analysis = analyze_music_tempo(&drum_loop(100.0, 24, 0.5), RATE, 4);
        let start = analysis.segments[0].start_seconds;
        let beat = 60.0 / 100.0;
        let offset = ((start - 0.5) / beat).rem_euclid(1.0) * beat;
        let distance = offset.min(beat - offset);
        assert!(distance < 0.025, "start {start}, off by {distance}");
    }

    #[test]
    fn the_kick_picks_beat_one() {
        let analysis = analyze_music_tempo(&drum_loop(120.0, 24, 0.5), RATE, 4);
        let start = analysis.segments[0].start_seconds;
        // Kicks are on beats 1 and 3: beat 1 is 0.5 + k * 2 s, beat 3 is
        // one second later. Either is a kick; a snare beat (2 or 4) is not.
        let beat = 0.5;
        let position = ((start - 0.5) / beat).round() as i64;
        assert_eq!(position.rem_euclid(2), 0, "start {start} is on a snare");
    }

    #[test]
    fn silence_has_no_pulse() {
        let analysis = analyze_music_tempo(&vec![0.0; RATE as usize * 10], RATE, 4);
        assert!(analysis.segments.is_empty());
        assert!(kinds(&analysis).contains(&ClickWarningKind::NoClick));
    }
}
