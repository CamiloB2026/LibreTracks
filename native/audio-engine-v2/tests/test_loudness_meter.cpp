#include <doctest/doctest.h>

#include <lt_engine/render/loudness_meter.h>

#include <cmath>
#include <vector>

using namespace lt;

namespace {

constexpr double kPi = 3.14159265358979323846;

// Feed `seconds` of a stereo sine at `dbfs` (peak amplitude) to the meter.
void feed_sine(LoudnessMeter& meter, int sample_rate, double seconds, double dbfs,
               double hz = 1000.0) {
    const auto frames = static_cast<std::size_t>(seconds * sample_rate);
    const double amplitude = std::pow(10.0, dbfs / 20.0);
    std::vector<float> l(frames), r(frames);
    for (std::size_t i = 0; i < frames; ++i) {
        const float v = static_cast<float>(
            amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(i) / sample_rate));
        l[i] = v;
        r[i] = v;
    }
    meter.process(l.data(), r.data(), frames);
}

void feed_silence(LoudnessMeter& meter, int sample_rate, double seconds) {
    const auto frames = static_cast<std::size_t>(seconds * sample_rate);
    std::vector<float> zero(frames, 0.0f);
    meter.process(zero.data(), zero.data(), frames);
}

} // namespace

// EBU Tech 3341, test case 1: stereo 1 kHz at -23 dBFS reads -23.0 LUFS.
TEST_CASE("loudness meter: EBU 3341 reference tone reads -23 LUFS at 48 and 44.1 kHz") {
    for (const int rate : {48000, 44100}) {
        CAPTURE(rate);
        LoudnessMeter meter(rate);
        feed_sine(meter, rate, 20.0, -23.0);
        const auto stats = meter.finish();
        CHECK(stats.has_signal);
        CHECK(std::abs(stats.integrated_lufs + 23.0) < 0.1);
        CHECK(std::abs(stats.loud_lufs + 23.0) < 0.1);
        CHECK(stats.loudness_range_lu < 0.1);
        CHECK(stats.sample_peak == doctest::Approx(std::pow(10.0, -23.0 / 20.0)).epsilon(1e-3));
    }
}

// EBU Tech 3341, test case 2: -33 dBFS reads -33 LUFS (the meter is linear).
TEST_CASE("loudness meter: 10 dB quieter reads 10 LU lower") {
    LoudnessMeter meter(48000);
    feed_sine(meter, 48000, 20.0, -33.0);
    CHECK(std::abs(meter.finish().integrated_lufs + 33.0) < 0.1);
}

TEST_CASE("loudness meter: silence is gated out of both figures") {
    LoudnessMeter with_silence(48000);
    feed_silence(with_silence, 48000, 10.0);
    feed_sine(with_silence, 48000, 10.0, -20.0);
    feed_silence(with_silence, 48000, 10.0);
    const auto stats = with_silence.finish();
    // The few 400 ms blocks that straddle a tone/silence edge pass the -10 LU
    // gate and pull the mean down ~0.12 LU: BS.1770 as written. Silence
    // itself counted would read ~4.8 LU low.
    CHECK(std::abs(stats.integrated_lufs + 20.0) < 0.2);
    CHECK(std::abs(stats.loud_lufs + 20.0) < 0.1);
}

// The reason for the percentile: a song with a long soft part plays as loud
// as its loud part, while its integrated level sits in between.
TEST_CASE("loudness meter: the loud figure follows the loud part, not the average") {
    LoudnessMeter meter(48000);
    feed_sine(meter, 48000, 30.0, -30.0);   // soft verse
    feed_sine(meter, 48000, 10.0, -20.0);   // chorus
    const auto stats = meter.finish();
    CHECK(std::abs(stats.loud_lufs + 20.0) < 0.2);
    CHECK(stats.integrated_lufs < -21.0);
    CHECK(stats.integrated_lufs > -29.0);
    CHECK(stats.loudness_range_lu > 9.0);
}

TEST_CASE("loudness meter: a silent or empty input reports no signal") {
    LoudnessMeter silent(48000);
    feed_silence(silent, 48000, 5.0);
    CHECK_FALSE(silent.finish().has_signal);
    LoudnessMeter empty(48000);
    CHECK_FALSE(empty.finish().has_signal);
}

TEST_CASE("loudness meter: shorter than a 3 s window falls back to integrated") {
    LoudnessMeter meter(48000);
    feed_sine(meter, 48000, 1.5, -18.0);
    const auto stats = meter.finish();
    REQUIRE(stats.has_signal);
    CHECK(stats.loud_lufs == doctest::Approx(stats.integrated_lufs));
    CHECK(std::abs(stats.integrated_lufs + 18.0) < 0.2);
}
