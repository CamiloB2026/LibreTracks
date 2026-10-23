#include <doctest/doctest.h>

#include <lt_engine/sources/resampler.h>
#include <lt_engine/sources/sinc_interpolator.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <random>
#include <vector>

using namespace lt;

// ---------------------------------------------------------------------------
// Plan realtime-resample, step 1: can a stateless interpolator replace the
// source-cache copy? Two gates, either of which closes the plan:
//
//   E1  a stream started at any frame is BIT-IDENTICAL to the same frames of a
//       stream started at 0 (r8brain misses this by -43 dBFS, see
//       test_resampler_seek_continuity.cpp);
//   E2  flat to 18 kHz within +-0.1 dB and images/aliasing below -90 dB for
//       tones up to 20 kHz, plus a null test against the r8brain conversion
//       the cache ships today.
//
// Quality is measured at 16, 32 and 64 taps; the gates are asserted on the
// configuration that has to pass (64). Step 2 decides what the CPU allows.
// ---------------------------------------------------------------------------

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<float> make_broadband(Frame frames, int channels, int rate, float noise_amp = 0.02f) {
    // Tones across the band plus low-level noise: a pure tone would hide
    // errors that only show where the kernel's taps disagree.
    std::mt19937 rng(1234);
    std::uniform_real_distribution<float> noise(-noise_amp, noise_amp);
    std::vector<float> s(static_cast<std::size_t>(frames) * static_cast<std::size_t>(channels));
    for (Frame f = 0; f < frames; ++f) {
        const double t = static_cast<double>(f) / rate;
        const double v = 0.30 * std::sin(2.0 * kPi * 220.0 * t)
                       + 0.20 * std::sin(2.0 * kPi * 1310.0 * t)
                       + 0.15 * std::sin(2.0 * kPi * 6100.0 * t)
                       + 0.10 * std::sin(2.0 * kPi * 13700.0 * t);
        for (int c = 0; c < channels; ++c)
            s[static_cast<std::size_t>(f) * static_cast<std::size_t>(channels) +
              static_cast<std::size_t>(c)] =
                static_cast<float>(c == 0 ? v : -0.8 * v) + noise(rng);
    }
    return s;
}

// Render output frames [out_start, out_start + out_frames) the way the engine
// would: block by block, each block handed ONLY the source span it reads
// (clamped to the file), never the whole file.
std::vector<float> render_blocks(const SincInterpolator& si, const std::vector<float>& src,
                                 int channels, Frame out_start, Frame out_frames, Frame block) {
    const Frame src_frames = static_cast<Frame>(src.size() / static_cast<std::size_t>(channels));
    std::vector<float> out(static_cast<std::size_t>(out_frames) * static_cast<std::size_t>(channels));
    for (Frame done = 0; done < out_frames; done += block) {
        const Frame n = std::min(block, out_frames - done);
        Frame first = 0, last = 0;
        si.source_span(out_start + done, n, first, last);
        first = std::clamp<Frame>(first, 0, src_frames);
        last = std::clamp<Frame>(last, 0, src_frames);
        si.render(src.data() + static_cast<std::size_t>(first) * static_cast<std::size_t>(channels),
                  first, last - first, channels, out_start + done, n,
                  out.data() + static_cast<std::size_t>(done) * static_cast<std::size_t>(channels));
    }
    return out;
}

std::vector<float> make_tone(double freq, double amp, Frame frames, int rate) {
    std::vector<float> s(static_cast<std::size_t>(frames));
    for (Frame f = 0; f < frames; ++f)
        s[static_cast<std::size_t>(f)] =
            static_cast<float>(amp * std::sin(2.0 * kPi * freq * f / rate));
    return s;
}

struct ToneFit {
    double gain_db;      // output amplitude vs input amplitude
    double residual_db;  // everything that is not the tone, vs the tone
};

// Least-squares fit of a sinusoid at `freq` over the interior of `y` (edges
// excluded: there the kernel reads past the file and sees silence).
ToneFit fit_tone(const std::vector<float>& y, double freq, int rate, double in_amp, Frame skip) {
    const Frame n = static_cast<Frame>(y.size()) - 2 * skip;
    double ss = 0, cc = 0, sc = 0, ys = 0, yc = 0;
    for (Frame i = skip; i < skip + n; ++i) {
        const double w = 2.0 * kPi * freq * i / rate;
        const double s = std::sin(w), c = std::cos(w);
        const double v = y[static_cast<std::size_t>(i)];
        ss += s * s; cc += c * c; sc += s * c; ys += v * s; yc += v * c;
    }
    const double det = ss * cc - sc * sc;
    const double a = (ys * cc - yc * sc) / det;
    const double b = (yc * ss - ys * sc) / det;
    double res = 0;
    for (Frame i = skip; i < skip + n; ++i) {
        const double w = 2.0 * kPi * freq * i / rate;
        const double e = y[static_cast<std::size_t>(i)] - (a * std::sin(w) + b * std::cos(w));
        res += e * e;
    }
    const double amp = std::sqrt(a * a + b * b);
    const double res_rms = std::sqrt(res / static_cast<double>(n));
    return {20.0 * std::log10(amp / in_amp),
            20.0 * std::log10(res_rms / (amp / std::sqrt(2.0)))};
}

bool bit_identical(const std::vector<float>& a, std::size_t a_off,
                   const std::vector<float>& b, std::size_t b_off, std::size_t count) {
    if (a_off + count > a.size() || b_off + count > b.size()) return false;
    return std::memcmp(a.data() + a_off, b.data() + b_off, count * sizeof(float)) == 0;
}

} // namespace

TEST_CASE("sinc interpolator reduces the ratio to an exact fraction") {
    SincInterpolator up(44100, 48000, 64);
    CHECK(up.ratio_num() == 147);
    CHECK(up.ratio_den() == 160);
    CHECK(up.kernel_length() == 64);

    // Downsampling stretches the kernel so the cutoff follows 44.1k's Nyquist.
    SincInterpolator down(48000, 44100, 64);
    CHECK(down.ratio_num() == 160);
    CHECK(down.ratio_den() == 147);
    CHECK(down.kernel_length() == 72);  // 64 * 48/44.1, rounded up to a multiple of 8
}

TEST_CASE("E1: a stream started mid-file is bit-identical to one started at 0") {
    constexpr Frame kSrcFrames = 44100 * 3;
    // Stereo has its own kernel; mono and 3 channels take the generic one.
    for (int kChannels : {2, 1, 3})
    for (int taps : {16, 32, 64}) {
        const auto signal = make_broadband(kSrcFrames, kChannels, 44100);
        SincInterpolator si(44100, 48000, taps);
        const Frame total_out = si.output_length(kSrcFrames);
        const auto full = render_blocks(si, signal, kChannels, 0, total_out, 512);

        // Different block size from the start: block boundaries must not matter.
        const auto odd_blocks = render_blocks(si, signal, kChannels, 0, total_out, 333);
        CHECK(bit_identical(full, 0, odd_blocks, 0, full.size()));

        // Seeks on the 147:160 ratio boundary and off it (julio: the off-boundary
        // ones were up to 5x worse with r8brain), plus the file's first frames
        // where the kernel reads silence before frame 0.
        for (Frame seek : {Frame{96000}, Frame{96001}, Frame{96037}, Frame{96073},
                           Frame{1}, Frame{7}, total_out - 100}) {
            const Frame len = std::min<Frame>(8192, total_out - seek);
            const auto seeked = render_blocks(si, signal, kChannels, seek, len, 512);
            INFO("channels=", kChannels, " taps=", taps, " seek=", seek);
            CHECK(bit_identical(full, static_cast<std::size_t>(seek) * kChannels,
                                seeked, 0, static_cast<std::size_t>(len) * kChannels));
        }
    }
}

TEST_CASE("E1: phase does not drift over a 10-minute song") {
    // Output frame 48000*600 must read source frame 44100*600 with phase 0,
    // exactly as output frame 0 reads source frame 0. An impulse placed at each
    // gives the same kernel bit for bit only if no drift accumulated.
    SincInterpolator si(44100, 48000, 64);
    const int len = si.kernel_length();
    std::vector<float> window(static_cast<std::size_t>(len) * 2, 0.0f);
    window[static_cast<std::size_t>(len)] = 1.0f;

    constexpr Frame kOut = 48000LL * 600;
    constexpr Frame kSrc = 44100LL * 600;
    std::vector<float> at_zero(64), at_ten_min(64);
    si.render(window.data(), -len, len * 2, 1, 0, 64, at_zero.data());
    si.render(window.data(), kSrc - len, len * 2, 1, kOut, 64, at_ten_min.data());
    CHECK(bit_identical(at_zero, 0, at_ten_min, 0, at_zero.size()));
    CHECK(at_zero[0] > 0.9f);
}

TEST_CASE("E2: frequency response and images, 44.1k -> 48k and back") {
    constexpr double kAmp = 0.5;
    constexpr Frame kSkip = 2048;

    struct Dir { int src, dst; };
    for (Dir d : {Dir{44100, 48000}, Dir{48000, 44100}}) {
        for (int taps : {16, 32, 64}) {
            SincInterpolator si(d.src, d.dst, taps);
            double worst_gain = 0.0;     // |dB| up to 18 kHz
            double worst_residual = -300.0;  // dB up to 20 kHz
            for (double f : {100.0, 1000.0, 5000.0, 10000.0, 15000.0, 18000.0, 19000.0, 20000.0}) {
                const auto in = make_tone(f, kAmp, d.src, d.src);
                const auto out = render_blocks(si, in, 1, 0, si.output_length(d.src), 512);
                const ToneFit fit = fit_tone(out, f, d.dst, kAmp, kSkip);
                if (f <= 18000.0) worst_gain = std::max(worst_gain, std::fabs(fit.gain_db));
                worst_residual = std::max(worst_residual, fit.residual_db);
            }
            MESSAGE(d.src, " -> ", d.dst, " taps=", taps,
                    "  max |gain| to 18k: ", worst_gain, " dB",
                    "  worst residual to 20k: ", worst_residual, " dB");
            if (taps == 64) {
                CHECK(worst_gain <= 0.1);
                CHECK(worst_residual <= -90.0);
            }
        }
    }
}

TEST_CASE("E2: transition-band content above 44.1k's Nyquist, 48k -> 44.1k") {
    // A 23 kHz tone cannot exist at 44.1k; what comes out is its alias at
    // 21.1 kHz. By design this band is NOT rejected to -90 dB: the stopband
    // starts at 24.1 kHz, so anything aliased from 22.05-24 kHz lands at
    // 20.1-22.05 kHz, above the audible band. An alias below 20 kHz would need
    // content above 24.1 kHz, which a 48k file does not have. Pinned so a
    // filter change that moves the band edges shows up here.
    for (int taps : {16, 32, 64}) {
        SincInterpolator si(48000, 44100, taps);
        const auto in = make_tone(23000.0, 0.5, 48000, 48000);
        const auto out = render_blocks(si, in, 1, 0, si.output_length(48000), 512);
        double energy = 0;
        for (std::size_t i = 2048; i + 2048 < out.size(); ++i) energy += out[i] * out[i];
        const double rms = std::sqrt(energy / static_cast<double>(out.size() - 4096));
        const double alias_db = 20.0 * std::log10(rms / (0.5 / std::sqrt(2.0)));
        MESSAGE("48000 -> 44100 taps=", taps, "  23 kHz alias: ", alias_db, " dB");
        if (taps == 64) CHECK(alias_db <= -40.0);
    }
}

TEST_CASE("E2: null test against the r8brain conversion the cache ships today") {
    constexpr int kChannels = 1;
    constexpr Frame kSrcFrames = 44100 * 2;
    // Tones only (220 Hz - 13.7 kHz). With the broadband noise added the null
    // is -46 dB at ANY tap count: the difference is all in 18-22 kHz, where
    // r8brain's 2 % transition band still passes and ours has started to roll
    // off. That band is what each filter deliberately trades; below it the two
    // must agree.
    const auto signal = make_broadband(kSrcFrames, kChannels, 44100, 0.0f);

    // What source_manager writes to source-cache: one forward r8brain run.
    auto rs = make_streaming_resampler(kChannels, 44100, 48000);
    std::vector<float> r8;
    for (Frame pos = 0; pos < kSrcFrames; pos += 4096) {
        const Frame n = std::min<Frame>(4096, kSrcFrames - pos);
        rs->process_chunk(signal.data() + pos, n, pos + n >= kSrcFrames, r8);
    }
    REQUIRE(r8.size() > 4096 + 48000 + 3);

    for (int taps : {16, 32, 64}) {
        SincInterpolator si(44100, 48000, taps);
        const auto ours = render_blocks(si, signal, kChannels, 0, si.output_length(kSrcFrames), 512);

        // Interior only, at the best of a few integer offsets in case either
        // side rounds its latency differently.
        const std::size_t from = 4096, count = 48000;
        double best_db = 0.0;
        int best_off = 0;
        for (int off = -3; off <= 3; ++off) {
            double err = 0, ref = 0;
            for (std::size_t i = from; i < from + count; ++i) {
                const double a = ours[i];
                const double b = r8[static_cast<std::size_t>(static_cast<long long>(i) + off)];
                err += (a - b) * (a - b);
                ref += b * b;
            }
            const double db = 10.0 * std::log10(err / ref);
            if (db < best_db) { best_db = db; best_off = off; }
        }
        MESSAGE("null vs r8brain taps=", taps, ": ", best_db, " dB at offset ", best_off);
        if (taps == 64) {
            CHECK(best_off == 0);
            CHECK(best_db <= -100.0);
        }
    }
}

TEST_CASE("the stereo kernel computes the same filter as the generic one") {
    // E2 measures quality on mono (generic kernel); stereo runs its own SIMD
    // kernel with a different summation order. Same filter, so the two may
    // only differ by float rounding.
    constexpr Frame kSrcFrames = 44100;
    const auto mono = make_broadband(kSrcFrames, 1, 44100);
    std::vector<float> stereo(mono.size() * 2);
    for (std::size_t i = 0; i < mono.size(); ++i) {
        stereo[2 * i] = mono[i];
        stereo[2 * i + 1] = -0.5f * mono[i];
    }
    for (int taps : {16, 32, 64}) {
        SincInterpolator si(44100, 48000, taps);
        const Frame out_frames = si.output_length(kSrcFrames);
        const auto m = render_blocks(si, mono, 1, 0, out_frames, 512);
        const auto s = render_blocks(si, stereo, 2, 0, out_frames, 512);
        double worst = 0.0;
        for (Frame f = 0; f < out_frames; ++f) {
            const std::size_t i = static_cast<std::size_t>(f);
            worst = std::max(worst, std::fabs(double(s[2 * i]) - m[i]));
            worst = std::max(worst, std::fabs(double(s[2 * i + 1]) + 0.5 * m[i]));
        }
        INFO("taps=", taps, " worst=", worst);
        CHECK(worst < 1e-6);
    }
}
