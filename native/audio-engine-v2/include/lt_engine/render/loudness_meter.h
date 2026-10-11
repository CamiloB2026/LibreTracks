#pragma once

// ---------------------------------------------------------------------------
// Loudness meter (ITU-R BS.1770-4 / EBU R128), offline.
//
// Used by "Level songs": every song of a setlist is rendered offline and
// measured, and each song's master is set so they all sound equally loud
// through the PA.
//
// Two figures come out of it:
//   - integrated loudness, the gated average of the whole range (R128);
//   - "loud" loudness, the 90th percentile of the short-term (3 s) loudness.
//     A live engineer complains about the chorus, not the average: a song with
//     a long soft bridge reads quieter integrated than it plays in its loud
//     parts. This is the figure the levelling uses.
//
// Short-term values are gated like EBU Tech 3342 (loudness range) gates them:
// -70 LUFS absolute, then -20 LU below the integrated level, so silence and
// near-silent intros never pull the percentile down.
//
// Stereo only (L and R, weight 1 each), which is what the renderer produces.
// Not realtime-safe: it keeps one value per 100 ms in a growing vector.
// ---------------------------------------------------------------------------

#include <cstddef>
#include <vector>

namespace lt {

struct LoudnessStats {
    bool   has_signal = false;     // false: everything below the -70 LUFS gate
    double integrated_lufs = -70.0;
    double loud_lufs = -70.0;      // 90th percentile of gated short-term loudness
    double loudness_range_lu = 0.0;
    float  sample_peak = 0.0f;     // linear, max |sample| over both channels
};

class LoudnessMeter {
public:
    explicit LoudnessMeter(int sample_rate);

    void process(const float* left, const float* right, std::size_t frames) noexcept;
    LoudnessStats finish() const;

private:
    struct Biquad {
        double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
        double z1 = 0.0, z2 = 0.0;
        double run(double x) noexcept {
            const double y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2;
            z2 = b2 * x - a2 * y;
            return y;
        }
    };

    Biquad shelf_[2];
    Biquad highpass_[2];
    std::size_t segment_frames_ = 0;   // 100 ms
    std::size_t segment_fill_ = 0;
    double segment_energy_ = 0.0;      // sum over the segment of (zL^2 + zR^2)
    float peak_ = 0.0f;
    // Mean square (L + R summed) of each completed 100 ms segment.
    std::vector<double> segments_;
};

} // namespace lt
