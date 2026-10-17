//! Section announcements on a multitrack's guide (cue) track.
//!
//! A guide track is a voice saying "Coro", "Verso 2", "Puente"… a bar or so
//! before each section, and silence in between. Two facts make it readable
//! without speech recognition:
//!
//! - **Within one track, each announcement is the same recording.** The three
//!   "Coro" of a song are one clip pasted three times, so the speech fragments
//!   group by how alike they sound (MFCC + DTW), and labelling a group labels
//!   every time it is said.
//! - **Some multitracks use the very voice the app's own guide clips came
//!   from**, and then a group matches one of those clips almost exactly and is
//!   labelled with no help.
//!
//! A different voice does not match any clip (measured 2026-10-17: a
//! matching voice costs 0.2–1.3, any other word or voice 2.4 and up), so its
//! groups come back unlabelled for the user to name once each.

use serde::Serialize;

use crate::dsp::{decimate_to, resample_to};
use crate::fft::fft;
use crate::guide_text::{is_count, parse_announcement};

/// Speech analysis rate: a voice's identity lives below 8 kHz.
const SPEECH_RATE: f64 = 16_000.0;
/// Frames of 25 ms every 10 ms, the usual speech analysis.
const FRAME_SECONDS: f64 = 0.025;
const HOP_SECONDS: f64 = 0.010;
const MEL_BANDS: usize = 26;
/// Cepstral coefficients kept (c1..c12: c0 is loudness, not identity).
const COEFFICIENTS: usize = 12;
/// A pause longer than this ends an announcement ("Coro 1." … "Suave.").
const MAX_PAUSE_SECONDS: f64 = 0.4;
/// Shorter blips are breaths and clicks, not words.
const MIN_SPEECH_SECONDS: f64 = 0.15;
/// A guide clip matching under this DTW cost is the same word in the same
/// voice (see the module docs for the measured gap).
const MATCH_COST: f64 = 1.6;
/// Under this, a clip match is certain enough to skip transcribing the group.
/// A fragment that only partly matches ("Verso 3, entra batería" against
/// the clip "entra batería", 1.41) is transcribed, so both markers come out.
const SURE_MATCH_COST: f64 = 1.0;
/// Speech recognition rate.
const RECOGNITION_RATE: f64 = 16_000.0;
/// Speech given to language detection: the longest announcements, up to this.
const LANGUAGE_SAMPLE_SECONDS: f64 = 12.0;
/// Silence padded around a fragment before recognition (recognisers clip
/// the first and last syllable of audio that starts on a word).
const RECOGNITION_PAD_SECONDS: f64 = 0.15;

/// Speech recognition, provided by the app (whisper.cpp on desktop).
pub trait Transcriber {
    /// Settle the language from a sample of the track's speech (16 kHz mono).
    fn detect_language(&mut self, speech: &[f32]);
    /// The text of one announcement (16 kHz mono), `None` on failure.
    fn transcribe(&mut self, speech: &[f32]) -> Option<String>;
    /// `done` of `total` announcements transcribed so far (for a progress
    /// bar).
    fn progress(&mut self, _done: usize, _total: usize) {}
}

/// Two fragments under this cost are the same recording, said again.
const SAME_RECORDING_COST: f64 = 1.0;
/// Fragments whose lengths differ more than this ratio are different words.
const MAX_LENGTH_RATIO: f64 = 1.5;

/// A clip of the app's voice guide, named like the file it came from
/// (`chorus_2`, `drums_in`, `count`).
pub struct GuideTemplate {
    pub label: String,
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideAnnouncement {
    /// Seconds from the start of the analysed audio.
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// Index into `GuideAnalysis::groups`.
    pub group: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideGroup {
    /// The markers it names, as voice-clip labels (`verse_3`, `drums_in`), or
    /// `["count"]` for a count-in. Empty: not recognised, the user says.
    pub labels: Vec<String>,
    /// What speech recognition heard, when it ran.
    pub transcript: Option<String>,
    /// DTW cost of that match (lower is closer).
    pub match_cost: Option<f64>,
    pub occurrences: usize,
    /// Where it is first said, to play it in the review.
    pub first_start_seconds: f64,
    pub first_end_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideAnalysis {
    pub announcements: Vec<GuideAnnouncement>,
    pub groups: Vec<GuideGroup>,
}

/// Find, group and label the announcements of a guide track: from speech
/// recognition when a `transcriber` is given, from the app's clips otherwise
/// (or when it hears nothing it knows).
pub fn analyze_guide(
    samples: &[f32],
    sample_rate: u32,
    templates: &[GuideTemplate],
    mut transcriber: Option<&mut dyn Transcriber>,
) -> GuideAnalysis {
    let (signal, rate) = decimate_to(samples, f64::from(sample_rate.max(1)), SPEECH_RATE);
    let fragments = speech_fragments(&signal, rate);
    let features: Vec<Vec<[f64; COEFFICIENTS]>> = fragments
        .iter()
        .map(|&(start, end)| {
            let from = (start * rate) as usize;
            let to = ((end * rate) as usize).min(signal.len());
            normalise(mfcc(&signal[from..to], rate))
        })
        .collect();
    let templates: Vec<(&str, Vec<[f64; COEFFICIENTS]>)> = templates
        .iter()
        .filter_map(|template| {
            let (clip, clip_rate) = decimate_to(
                &template.samples,
                f64::from(template.sample_rate.max(1)),
                SPEECH_RATE,
            );
            let trimmed = trim_silence(&clip, clip_rate);
            let frames = normalise(mfcc(trimmed, clip_rate));
            (frames.len() >= 3).then_some((template.label.as_str(), frames))
        })
        .collect();

    let groups_of = group_fragments(&features, &fragments);
    let group_count = groups_of.iter().copied().max().map_or(0, |max| max + 1);
    let original_rate = f64::from(sample_rate.max(1));
    // A fragment as the recogniser wants it: 16 kHz, a little silence around.
    let speech_of = |index: usize| -> Vec<f32> {
        let (start, end) = fragments[index];
        let from = ((start - RECOGNITION_PAD_SECONDS).max(0.0) * original_rate) as usize;
        let to = (((end + RECOGNITION_PAD_SECONDS) * original_rate) as usize).min(samples.len());
        resample_to(&samples[from.min(to)..to], original_rate, RECOGNITION_RATE)
    };
    if let Some(recogniser) = transcriber.as_deref_mut() {
        if !fragments.is_empty() {
            let mut longest: Vec<usize> = (0..fragments.len()).collect();
            longest.sort_by(|a, b| {
                let length = |i: &usize| fragments[*i].1 - fragments[*i].0;
                length(b).total_cmp(&length(a))
            });
            let mut sample = Vec::new();
            for index in longest {
                if sample.len() as f64 >= LANGUAGE_SAMPLE_SECONDS * RECOGNITION_RATE {
                    break;
                }
                sample.extend(speech_of(index));
            }
            recogniser.detect_language(&sample);
        }
    }
    // First every group's clip match, so the number of announcements left to
    // transcribe is known before the slow part starts.
    struct Pending {
        members: Vec<usize>,
        clip_label: Option<String>,
        match_cost: Option<f64>,
        sure: bool,
        representative: usize,
    }
    let mut pending: Vec<Pending> = Vec::with_capacity(group_count);
    for group in 0..group_count {
        let members: Vec<usize> = (0..fragments.len())
            .filter(|&i| groups_of[i] == group)
            .collect();
        let first = members[0];
        // The best clip over every time it is said.
        let features = &features;
        let best = members
            .iter()
            .flat_map(|&member| {
                templates.iter().map(move |(label, template)| {
                    (subsequence_cost(template, &features[member]), *label)
                })
            })
            .min_by(|a, b| a.0.total_cmp(&b.0));
        let (clip_label, match_cost) = match best {
            Some((cost, label)) if cost < MATCH_COST => (Some(label.to_string()), Some(cost)),
            Some((cost, _)) => (None, Some(cost)),
            None => (None, None),
        };
        let sure = match_cost.is_some_and(|cost| cost < SURE_MATCH_COST) && clip_label.is_some();
        // The longest time it is said: the clearest take to recognise.
        let representative = members
            .iter()
            .copied()
            .max_by(|a, b| {
                (fragments[*a].1 - fragments[*a].0).total_cmp(&(fragments[*b].1 - fragments[*b].0))
            })
            .unwrap_or(first);
        pending.push(Pending {
            members,
            clip_label,
            match_cost,
            sure,
            representative,
        });
    }
    // The groups to transcribe, one at a time (about a second each), so the
    // progress bar moves with each. Packing several into one whisper window
    // was tried: words drifted between announcements.
    let mut transcripts: Vec<Option<String>> = vec![None; pending.len()];
    if let Some(recogniser) = transcriber.as_deref_mut() {
        let wanted: Vec<usize> = (0..pending.len()).filter(|&g| !pending[g].sure).collect();
        for (done, &g) in wanted.iter().enumerate() {
            recogniser.progress(done, wanted.len());
            transcripts[g] = recogniser.transcribe(&speech_of(pending[g].representative));
        }
        if !wanted.is_empty() {
            recogniser.progress(wanted.len(), wanted.len());
        }
    }
    let mut groups: Vec<GuideGroup> = Vec::with_capacity(group_count);
    for (group, transcript) in pending.into_iter().zip(transcripts) {
        let Pending {
            members,
            clip_label,
            match_cost,
            sure: _,
            representative: _,
        } = group;
        let first = members[0];
        let mut labels: Vec<String> = match transcript.as_deref() {
            Some(text) if is_count(text) => vec!["count".to_string()],
            Some(text) => parse_announcement(text)
                .into_iter()
                .map(|marker| match marker.variant {
                    Some(variant) => format!("{}_{variant}", marker.kind),
                    None => marker.kind.to_string(),
                })
                .collect(),
            None => Vec::new(),
        };
        if labels.is_empty() {
            labels.extend(clip_label);
        }
        groups.push(GuideGroup {
            labels,
            transcript,
            match_cost,
            occurrences: members.len(),
            first_start_seconds: fragments[first].0,
            first_end_seconds: fragments[first].1,
        });
    }
    GuideAnalysis {
        announcements: fragments
            .iter()
            .zip(&groups_of)
            .map(
                |(&(start_seconds, end_seconds), &group)| GuideAnnouncement {
                    start_seconds,
                    end_seconds,
                    group,
                },
            )
            .collect(),
        groups,
    }
}

/// (start, end) seconds of each stretch of speech.
fn speech_fragments(signal: &[f32], rate: f64) -> Vec<(f64, f64)> {
    let hop = ((HOP_SECONDS * rate) as usize).max(1);
    let levels: Vec<f64> = signal
        .chunks(hop)
        .map(|chunk| {
            let power =
                chunk.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>() / chunk.len() as f64;
            10.0 * (power + 1e-12).log10()
        })
        .collect();
    if levels.is_empty() {
        return Vec::new();
    }
    let mut sorted = levels.clone();
    sorted.sort_by(f64::total_cmp);
    let percentile = |p: f64| sorted[((sorted.len() - 1) as f64 * p) as usize];
    let (floor, peak) = (percentile(0.2), percentile(0.995));
    if peak < -60.0 {
        return Vec::new();
    }
    // Clear of the noise floor, and within 30 dB of the loudest words.
    let threshold = (floor + 12.0).max(peak - 30.0);
    let max_pause = (MAX_PAUSE_SECONDS / HOP_SECONDS) as usize;
    let mut fragments = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    for (index, &level) in levels.iter().enumerate() {
        if level > threshold {
            current = Some(match current {
                Some((start, _)) => (start, index),
                None => (index, index),
            });
        } else if let Some((start, last)) = current {
            if index - last > max_pause {
                fragments.push((start, last));
                current = None;
            }
        }
    }
    if let Some(open) = current {
        fragments.push(open);
    }
    let frame_seconds = hop as f64 / rate;
    fragments
        .into_iter()
        .map(|(start, last)| {
            (
                start as f64 * frame_seconds,
                (last + 1) as f64 * frame_seconds,
            )
        })
        .filter(|(start, end)| end - start >= MIN_SPEECH_SECONDS)
        .collect()
}

/// A clip's voiced core: frames within 30 dB of its loudest.
fn trim_silence(clip: &[f32], rate: f64) -> &[f32] {
    let hop = ((HOP_SECONDS * rate) as usize).max(1);
    let levels: Vec<f64> = clip
        .chunks(hop)
        .map(|chunk| chunk.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>() / chunk.len() as f64)
        .collect();
    let peak = levels.iter().copied().fold(0.0, f64::max);
    if peak <= 0.0 {
        return &clip[..0];
    }
    let loud = |level: &f64| *level > peak * 1e-3;
    let first = levels.iter().position(loud).unwrap_or(0);
    let last = levels.iter().rposition(loud).unwrap_or(0);
    &clip[first * hop..((last + 1) * hop).min(clip.len())]
}

/// Mel-frequency cepstral coefficients c1..c12 of each 25 ms frame.
fn mfcc(signal: &[f32], rate: f64) -> Vec<[f64; COEFFICIENTS]> {
    let frame = (FRAME_SECONDS * rate) as usize;
    let hop = ((HOP_SECONDS * rate) as usize).max(1);
    if frame == 0 || signal.len() < frame {
        return Vec::new();
    }
    let size = frame.next_power_of_two();
    let window: Vec<f32> = (0..frame)
        .map(|i| {
            (0.54 - 0.46 * (std::f64::consts::TAU * i as f64 / (frame - 1) as f64).cos()) as f32
        })
        .collect();
    let filters = mel_filters(size, rate);
    let mut re = vec![0.0_f32; size];
    let mut im = vec![0.0_f32; size];
    let mut out = Vec::new();
    let mut start = 0;
    while start + frame <= signal.len() {
        re.iter_mut().for_each(|v| *v = 0.0);
        im.iter_mut().for_each(|v| *v = 0.0);
        for i in 0..frame {
            // Pre-emphasis, as speech front ends do.
            let previous = if start + i > 0 {
                signal[start + i - 1]
            } else {
                0.0
            };
            re[i] = (signal[start + i] - 0.97 * previous) * window[i];
        }
        fft(&mut re, &mut im);
        let power: Vec<f64> = (0..=size / 2)
            .map(|k| f64::from(re[k] * re[k] + im[k] * im[k]))
            .collect();
        let energies: Vec<f64> = filters
            .iter()
            .map(|(first, weights)| {
                let sum: f64 = weights
                    .iter()
                    .enumerate()
                    .map(|(offset, weight)| weight * power[first + offset])
                    .sum();
                (sum + 1e-10).ln()
            })
            .collect();
        let mut coefficients = [0.0; COEFFICIENTS];
        for (c, value) in coefficients.iter_mut().enumerate() {
            let order = (c + 1) as f64;
            *value = energies
                .iter()
                .enumerate()
                .map(|(m, energy)| {
                    energy
                        * (std::f64::consts::PI * order * (m as f64 + 0.5) / MEL_BANDS as f64).cos()
                })
                .sum();
        }
        out.push(coefficients);
        start += hop;
    }
    out
}

/// Triangular mel filters over an FFT of `size`: (first bin, weights).
fn mel_filters(size: usize, rate: f64) -> Vec<(usize, Vec<f64>)> {
    let to_mel = |hz: f64| 2595.0 * (1.0 + hz / 700.0).log10();
    let to_hz = |mel: f64| 700.0 * (10f64.powf(mel / 2595.0) - 1.0);
    let (low, high) = (to_mel(80.0), to_mel((rate / 2.0).min(7600.0)));
    let edges: Vec<f64> = (0..MEL_BANDS + 2)
        .map(|i| to_hz(low + (high - low) * i as f64 / (MEL_BANDS + 1) as f64) * size as f64 / rate)
        .collect();
    (0..MEL_BANDS)
        .map(|m| {
            let (left, centre, right) = (edges[m], edges[m + 1], edges[m + 2]);
            let first = left.floor().max(0.0) as usize;
            let last = (right.ceil() as usize).min(size / 2);
            let weights = (first..=last)
                .map(|bin| {
                    let bin = bin as f64;
                    if bin <= centre {
                        ((bin - left) / (centre - left).max(1e-9)).max(0.0)
                    } else {
                        ((right - bin) / (right - centre).max(1e-9)).max(0.0)
                    }
                })
                .collect();
            (first, weights)
        })
        .collect()
}

/// Per-coefficient mean and variance normalisation: a louder or brighter
/// recording of the same word lands on the same numbers.
fn normalise(mut frames: Vec<[f64; COEFFICIENTS]>) -> Vec<[f64; COEFFICIENTS]> {
    let n = frames.len().max(1) as f64;
    for c in 0..COEFFICIENTS {
        let mean = frames.iter().map(|f| f[c]).sum::<f64>() / n;
        let deviation = (frames.iter().map(|f| (f[c] - mean).powi(2)).sum::<f64>() / n).sqrt();
        for frame in &mut frames {
            frame[c] = (frame[c] - mean) / (deviation + 1e-6);
        }
    }
    frames
}

fn distance(a: &[f64; COEFFICIENTS], b: &[f64; COEFFICIENTS]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).powi(2))
        .sum::<f64>()
        .sqrt()
}

/// Cost of the shorter sequence aligned anywhere inside the longer one
/// (subsequence DTW), per frame of the shorter. A clip "Intro" inside the
/// fragment "Intro, uno, dos, tres, cuatro" costs what "Intro" alone costs.
fn subsequence_cost(a: &[[f64; COEFFICIENTS]], b: &[[f64; COEFFICIENTS]]) -> f64 {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if short.is_empty() {
        return f64::INFINITY;
    }
    let width = long.len();
    let mut previous = vec![0.0; width];
    let mut current = vec![0.0; width];
    for (i, row) in short.iter().enumerate() {
        for j in 0..width {
            let cost = distance(row, &long[j]);
            current[j] = if i == 0 {
                // Free start anywhere in the longer sequence.
                cost
            } else if j == 0 {
                cost + previous[0]
            } else {
                cost + previous[j].min(previous[j - 1]).min(current[j - 1])
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous.iter().copied().fold(f64::INFINITY, f64::min) / short.len() as f64
}

/// Group the fragments that are the same recording: single-link, under
/// `SAME_RECORDING_COST` and with similar lengths. Groups are numbered in
/// the order they are first said.
fn group_fragments(features: &[Vec<[f64; COEFFICIENTS]>], fragments: &[(f64, f64)]) -> Vec<usize> {
    let n = features.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (
                fragments[i].1 - fragments[i].0,
                fragments[j].1 - fragments[j].0,
            );
            if a.max(b) / a.min(b).max(1e-6) > MAX_LENGTH_RATIO {
                continue;
            }
            if subsequence_cost(&features[i], &features[j]) < SAME_RECORDING_COST {
                let (ri, rj) = (root(&mut parent, i), root(&mut parent, j));
                if ri != rj {
                    parent[ri.max(rj)] = ri.min(rj);
                }
            }
        }
    }
    let mut numbering: Vec<Option<usize>> = vec![None; n];
    let mut next = 0;
    (0..n)
        .map(|i| {
            let r = root(&mut parent, i);
            *numbering[r].get_or_insert_with(|| {
                next += 1;
                next - 1
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    /// A synthetic "word": a voiced sound gliding through formant-like
    /// partials, different per `word`.
    fn word(word: usize, seconds: f64) -> Vec<f32> {
        let length = (seconds * f64::from(RATE)) as usize;
        let shapes = [
            (180.0, [700.0, 1200.0], [300.0, 2300.0]),
            (140.0, [300.0, 2200.0], [650.0, 1000.0]),
            (220.0, [500.0, 900.0], [400.0, 2600.0]),
        ];
        let (pitch, from, to) = shapes[word % shapes.len()];
        (0..length)
            .map(|i| {
                let t = i as f64 / f64::from(RATE);
                let progress = t / seconds;
                let envelope = (std::f64::consts::PI * progress).sin();
                let mut value = 0.0;
                for (k, (a, b)) in from.iter().zip(to.iter()).enumerate() {
                    let formant = a + (b - a) * progress;
                    value += (std::f64::consts::TAU * formant * t).sin() / (k + 1) as f64;
                }
                value += 0.6 * (std::f64::consts::TAU * pitch * t).sin();
                (0.3 * envelope * value) as f32
            })
            .collect()
    }

    fn track(words: &[(f64, usize, f64)], total: f64) -> Vec<f32> {
        let mut out = vec![0.0_f32; (total * f64::from(RATE)) as usize];
        for &(at, which, seconds) in words {
            let start = (at * f64::from(RATE)) as usize;
            for (i, sample) in word(which, seconds).iter().enumerate() {
                if let Some(slot) = out.get_mut(start + i) {
                    *slot += sample;
                }
            }
        }
        out
    }

    #[test]
    fn finds_each_announcement() {
        let audio = track(&[(2.0, 0, 0.5), (12.0, 1, 0.6), (25.0, 0, 0.5)], 30.0);
        let analysis = analyze_guide(&audio, RATE, &[], None);
        let starts: Vec<f64> = analysis
            .announcements
            .iter()
            .map(|a| a.start_seconds)
            .collect();
        assert_eq!(starts.len(), 3, "{analysis:?}");
        for (found, expected) in starts.iter().zip([2.0, 12.0, 25.0]) {
            assert!((found - expected).abs() < 0.1, "{starts:?}");
        }
    }

    #[test]
    fn the_same_recording_said_again_is_one_group() {
        let audio = track(
            &[
                (2.0, 0, 0.5),
                (12.0, 1, 0.6),
                (25.0, 0, 0.5),
                (40.0, 2, 0.7),
                (50.0, 1, 0.6),
            ],
            55.0,
        );
        let analysis = analyze_guide(&audio, RATE, &[], None);
        let groups: Vec<usize> = analysis.announcements.iter().map(|a| a.group).collect();
        assert_eq!(groups, vec![0, 1, 0, 2, 1], "{analysis:?}");
        assert_eq!(analysis.groups[0].occurrences, 2);
        assert!((analysis.groups[1].first_start_seconds - 12.0).abs() < 0.1);
    }

    #[test]
    fn a_matching_clip_labels_its_group_and_others_stay_unlabelled() {
        let audio = track(&[(2.0, 0, 0.5), (12.0, 1, 0.6), (25.0, 0, 0.5)], 30.0);
        let templates = vec![GuideTemplate {
            label: "chorus".into(),
            samples: word(0, 0.5),
            sample_rate: RATE,
        }];
        let analysis = analyze_guide(&audio, RATE, &templates, None);
        assert_eq!(
            analysis.groups[0].labels,
            vec!["chorus".to_string()],
            "{analysis:?}"
        );
        assert!(analysis.groups[1].labels.is_empty(), "{analysis:?}");
    }

    /// Hears whatever it is told, by fragment length, and records the calls.
    struct FakeTranscriber {
        language_sample_seconds: f64,
        calls: Vec<f64>,
        answers: Vec<(f64, &'static str)>,
        progress: Vec<(usize, usize)>,
    }

    impl Transcriber for FakeTranscriber {
        fn detect_language(&mut self, speech: &[f32]) {
            self.language_sample_seconds = speech.len() as f64 / RECOGNITION_RATE;
        }

        fn progress(&mut self, done: usize, total: usize) {
            self.progress.push((done, total));
        }

        fn transcribe(&mut self, speech: &[f32]) -> Option<String> {
            let seconds = speech.len() as f64 / RECOGNITION_RATE;
            self.calls.push(seconds);
            self.answers
                .iter()
                .min_by(|a, b| (a.0 - seconds).abs().total_cmp(&(b.0 - seconds).abs()))
                .map(|(_, text)| text.to_string())
        }
    }

    #[test]
    fn speech_recognition_names_every_marker_of_each_group_once() {
        // Words of 0.5, 1.2 and 0.8 s; the 0.5 s one said twice.
        let audio = track(
            &[
                (2.0, 0, 0.5),
                (12.0, 1, 1.2),
                (25.0, 0, 0.5),
                (40.0, 2, 0.8),
            ],
            45.0,
        );
        let mut recogniser = FakeTranscriber {
            language_sample_seconds: 0.0,
            calls: Vec::new(),
            progress: Vec::new(),
            // Lengths include the 0.15 s padding on both sides.
            answers: vec![
                (0.8, "Coro."),
                (1.5, "Verso 3, entra batería."),
                (1.1, "Uno, dos, tres, cuatro."),
            ],
        };
        let analysis = analyze_guide(&audio, RATE, &[], Some(&mut recogniser));
        let labels: Vec<Vec<String>> = analysis.groups.iter().map(|g| g.labels.clone()).collect();
        assert_eq!(
            labels,
            vec![
                vec!["chorus".to_string()],
                vec!["verse_3".to_string(), "drums_in".to_string()],
                vec!["count".to_string()],
            ],
            "{analysis:?}"
        );
        // One recognition per group, not per announcement, with its count
        // known up front.
        assert_eq!(recogniser.calls.len(), 3);
        assert_eq!(recogniser.progress, vec![(0, 3), (1, 3), (2, 3), (3, 3)]);
        assert!(recogniser.language_sample_seconds > 1.0);
        assert_eq!(
            analysis.groups[1].transcript.as_deref(),
            Some("Verso 3, entra batería.")
        );
    }

    #[test]
    fn a_sure_clip_match_is_not_transcribed() {
        let audio = track(&[(2.0, 0, 0.5), (12.0, 1, 0.6)], 20.0);
        let templates = vec![GuideTemplate {
            label: "chorus".into(),
            samples: word(0, 0.5),
            sample_rate: RATE,
        }];
        let mut recogniser = FakeTranscriber {
            language_sample_seconds: 0.0,
            calls: Vec::new(),
            progress: Vec::new(),
            answers: vec![(0.9, "Puente.")],
        };
        let analysis = analyze_guide(&audio, RATE, &templates, Some(&mut recogniser));
        assert_eq!(analysis.groups[0].labels, vec!["chorus".to_string()]);
        assert_eq!(analysis.groups[1].labels, vec!["bridge".to_string()]);
        assert_eq!(
            recogniser.calls.len(),
            1,
            "only the unmatched group is transcribed"
        );
    }

    #[test]
    fn silence_has_no_announcements() {
        let analysis = analyze_guide(&vec![0.0; RATE as usize * 5], RATE, &[], None);
        assert!(analysis.announcements.is_empty());
        assert!(analysis.groups.is_empty());
    }
}
