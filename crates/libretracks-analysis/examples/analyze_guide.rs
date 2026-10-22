//! Find, group and label the announcements of a guide (cue) track, with the
//! app's voice-guide clips as templates:
//!
//! ```text
//! cargo run --release -p libretracks-analysis --example analyze_guide -- <voices dir> Guide.wav
//! ```
//!
//! `<voices dir>` is `apps/desktop/src-tauri/resources/voices`; every
//! language's `sections`, `cues` and `counts` clips are loaded.

use libretracks_analysis::{analyze_guide, GuideTemplate};

fn read_mono(path: &std::path::Path) -> Option<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap_or(0) as f32 * scale)
                .collect()
        }
    };
    let mono = samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    Some((mono, spec.sample_rate))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let voices = std::path::PathBuf::from(args.next().expect("voices dir"));
    let guide = args.next().expect("guide wav");
    let mut templates = Vec::new();
    for language in ["es", "en"] {
        for folder in ["sections", "cues", "counts"] {
            let Ok(entries) = std::fs::read_dir(voices.join(language).join(folder)) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default();
                let label = if folder == "counts" {
                    format!("count_{stem}")
                } else {
                    stem.to_string()
                };
                if let Some((samples, sample_rate)) = read_mono(&path) {
                    templates.push(GuideTemplate {
                        label: format!("{label}@{language}"),
                        samples,
                        sample_rate,
                    });
                }
            }
        }
    }
    let (samples, rate) = read_mono(std::path::Path::new(&guide)).expect("readable guide");
    let started = std::time::Instant::now();
    let analysis = analyze_guide(&samples, rate, &templates, None);
    println!(
        "{} announcements, {} groups, {} templates, {:.0} ms",
        analysis.announcements.len(),
        analysis.groups.len(),
        templates.len(),
        started.elapsed().as_secs_f64() * 1000.0
    );
    for announcement in &analysis.announcements {
        let group = &analysis.groups[announcement.group];
        println!(
            "  {:>7.2}-{:>7.2}s  group {:>2}  {:<22} cost {}",
            announcement.start_seconds,
            announcement.end_seconds,
            announcement.group,
            if group.labels.is_empty() {
                "?".to_string()
            } else {
                group.labels.join("+")
            },
            group.match_cost.map_or("-".into(), |c| format!("{c:.2}"))
        );
    }
}
