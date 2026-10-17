//! Signal helpers shared by the analyses.

/// Analysis rate for the key and the tempo of the music: what they listen to
/// lives below ~5 kHz.
pub(crate) const TARGET_RATE: f64 = 11_025.0;

/// Low-pass (windowed sinc) and keep one sample in `factor`.
pub(crate) fn decimate(samples: &[f32], rate: f64) -> (Vec<f32>, f64) {
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
