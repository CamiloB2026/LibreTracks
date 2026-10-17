//! A small in-place radix-2 FFT: enough for the key analysis' STFT, without a
//! dependency that would have to build for every target (Android, iOS).

/// In-place forward FFT of `re`/`im` (length a power of two).
pub(crate) fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    // Bit reversal.
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut length = 2;
    while length <= n {
        let angle = -std::f64::consts::TAU / length as f64;
        let (w_im, w_re) = angle.sin_cos();
        for start in (0..n).step_by(length) {
            let (mut cur_re, mut cur_im) = (1.0_f64, 0.0_f64);
            for k in 0..length / 2 {
                let a = start + k;
                let b = a + length / 2;
                let t_re = re[b] as f64 * cur_re - im[b] as f64 * cur_im;
                let t_im = re[b] as f64 * cur_im + im[b] as f64 * cur_re;
                re[b] = (re[a] as f64 - t_re) as f32;
                im[b] = (im[a] as f64 - t_im) as f32;
                re[a] = (re[a] as f64 + t_re) as f32;
                im[a] = (im[a] as f64 + t_im) as f32;
                let next_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = next_re;
            }
        }
        length <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sine_lands_in_its_bin() {
        let n = 1024;
        let mut re: Vec<f32> = (0..n)
            .map(|i| (std::f64::consts::TAU * 37.0 * i as f64 / n as f64).sin() as f32)
            .collect();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im);
        let magnitude = |k: usize| (re[k] * re[k] + im[k] * im[k]).sqrt();
        let peak = (0..n / 2).max_by(|a, b| magnitude(*a).total_cmp(&magnitude(*b)));
        assert_eq!(peak, Some(37));
        assert!((magnitude(37) - n as f32 / 2.0).abs() < 1.0);
    }
}
