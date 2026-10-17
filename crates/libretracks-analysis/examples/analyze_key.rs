//! Analyse the key of a mix of WAV stems from the command line, to check the
//! analyser on real multitracks:
//!
//! ```text
//! cargo run --release -p libretracks-analysis --example analyze_key -- "Keys.wav" "Bass.wav[@offset_s]" …
//! ```
//!
//! Stems are summed to mono from their start (or from `@offset_s`, the stem's
//! position in the song); all must share the first file's sample rate.

fn read_mono(path: &str) -> (Vec<f32>, u32) {
    let mut reader = hound::WavReader::open(path).unwrap_or_else(|e| panic!("{path}: {e}"));
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
    (mono, spec.sample_rate)
}

fn main() {
    let mut mix: Vec<f32> = Vec::new();
    let mut rate = 0;
    for argument in std::env::args().skip(1) {
        let (path, offset) = match argument.rsplit_once('@') {
            Some((path, offset)) if offset.parse::<f64>().is_ok() => {
                (path.to_string(), offset.parse::<f64>().unwrap_or(0.0))
            }
            _ => (argument.clone(), 0.0),
        };
        let (stem, stem_rate) = read_mono(&path);
        if rate == 0 {
            rate = stem_rate;
        } else if stem_rate != rate {
            eprintln!("skipping {path}: {stem_rate} Hz, mix is {rate} Hz");
            continue;
        }
        let start = (offset * f64::from(rate)).max(0.0) as usize;
        if mix.len() < start + stem.len() {
            mix.resize(start + stem.len(), 0.0);
        }
        for (i, sample) in stem.iter().enumerate() {
            mix[start + i] += sample;
        }
    }
    let started = std::time::Instant::now();
    let analysis = libretracks_analysis::analyze_key(&mix, rate);
    println!(
        "{:?} (alt {:?}, relative doubt {}, margin {:.3}, tuning {:+.0} cents) in {:.0} ms",
        analysis.key,
        analysis.alternative,
        analysis.relative_doubt,
        analysis.confidence,
        analysis.tuning_cents,
        started.elapsed().as_secs_f64() * 1000.0
    );
    for candidate in &analysis.candidates {
        println!("  {:<4} {:.3}", candidate.key, candidate.score);
    }
}
