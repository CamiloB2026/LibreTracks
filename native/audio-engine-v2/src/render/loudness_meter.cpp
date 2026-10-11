#include <lt_engine/render/loudness_meter.h>

#include <algorithm>
#include <cmath>

namespace lt {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kAbsoluteGateLufs = -70.0;
constexpr double kIntegratedRelativeGateLu = -10.0;   // BS.1770-4
constexpr double kRangeRelativeGateLu = -20.0;        // EBU Tech 3342
constexpr std::size_t kBlockSegments = 4;             // 400 ms momentary block
constexpr std::size_t kShortTermSegments = 30;        // 3 s short-term window

double loudness_of(double mean_square) noexcept {
    return mean_square > 0.0 ? -0.691 + 10.0 * std::log10(mean_square) : -1000.0;
}

// Mean square of every window of `width` consecutive segments, hop one segment.
std::vector<double> window_energies(const std::vector<double>& segments, std::size_t width) {
    std::vector<double> out;
    if (segments.size() < width) return out;
    double sum = 0.0;
    for (std::size_t i = 0; i < width; ++i) sum += segments[i];
    out.push_back(sum / static_cast<double>(width));
    for (std::size_t i = width; i < segments.size(); ++i) {
        sum += segments[i] - segments[i - width];
        out.push_back(std::max(0.0, sum) / static_cast<double>(width));
    }
    return out;
}

// The energies above the absolute gate and above `relative_lu` below their own
// mean: BS.1770's two-stage gate.
std::vector<double> gated(const std::vector<double>& energies, double relative_lu) {
    std::vector<double> above_absolute;
    for (const double e : energies)
        if (loudness_of(e) > kAbsoluteGateLufs) above_absolute.push_back(e);
    if (above_absolute.empty()) return above_absolute;
    double mean = 0.0;
    for (const double e : above_absolute) mean += e;
    mean /= static_cast<double>(above_absolute.size());
    const double relative_gate = loudness_of(mean) + relative_lu;
    std::vector<double> kept;
    for (const double e : above_absolute)
        if (loudness_of(e) > relative_gate) kept.push_back(e);
    return kept;
}

double percentile(const std::vector<double>& sorted, double q) {
    const auto index = static_cast<std::size_t>(
        std::llround(q * static_cast<double>(sorted.size() - 1)));
    return sorted[std::min(index, sorted.size() - 1)];
}

} // namespace

LoudnessMeter::LoudnessMeter(int sample_rate) {
    const double rate = static_cast<double>(std::max(8000, sample_rate));
    // K-weighting for any sample rate: the analogue prototypes of BS.1770's
    // 48 kHz coefficients, bilinear-transformed (same derivation libebur128 uses).
    Biquad shelf;
    {
        const double f0 = 1681.974450955533;
        const double gain_db = 3.999843853973347;
        const double q = 0.7071752369554196;
        const double k = std::tan(kPi * f0 / rate);
        const double vh = std::pow(10.0, gain_db / 20.0);
        const double vb = std::pow(vh, 0.4996667741545416);
        const double a0 = 1.0 + k / q + k * k;
        shelf.b0 = (vh + vb * k / q + k * k) / a0;
        shelf.b1 = 2.0 * (k * k - vh) / a0;
        shelf.b2 = (vh - vb * k / q + k * k) / a0;
        shelf.a1 = 2.0 * (k * k - 1.0) / a0;
        shelf.a2 = (1.0 - k / q + k * k) / a0;
    }
    Biquad highpass;
    {
        const double f0 = 38.13547087602444;
        const double q = 0.5003270373238773;
        const double k = std::tan(kPi * f0 / rate);
        const double a0 = 1.0 + k / q + k * k;
        highpass.b0 = 1.0;
        highpass.b1 = -2.0;
        highpass.b2 = 1.0;
        highpass.a1 = 2.0 * (k * k - 1.0) / a0;
        highpass.a2 = (1.0 - k / q + k * k) / a0;
    }
    for (int ch = 0; ch < 2; ++ch) {
        shelf_[ch] = shelf;
        highpass_[ch] = highpass;
    }
    segment_frames_ = static_cast<std::size_t>(std::llround(rate / 10.0));
}

void LoudnessMeter::process(const float* left, const float* right, std::size_t frames) noexcept {
    for (std::size_t i = 0; i < frames; ++i) {
        peak_ = std::max(peak_, std::max(std::abs(left[i]), std::abs(right[i])));
        const double zl = highpass_[0].run(shelf_[0].run(left[i]));
        const double zr = highpass_[1].run(shelf_[1].run(right[i]));
        segment_energy_ += zl * zl + zr * zr;
        if (++segment_fill_ == segment_frames_) {
            segments_.push_back(segment_energy_ / static_cast<double>(segment_frames_));
            segment_energy_ = 0.0;
            segment_fill_ = 0;
        }
    }
}

LoudnessStats LoudnessMeter::finish() const {
    LoudnessStats stats;
    stats.sample_peak = peak_;

    const auto blocks = gated(window_energies(segments_, kBlockSegments),
                              kIntegratedRelativeGateLu);
    if (blocks.empty()) return stats;
    double mean = 0.0;
    for (const double e : blocks) mean += e;
    stats.integrated_lufs = loudness_of(mean / static_cast<double>(blocks.size()));
    stats.has_signal = true;

    auto short_term = gated(window_energies(segments_, kShortTermSegments),
                            kRangeRelativeGateLu);
    if (short_term.empty()) {
        // Shorter than one 3 s window: the integrated figure is all there is.
        stats.loud_lufs = stats.integrated_lufs;
        return stats;
    }
    std::vector<double> values;
    values.reserve(short_term.size());
    for (const double e : short_term) values.push_back(loudness_of(e));
    std::sort(values.begin(), values.end());
    stats.loud_lufs = percentile(values, 0.90);
    stats.loudness_range_lu = percentile(values, 0.95) - percentile(values, 0.10);
    return stats;
}

} // namespace lt
