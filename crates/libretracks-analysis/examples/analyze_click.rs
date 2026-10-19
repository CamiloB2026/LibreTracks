//! Analyse a click track WAV from the command line, to check the analyser on
//! real multitracks:
//!
//! ```text
//! cargo run -p libretracks-analysis --example analyze_click -- "Click.wav" [beats_per_bar]
//! ```
//!
//! With `ONSETS=1` it dumps every click's time, level and pitch instead.
//! With `EIGHTHS=1` it reads a click without accent as eighths (÷2).
//! With `DETAIL=simplified` or `DETAIL=initial` it prints that tempo map.

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .expect("usage: analyze_click <file.wav> [beats_per_bar]");
    let fallback = args.next().and_then(|n| n.parse().ok()).unwrap_or(4);
    let dump_onsets = std::env::var_os("ONSETS").is_some();
    let mut reader = hound::WavReader::open(&path).expect("readable WAV");
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
    let mono: Vec<f32> = samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    if dump_onsets {
        for (seconds, level_db, pitch) in
            libretracks_analysis::click::debug_onsets(&mono, spec.sample_rate)
        {
            println!("{seconds:>9.3} s  {level_db:>6.1} dB  {pitch:>7.0} Hz");
        }
        return;
    }
    let started = std::time::Instant::now();
    let analysis = if std::env::var_os("EIGHTHS").is_some() {
        libretracks_analysis::analyze_click_as_eighths(&mono, spec.sample_rate, fallback)
            .expect("a click without accent")
    } else {
        libretracks_analysis::analyze_click(&mono, spec.sample_rate, fallback)
    };
    println!(
        "{} s of audio analysed in {:.0} ms: {} beats, downbeat known: {}",
        mono.len() / spec.sample_rate as usize,
        started.elapsed().as_secs_f64() * 1000.0,
        analysis.beat_count,
        analysis.downbeat_known
    );
    let segments = match std::env::var("DETAIL").as_deref() {
        Ok("simplified") => libretracks_analysis::simplify_segments(&analysis.segments),
        Ok("initial") => libretracks_analysis::initial_tempo_only(&analysis.segments),
        _ => analysis.segments.clone(),
    };
    for segment in &segments {
        let ramp = segment
            .end_bpm
            .map(|to| format!(" -> {to:.2}"))
            .unwrap_or_default();
        println!(
            "  {:>8.3} s  {:>7.2} BPM{ramp}  {}  ({} bars)",
            segment.start_seconds,
            segment.bpm,
            segment.signature(),
            segment.bars
        );
    }
    for warning in &analysis.warnings {
        println!("  ! {:>8.3} s  {:?}", warning.seconds, warning.kind);
    }
}
