#pragma once

#include <lt_engine/core/types.h>

#include <cstdint>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// SincInterpolator — STATELESS sample-rate conversion (plan realtime-resample,
// step 1). Not wired into the engine yet.
//
// Unlike StreamingResampler (r8brain, a stateful stream converter whose output
// after a seek never matches the from-start output, see
// test_resampler_seek_continuity.cpp), every output frame here is computed
// directly from its absolute position in the source:
//
//     y[n] = sum_k x[k] * h(n * num / den - k)      num/den = src_rate/dst_rate
//
// so rendering frames [a, b) gives the same samples whether the caller started
// at 0 or jumped to a. The ratio is kept as an exact reduced fraction and the
// phase in 64-bit integers, so a 10-minute song does not accumulate drift.
//
// Filter: Kaiser-windowed sinc, polyphase table with one row per output phase
// (`den` rows). `taps` is the kernel length at the lower of the two rates;
// when downsampling the kernel is stretched over proportionally more source
// frames so the cutoff follows the destination Nyquist.
// ---------------------------------------------------------------------------
class SincInterpolator {
public:
    SincInterpolator(int source_sample_rate, int target_sample_rate, int taps);

    int source_sample_rate() const { return source_rate_; }
    int target_sample_rate() const { return target_rate_; }
    // Reduced ratio source/target, e.g. 147/160 for 44100 -> 48000.
    std::int64_t ratio_num() const { return num_; }
    std::int64_t ratio_den() const { return den_; }
    // Source frames read per output frame.
    int kernel_length() const { return length_; }

    // Source frames [first, last) that output frames [out_start, out_start +
    // out_frames) read. The caller fetches at least this span (clamped to the
    // file) and passes it to render().
    void source_span(Frame out_start, Frame out_frames,
                     Frame& first, Frame& last) const;

    // Output frames needed to cover `source_frames` source frames.
    Frame output_length(Frame source_frames) const;

    // Render output frames [out_start, out_start + out_frames) into `out`
    // (interleaved, `channels`). `window` holds interleaved source frames
    // [window_start, window_start + window_frames); frames outside it read as
    // silence, which is exact at the file edges provided the window covers
    // source_span() everywhere else. Real-time safe: no allocation, no locks.
    void render(const float* window, Frame window_start, Frame window_frames,
                int channels, Frame out_start, Frame out_frames,
                float* out) const;

private:
    int source_rate_;
    int target_rate_;
    std::int64_t num_;
    std::int64_t den_;
    int length_;
    int lead_;  // source frames before the integer position the kernel reads
    // den_ rows of length_ coefficients; row p is the kernel at fractional
    // offset p / den_.
    std::vector<float> table_;
};

} // namespace lt
