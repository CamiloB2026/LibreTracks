//! Estimate the tempo of a mix of WAV stems without their click, and compare
//! it with the click's when one is given:
//!
//! ```text
//! cargo run --release -p libretracks-analysis --example analyze_music_tempo -- [--click Click.wav] Drums.wav Bass.wav …
//! ```

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
    let mut args = std::env::args().skip(1).peekable();
    let mut click = None;
    let mut mix: Vec<f32> = Vec::new();
    let mut rate = 0;
    while let Some(argument) = args.next() {
        if argument == "--click" {
            click = args.next();
            continue;
        }
        let (stem, stem_rate) = read_mono(&argument);
        if rate == 0 {
            rate = stem_rate;
        } else if stem_rate != rate {
            eprintln!("skipping {argument}: {stem_rate} Hz, mix is {rate} Hz");
            continue;
        }
        if mix.len() < stem.len() {
            mix.resize(stem.len(), 0.0);
        }
        for (i, sample) in stem.iter().enumerate() {
            mix[i] += sample;
        }
    }
    if std::env::var_os("SWEEP").is_some() {
        let mut line = Vec::new();
        for double in [0.0, 0.25, 0.5] {
            for quadruple in [0.0, 0.25] {
                for center in [90.0, 100.0, 110.0, 120.0] {
                    for octaves in [0.8, 1.0, 1.4] {
                        let scoring = libretracks_analysis::music::TempoScoring {
                            double_weight: double,
                            quadruple_weight: quadruple,
                            center_bpm: center,
                            octaves,
                        };
                        let bpm =
                            libretracks_analysis::music::debug_pick_tempo(&mix, rate, scoring)
                                .unwrap_or(0.0);
                        line.push(format!("{double}/{quadruple}/{center}/{octaves}={bpm:.1}"));
                    }
                }
            }
        }
        println!("sweep: {}", line.join(" "));
    }
    if std::env::var_os("TEMPOGRAM").is_some() {
        for (bpm, score, _) in libretracks_analysis::music::debug_tempogram(&mix, rate) {
            println!("  {bpm:>7.2} BPM  {score:.4}");
        }
    }
    let started = std::time::Instant::now();
    let music = libretracks_analysis::analyze_music_tempo(&mix, rate, 4);
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let describe = |analysis: &libretracks_analysis::ClickAnalysis| {
        analysis
            .segments
            .iter()
            .take(3)
            .map(|s| format!("{:.2}@{:.2}s {}", s.bpm, s.start_seconds, s.signature()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let warnings: Vec<String> = music
        .warnings
        .iter()
        .map(|w| format!("{:?}", w.kind))
        .collect();
    println!(
        "music: [{}] ({} segments, {:.0} ms) {:?}",
        describe(&music),
        music.segments.len(),
        elapsed,
        warnings
    );
    if let Some(path) = click {
        let (samples, click_rate) = read_mono(&path);
        let truth = libretracks_analysis::analyze_click(&samples, click_rate, 4);
        println!("click: [{}]", describe(&truth));
    }
}
