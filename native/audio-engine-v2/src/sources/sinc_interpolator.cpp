#include <lt_engine/sources/sinc_interpolator.h>

#include <algorithm>
#include <cmath>
#include <numeric>

#if defined(__aarch64__) || defined(_M_ARM64)
#  include <arm_neon.h>
#  define LT_SINC_NEON 1
#elif defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
#  include <emmintrin.h>
#  define LT_SINC_SSE 1
#endif

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

// Both kernels are deliberately out of line: the fast path and the edge path
// call the SAME machine code, so the compiler cannot contract or reorder the
// two differently, and an edge frame stays bit-identical to the fast path.
//
// Four independent accumulators (tap j goes to lane j % 4) break the add
// dependency chain; the lane sums are combined in a fixed order.
#if defined(_MSC_VER)
__declspec(noinline)
#else
__attribute__((noinline))
#endif
float dot_strided(const float* x, std::size_t stride, const float* h, int length) {
    float a0 = 0.0f, a1 = 0.0f, a2 = 0.0f, a3 = 0.0f;
    for (int j = 0; j < length; j += 4) {
        a0 += x[static_cast<std::size_t>(j) * stride] * h[j];
        a1 += x[static_cast<std::size_t>(j + 1) * stride] * h[j + 1];
        a2 += x[static_cast<std::size_t>(j + 2) * stride] * h[j + 2];
        a3 += x[static_cast<std::size_t>(j + 3) * stride] * h[j + 3];
    }
    return (a0 + a1) + (a2 + a3);
}

// Stereo interleaved: `hd` holds each tap twice (h0 h0 h1 h1 ...) so the
// window is read as one contiguous run, eight frames (16 floats) per step into
// four vector accumulators (one would stall on the add/FMA latency). Even lanes are left, odd lanes right. Written with
// intrinsics because a float sum is not reassociated by the compiler on its
// own (no -ffast-math), so the plain loop stays scalar.
#if defined(_MSC_VER)
__declspec(noinline)
#else
__attribute__((noinline))
#endif
void dot_stereo(const float* x, const float* hd, int length, float* y) {
    const int n = length * 2;
#if LT_SINC_NEON
    float32x4_t a = vdupq_n_f32(0.0f), b = a, c = a, d = a;
    for (int i = 0; i < n; i += 16) {
        a = vfmaq_f32(a, vld1q_f32(x + i), vld1q_f32(hd + i));
        b = vfmaq_f32(b, vld1q_f32(x + i + 4), vld1q_f32(hd + i + 4));
        c = vfmaq_f32(c, vld1q_f32(x + i + 8), vld1q_f32(hd + i + 8));
        d = vfmaq_f32(d, vld1q_f32(x + i + 12), vld1q_f32(hd + i + 12));
    }
    const float32x4_t s = vaddq_f32(vaddq_f32(a, b), vaddq_f32(c, d));  // L R L R
    const float32x2_t lr = vadd_f32(vget_low_f32(s), vget_high_f32(s));
    y[0] = vget_lane_f32(lr, 0);
    y[1] = vget_lane_f32(lr, 1);
#elif LT_SINC_SSE
    __m128 a = _mm_setzero_ps(), b = a, c = a, d = a;
    for (int i = 0; i < n; i += 16) {
        a = _mm_add_ps(a, _mm_mul_ps(_mm_loadu_ps(x + i), _mm_loadu_ps(hd + i)));
        b = _mm_add_ps(b, _mm_mul_ps(_mm_loadu_ps(x + i + 4), _mm_loadu_ps(hd + i + 4)));
        c = _mm_add_ps(c, _mm_mul_ps(_mm_loadu_ps(x + i + 8), _mm_loadu_ps(hd + i + 8)));
        d = _mm_add_ps(d, _mm_mul_ps(_mm_loadu_ps(x + i + 12), _mm_loadu_ps(hd + i + 12)));
    }
    const __m128 s = _mm_add_ps(_mm_add_ps(a, b), _mm_add_ps(c, d));  // L R L R
    const __m128 lr = _mm_add_ps(s, _mm_movehl_ps(s, s));
    y[0] = _mm_cvtss_f32(lr);
    y[1] = _mm_cvtss_f32(_mm_shuffle_ps(lr, lr, 1));
#else
    float a[16] = {};
    for (int i = 0; i < n; i += 16)
        for (int k = 0; k < 16; ++k) a[k] += x[i + k] * hd[i + k];
    y[0] = ((a[0] + a[4]) + (a[8] + a[12])) + ((a[2] + a[6]) + (a[10] + a[14]));
    y[1] = ((a[1] + a[5]) + (a[9] + a[13])) + ((a[3] + a[7]) + (a[11] + a[15]));
#endif
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
    // Multiple of 8 so the stereo kernel's 16 lanes divide the taps evenly.
    length_ = std::min(kMaxKernel, static_cast<int>(std::ceil(base_taps * stretch)));
    length_ = (length_ + 7) & ~7;
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

    stereo_table_.resize(table_.size() * 2);
    for (std::size_t i = 0; i < table_.size(); ++i)
        stereo_table_[2 * i] = stereo_table_[2 * i + 1] = table_[i];
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
    // Integer position of the first frame, then advanced by num_/den_ per
    // frame without dividing: still exact, k0 and phase are the same integers
    // a division would give.
    std::int64_t k0 = floor_div(out_start * num_, den_);
    std::int64_t phase = out_start * num_ - k0 * den_;
    for (Frame i = 0; i < out_frames; ++i) {
        if (i > 0) {
            phase += num_;
            while (phase >= den_) { phase -= den_; ++k0; }
        }
        const float* h = table_.data() + static_cast<std::size_t>(phase) *
                                             static_cast<std::size_t>(length_);
        const Frame base = k0 - lead_;
        float* y = out + static_cast<std::size_t>(i) * ch;

        const bool inside = base >= window_start && base + length_ <= window_end;

        if (ch == 2) {
            const float* hd = stereo_table_.data() + static_cast<std::size_t>(phase) *
                                                         static_cast<std::size_t>(length_) * 2;
            if (inside) {
                dot_stereo(window + static_cast<std::size_t>(base - window_start) * 2,
                           hd, length_, y);
                continue;
            }
            // Kernel overlaps the window edge: missing frames are silence.
            float gathered[kMaxKernel * 2];
            for (int j = 0; j < length_; ++j) {
                const Frame k = base + j;
                const bool in = k >= window_start && k < window_end;
                const std::size_t src = static_cast<std::size_t>(k - window_start) * 2;
                gathered[2 * j] = in ? window[src] : 0.0f;
                gathered[2 * j + 1] = in ? window[src + 1] : 0.0f;
            }
            dot_stereo(gathered, hd, length_, y);
            continue;
        }

        for (std::size_t c = 0; c < ch; ++c) {
            if (inside) {
                y[c] = dot_strided(window + static_cast<std::size_t>(base - window_start) * ch + c,
                                   ch, h, length_);
                continue;
            }
            float gathered[kMaxKernel];
            for (int j = 0; j < length_; ++j) {
                const Frame k = base + j;
                gathered[j] = (k >= window_start && k < window_end)
                    ? window[static_cast<std::size_t>(k - window_start) * ch + c]
                    : 0.0f;
            }
            y[c] = dot_strided(gathered, 1, h, length_);
        }
    }
}

} // namespace lt
