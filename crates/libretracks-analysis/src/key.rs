//! The key of a song from its harmonic tracks.
//!
//! 1. Decimate to ~11 kHz (a key lives below 2 kHz) and run an STFT.
//! 2. Take the spectral peaks of each frame, estimate the tuning from how far
//!    they sit from equal temperament (a band tuned to 432 Hz is still in D),
//!    and fold them into a 12-bin chromagram, each frame weighted the same so
//!    a loud chorus does not outvote the verses.
//! 3. Correlate the song's chroma with the 24 key profiles. The margin to the
//!    runner-up is the confidence; a relative major/minor in second place is
//!    the classic doubt and is reported as such.

use serde::Serialize;

use crate::fft::fft;

/// Analysis rate: harmonics above ~5 kHz say nothing about the key.
const TARGET_RATE: f64 = 11_025.0;
const FRAME: usize = 4096;
const HOP: usize = 2048;
/// Pitch range folded into the chromagram (C2 to C7).
const MIN_HZ: f64 = 65.0;
const MAX_HZ: f64 = 2100.0;
/// Strongest peaks kept per frame.
const PEAKS_PER_FRAME: usize = 40;
/// A peak this far (in semitones) from the tuned grid is noise, not a note.
const MAX_DETUNE_SEMITONES: f64 = 0.35;
/// Frames quieter than this share of the median loud frame are silence.
const SILENT_FRAME_SHARE: f64 = 0.1;
/// Below this correlation margin the runner-up is offered as an alternative.
/// Real songs whose key was right won by 0.16–0.36 (see the plan's
/// validation table).
const CLEAR_MARGIN: f64 = 0.1;

/// Sharp spelling, the app's canonical form (`SONG_KEY_OPTIONS`).
const PITCH_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Temperley–Kostka–Payne key profiles (2007), tonic first. Fit pop and
/// worship harmony better than Krumhansl–Kessler on the validation set.
const MAJOR_PROFILE: [f64; 12] = [
    0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400,
];
const MINOR_PROFILE: [f64; 12] = [
    0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330,
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCandidate {
    /// `"Dm"`, `"F#"`…
    pub key: String,
    /// Correlation with the key's profile, -1..1.
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAnalysis {
    /// Best key; `None` when the audio has no pitched content.
    pub key: Option<String>,
    /// Correlation margin over the runner-up (0 = a coin toss).
    pub confidence: f64,
    /// The runner-up, when the margin is too small to call.
    pub alternative: Option<String>,
    /// That close runner-up is the relative key (same notes, other tonic).
    pub relative_doubt: bool,
    /// How far the band is from A = 440 Hz, in cents.
    pub tuning_cents: f64,
    /// The three best keys.
    pub candidates: Vec<KeyCandidate>,
}

impl KeyAnalysis {
    fn silent() -> Self {
        Self {
            key: None,
            confidence: 0.0,
            alternative: None,
            relative_doubt: false,
            tuning_cents: 0.0,
            candidates: Vec::new(),
        }
    }
}

pub fn key_name(tonic: usize, minor: bool) -> String {
    format!(
        "{}{}",
        PITCH_NAMES[tonic % 12],
        if minor { "m" } else { "" }
    )
}

/// `key_name` shifted by `semitones` (`"Dm"` + 2 → `"Em"`). `None` for a name
/// this module did not write.
pub fn transpose_key_name(name: &str, semitones: i32) -> Option<String> {
    let minor = name.ends_with('m');
    let note = name.strip_suffix('m').unwrap_or(name);
    let tonic = PITCH_NAMES
        .iter()
        .position(|candidate| *candidate == note)?;
    let shifted = (tonic as i32 + semitones).rem_euclid(12) as usize;
    Some(key_name(shifted, minor))
}

impl KeyAnalysis {
    /// The same result `semitones` away. A song transposed +2 sounds a tone
    /// up, while its stored key is the original: the caller passes -2.
    pub fn transposed(mut self, semitones: i32) -> Self {
        let shift = |name: &mut String| {
            if let Some(shifted) = transpose_key_name(name, semitones) {
                *name = shifted;
            }
        };
        if let Some(key) = self.key.as_mut() {
            shift(key);
        }
        if let Some(alternative) = self.alternative.as_mut() {
            shift(alternative);
        }
        for candidate in &mut self.candidates {
            shift(&mut candidate.key);
        }
        self
    }
}

/// Analyse the key of a mono mix of the song's harmonic tracks.
pub fn analyze_key(samples: &[f32], sample_rate: u32) -> KeyAnalysis {
    let (signal, rate) = decimate(samples, f64::from(sample_rate.max(1)));
    let frames = spectral_peaks(&signal, rate);
    if frames.is_empty() {
        return KeyAnalysis::silent();
    }
    let tuning = estimate_tuning(&frames);
    let chroma = chromagram(&frames, tuning);
    if chroma.iter().sum::<f64>() <= 0.0 {
        return KeyAnalysis::silent();
    }

    let mut scores: Vec<(usize, bool, f64)> = Vec::with_capacity(24);
    for tonic in 0..12 {
        for minor in [false, true] {
            let profile = if minor {
                &MINOR_PROFILE
            } else {
                &MAJOR_PROFILE
            };
            let rotated: Vec<f64> = (0..12).map(|pc| profile[(pc + 12 - tonic) % 12]).collect();
            scores.push((tonic, minor, pearson(&chroma, &rotated)));
        }
    }
    scores.sort_by(|a, b| b.2.total_cmp(&a.2));
    let (tonic, minor, best) = scores[0];
    let (second_tonic, second_minor, second) = scores[1];
    let relative = if minor {
        (tonic + 3) % 12
    } else {
        (tonic + 9) % 12
    };
    let margin = best - second;
    let relative_doubt = second_minor != minor && second_tonic == relative && margin < CLEAR_MARGIN;
    KeyAnalysis {
        key: Some(key_name(tonic, minor)),
        confidence: margin,
        alternative: (margin < CLEAR_MARGIN).then(|| key_name(second_tonic, second_minor)),
        relative_doubt,
        tuning_cents: tuning * 100.0,
        candidates: scores
            .iter()
            .take(3)
            .map(|&(t, m, score)| KeyCandidate {
                key: key_name(t, m),
                score,
            })
            .collect(),
    }
}

/// Low-pass (windowed sinc) and keep one sample in `factor`.
fn decimate(samples: &[f32], rate: f64) -> (Vec<f32>, f64) {
    let factor = (rate / TARGET_RATE).round().max(1.0) as usize;
    if factor == 1 {
        return (samples.to_vec(), rate);
    }
    const TAPS: usize = 63;
    let cutoff = 0.45 / factor as f64;
    let middle = (TAPS / 2) as f64;
    let kernel: Vec<f32> = (0..TAPS)
        .map(|i| {
            let x = i as f64 - middle;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (std::f64::consts::TAU * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            let window = 0.54 - 0.46 * (std::f64::consts::TAU * i as f64 / (TAPS - 1) as f64).cos();
            (sinc * window) as f32
        })
        .collect();
    let output = (0..samples.len() / factor)
        .map(|n| {
            let center = n * factor;
            let mut sum = 0.0_f32;
            for (i, weight) in kernel.iter().enumerate() {
                let Some(index) = (center + i).checked_sub(TAPS / 2) else {
                    continue;
                };
                if let Some(sample) = samples.get(index) {
                    sum += sample * weight;
                }
            }
            sum
        })
        .collect();
    (output, rate / factor as f64)
}

/// (frequency Hz, magnitude) of a frame's peaks.
type Peaks = Vec<(f64, f64)>;

fn spectral_peaks(signal: &[f32], rate: f64) -> Vec<Peaks> {
    if signal.len() < FRAME {
        return Vec::new();
    }
    let window: Vec<f32> = (0..FRAME)
        .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / FRAME as f64).cos()) as f32)
        .collect();
    let bin_hz = rate / FRAME as f64;
    let low = ((MIN_HZ / bin_hz).floor() as usize).max(1);
    let high = ((MAX_HZ / bin_hz).ceil() as usize).min(FRAME / 2 - 2);

    let mut frames: Vec<(f64, Peaks)> = Vec::new();
    let mut re = vec![0.0_f32; FRAME];
    let mut im = vec![0.0_f32; FRAME];
    let mut start = 0;
    while start + FRAME <= signal.len() {
        for i in 0..FRAME {
            re[i] = signal[start + i] * window[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        let magnitude: Vec<f64> = (0..=high + 1)
            .map(|k| f64::from(re[k] * re[k] + im[k] * im[k]).sqrt())
            .collect();
        let energy: f64 = magnitude[low..=high].iter().map(|m| m * m).sum();
        let frame_max = magnitude[low..=high].iter().copied().fold(0.0, f64::max);
        let mut peaks: Peaks = Vec::new();
        if frame_max > 0.0 {
            for k in low..=high {
                let (a, b, c) = (magnitude[k - 1], magnitude[k], magnitude[k + 1]);
                if b > a && b >= c && b > 0.05 * frame_max {
                    // Parabolic interpolation on the log magnitude.
                    let (la, lb, lc) = (a.max(1e-12).ln(), b.ln(), c.max(1e-12).ln());
                    let denominator = la - 2.0 * lb + lc;
                    let offset = if denominator.abs() > 1e-12 {
                        (0.5 * (la - lc) / denominator).clamp(-0.5, 0.5)
                    } else {
                        0.0
                    };
                    peaks.push(((k as f64 + offset) * bin_hz, b));
                }
            }
            peaks.sort_by(|x, y| y.1.total_cmp(&x.1));
            peaks.truncate(PEAKS_PER_FRAME);
        }
        frames.push((energy, peaks));
        start += HOP;
    }

    // Drop the silent frames (intros, breaks, the song's tail).
    let mut energies: Vec<f64> = frames.iter().map(|f| f.0).filter(|e| *e > 0.0).collect();
    if energies.is_empty() {
        return Vec::new();
    }
    energies.sort_by(f64::total_cmp);
    let floor = SILENT_FRAME_SHARE * energies[energies.len() / 2];
    frames
        .into_iter()
        .filter(|(energy, peaks)| *energy > floor && !peaks.is_empty())
        .map(|(_, peaks)| peaks)
        .collect()
}

/// Semitones above A440 (fractional).
fn semitones_from_a440(frequency: f64) -> f64 {
    12.0 * (frequency / 440.0).log2()
}

/// Band tuning in semitones (-0.5..0.5): the circular mean of every peak's
/// distance to the nearest equal-tempered note, weighted by its level.
fn estimate_tuning(frames: &[Peaks]) -> f64 {
    let (mut x, mut y) = (0.0, 0.0);
    for peaks in frames {
        for &(frequency, magnitude) in peaks {
            let deviation = semitones_from_a440(frequency);
            let angle = std::f64::consts::TAU * (deviation - deviation.round());
            x += magnitude * angle.cos();
            y += magnitude * angle.sin();
        }
    }
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    y.atan2(x) / std::f64::consts::TAU
}

fn chromagram(frames: &[Peaks], tuning: f64) -> [f64; 12] {
    let mut chroma = [0.0; 12];
    for peaks in frames {
        let mut frame = [0.0; 12];
        for &(frequency, magnitude) in peaks {
            let semitones = semitones_from_a440(frequency) - tuning;
            let nearest = semitones.round();
            if (semitones - nearest).abs() > MAX_DETUNE_SEMITONES {
                continue;
            }
            // A is 9 semitones above C.
            let pitch_class = (nearest as i64 + 9).rem_euclid(12) as usize;
            frame[pitch_class] += magnitude.sqrt();
        }
        let total: f64 = frame.iter().sum();
        if total > 0.0 {
            for (bin, value) in chroma.iter_mut().zip(frame) {
                *bin += value / total;
            }
        }
    }
    chroma
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let mean_a = a.iter().sum::<f64>() / n;
    let mean_b = b.iter().sum::<f64>() / n;
    let (mut covariance, mut var_a, mut var_b) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        covariance += (x - mean_a) * (y - mean_b);
        var_a += (x - mean_a).powi(2);
        var_b += (y - mean_b).powi(2);
    }
    if var_a <= 0.0 || var_b <= 0.0 {
        return 0.0;
    }
    covariance / (var_a * var_b).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;

    /// A chord as a sum of harmonic tones (MIDI notes), `seconds` long.
    fn chord(notes: &[i32], seconds: f64, detune_cents: f64) -> Vec<f32> {
        let length = (seconds * f64::from(RATE)) as usize;
        let mut out = vec![0.0_f32; length];
        for &note in notes {
            let frequency = 440.0 * 2f64.powf((f64::from(note - 69) + detune_cents / 100.0) / 12.0);
            for (i, sample) in out.iter_mut().enumerate() {
                let t = i as f64 / f64::from(RATE);
                // A few harmonics, like a real instrument.
                let mut value = 0.0;
                for harmonic in 1..=4 {
                    value += (std::f64::consts::TAU * frequency * f64::from(harmonic) * t).sin()
                        / f64::from(harmonic);
                }
                *sample += (0.1 * value) as f32;
            }
        }
        out
    }

    /// A I-IV-V-I-vi-IV-V-I progression (two seconds a chord) in `tonic`
    /// (MIDI of the tonic around C4), with the bass an octave down.
    fn progression(tonic: i32, minor: bool, detune_cents: f64) -> Vec<f32> {
        // Triads as (root offset, third offset).
        let degrees: &[(i32, i32)] = if minor {
            // i iv v(V) i VI iv V i
            &[
                (0, 3),
                (5, 3),
                (7, 4),
                (0, 3),
                (8, 4),
                (5, 3),
                (7, 4),
                (0, 3),
            ]
        } else {
            &[
                (0, 4),
                (5, 4),
                (7, 4),
                (0, 4),
                (9, 3),
                (5, 4),
                (7, 4),
                (0, 4),
            ]
        };
        let mut song = Vec::new();
        for &(root, third) in degrees {
            let r = tonic + root;
            song.extend(chord(&[r - 12, r, r + third, r + 7], 2.0, detune_cents));
        }
        song
    }

    #[test]
    fn c_major_progression_is_c() {
        let analysis = analyze_key(&progression(60, false, 0.0), RATE);
        assert_eq!(analysis.key.as_deref(), Some("C"), "{analysis:?}");
    }

    #[test]
    fn a_minor_progression_is_a_minor() {
        let analysis = analyze_key(&progression(57, true, 0.0), RATE);
        assert_eq!(analysis.key.as_deref(), Some("Am"), "{analysis:?}");
    }

    #[test]
    fn f_sharp_major_uses_sharp_spelling() {
        let analysis = analyze_key(&progression(66, false, 0.0), RATE);
        assert_eq!(analysis.key.as_deref(), Some("F#"), "{analysis:?}");
    }

    #[test]
    fn a_band_tuned_to_432_hz_keeps_its_key() {
        // 432 Hz is 31.8 cents flat of 440.
        let analysis = analyze_key(&progression(62, false, -31.8), RATE);
        assert_eq!(analysis.key.as_deref(), Some("D"), "{analysis:?}");
        assert!((analysis.tuning_cents + 31.8).abs() < 5.0, "{analysis:?}");
    }

    #[test]
    fn only_relative_triads_is_reported_as_a_relative_doubt() {
        // C and Am taking turns: same notes, two tonics.
        let mut song = Vec::new();
        for _ in 0..4 {
            song.extend(chord(&[48, 60, 64, 67], 2.0, 0.0));
            song.extend(chord(&[45, 57, 60, 64], 2.0, 0.0));
        }
        let analysis = analyze_key(&song, RATE);
        let pair = [analysis.key.clone(), analysis.alternative.clone()];
        assert!(pair.contains(&Some("C".into())), "{analysis:?}");
        assert!(pair.contains(&Some("Am".into())), "{analysis:?}");
        assert!(analysis.relative_doubt, "{analysis:?}");
    }

    #[test]
    fn transposing_a_result_moves_every_key() {
        let analysis = analyze_key(&progression(62, false, 0.0), RATE).transposed(-2);
        assert_eq!(analysis.key.as_deref(), Some("C"));
        assert_eq!(transpose_key_name("A#m", 3).as_deref(), Some("C#m"));
        assert_eq!(transpose_key_name("C", -1).as_deref(), Some("B"));
        assert_eq!(transpose_key_name("Hm", 1), None);
    }

    #[test]
    fn silence_has_no_key() {
        let analysis = analyze_key(&vec![0.0; RATE as usize * 4], RATE);
        assert_eq!(analysis.key, None);
    }
}
