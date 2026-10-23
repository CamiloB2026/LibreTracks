#include <lt_engine/sources/sinc_interpolator.h>

#include <algorithm>
#include <cmath>
#include <numeric>

namespace lt {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Band edges, as fractions of the LOWER of the two rates. At 44.1k they are
// 18 kHz (must be flat) and 24.1 kHz: the image of a 20 kHz tone when
// upsampling to 48k (44.1 - 20) and, symmetrically, the alias that would land
// on 20 kHz when downsampling 48k -> 44.1k. The cutoff sits halfway.
constexpr double kPassEdge = 18000.0 / 44100.0;
constexpr double kStopEdge = 24100.0 / 44100.0;

// Zeroth-order modified Bessel function, power series. Only used to build the
// table, never on the audio thread.
double bessel_i0(double x) {
    double sum = 1.0;
    double term = 1.0;
    const double q = x * x / 4.0;
    for (int k = 1; k < 64; ++k) {
        term *= q / (static_cast<double>(k) * static_cast<double>(k));
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

// Kaiser's empirical beta for a stopband attenuation `atten_db`.
double kaiser_beta(double atten_db) {
    if (atten_db > 50.0) return 0.1102 * (atten_db - 8.7);
    if (atten_db >= 21.0)
        return 0.5842 * std::pow(atten_db - 21.0, 0.4) + 0.07886 * (atten_db - 21.0);
    return 0.0;
}

std::int64_t floor_div(std::int64_t a, std::int64_t b) {
    std::int64_t q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

} // namespace

SincInterpolator::SincInterpolator(int source_sample_rate, int target_sample_rate, int taps)
    : source_rate_(source_sample_rate), target_rate_(target_sample_rate) {
    const int g = std::gcd(source_sample_rate, target_sample_rate);
    num_ = source_sample_rate / g;
    den_ = target_sample_rate / g;

    const int lower = std::min(source_sample_rate, target_sample_rate);
    const double stretch = static_cast<double>(source_sample_rate) / lower;
    const int base_taps = std::max(2, taps);
    length_ = static_cast<int>(std::ceil(base_taps * stretch));
    length_ += length_ & 1;
    lead_ = length_ / 2 - 1;

    // Attenuation the window can reach across the transition band with this
    // many taps (Kaiser's length formula, inverted). Capped: past ~140 dB the
    // float table and accumulator are the limit, not the window.
    const double transition = kStopEdge - kPassEdge;
    const double atten =
        std::min(140.0, 2.285 * 2.0 * kPi * transition * (base_taps - 1) + 8.0);
    const double beta = kaiser_beta(atten);
    const double i0_beta = bessel_i0(beta);

    // Cutoff in cycles per source frame, scaled so sinc(fc * t) has its first
    // zero at 1 / fc source frames.
    const double cutoff = 0.5 * (kPassEdge + kStopEdge) * lower;
    const double fc = 2.0 * cutoff / source_sample_rate;
    const double half = 0.5 * length_;

    table_.assign(static_cast<std::size_t>(den_) * static_cast<std::size_t>(length_), 0.0f);
    std::vector<double> row(static_cast<std::size_t>(length_));
    for (std::int64_t p = 0; p < den_; ++p) {
        const double frac = static_cast<double>(p) / static_cast<double>(den_);
        double sum = 0.0;
        for (int j = 0; j < length_; ++j) {
            const double t = static_cast<double>(j - lead_) - frac;
            const double x = fc * t;
            const double sinc = std::fabs(x) < 1e-12 ? 1.0 : std::sin(kPi * x) / (kPi * x);
            const double r = t / half;
            const double w = std::fabs(r) >= 1.0
                ? 0.0
                : bessel_i0(beta * std::sqrt(1.0 - r * r)) / i0_beta;
            row[static_cast<std::size_t>(j)] = fc * sinc * w;
            sum += row[static_cast<std::size_t>(j)];
        }
        // Unity DC gain on every phase: a phase-dependent gain would modulate
        // the output at the phase period (300 Hz for 44.1 -> 48).
        float* dst = table_.data() + static_cast<std::size_t>(p) * static_cast<std::size_t>(length_);
        for (int j = 0; j < length_; ++j)
            dst[j] = static_cast<float>(row[static_cast<std::size_t>(j)] / sum);
    }
}

void SincInterpolator::source_span(Frame out_start, Frame out_frames,
                                   Frame& first, Frame& last) const {
    if (out_frames <= 0) {
        first = last = floor_div(out_start * num_, den_);
        return;
    }
    first = floor_div(out_start * num_, den_) - lead_;
    last = floor_div((out_start + out_frames - 1) * num_, den_) - lead_ + length_;
}

Frame SincInterpolator::output_length(Frame source_frames) const {
    if (source_frames <= 0) return 0;
    return (source_frames * den_ + num_ - 1) / num_;
}

void SincInterpolator::render(const float* window, Frame window_start, Frame window_frames,
                              int channels, Frame out_start, Frame out_frames,
                              float* out) const {
    const std::size_t ch = static_cast<std::size_t>(channels);
    const Frame window_end = window_start + window_frames;
    for (Frame i = 0; i < out_frames; ++i) {
        const std::int64_t pos = (out_start + i) * num_;
        const std::int64_t k0 = floor_div(pos, den_);
        const std::int64_t phase = pos - k0 * den_;
        const float* h = table_.data() + static_cast<std::size_t>(phase) *
                                             static_cast<std::size_t>(length_);
        const Frame base = k0 - lead_;
        float* y = out + static_cast<std::size_t>(i) * ch;

        if (base >= window_start && base + length_ <= window_end) {
            const float* x = window + static_cast<std::size_t>(base - window_start) * ch;
            for (std::size_t c = 0; c < ch; ++c) {
                float acc = 0.0f;
                for (int j = 0; j < length_; ++j)
                    acc += x[static_cast<std::size_t>(j) * ch + c] * h[j];
                y[c] = acc;
            }
            continue;
        }

        // Kernel overlaps the window edge: missing frames are silence. The
        // taps are summed in the same order as above, so a frame computed
        // here equals the fast path whenever the missing frames are zeros.
        for (std::size_t c = 0; c < ch; ++c) {
            float acc = 0.0f;
            for (int j = 0; j < length_; ++j) {
                const Frame k = base + j;
                const float x = (k >= window_start && k < window_end)
                    ? window[static_cast<std::size_t>(k - window_start) * ch + c]
                    : 0.0f;
                acc += x * h[j];
            }
            y[c] = acc;
        }
    }
}

} // namespace lt
