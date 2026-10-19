#pragma once

// Tempo ramps: a tempo marker with `ramp` glides from its bpm to the next
// tempo marker's, reached exactly there, linearly in time. The same formulas
// live in `libretracks_core::tempo_ramp` (Rust) and in `timelineMath.ts`
// (the timeline grid): keep the three in step, or the click drifts off the
// grid inside a ramp.
//
// Realtime-safe: no allocation, a linear scan of the song's markers (the
// metronome already scans them per frame).

#include <lt_engine/session/session.h>

#include <algorithm>
#include <cmath>
#include <limits>

namespace lt {

struct TempoSpan {
    Frame  start = 0;
    Frame  end = std::numeric_limits<Frame>::max();
    double start_bpm = 120.0;
    double end_bpm = 120.0;

    bool is_ramp() const noexcept {
        return end != std::numeric_limits<Frame>::max() && end > start && start_bpm != end_bpm;
    }

    // bpm per frame over the ramp.
    double slope() const noexcept {
        return is_ramp() ? (end_bpm - start_bpm) / static_cast<double>(end - start) : 0.0;
    }

    double bpm_at(double frame) const noexcept {
        if (!is_ramp() || frame <= static_cast<double>(start)) return start_bpm;
        if (frame >= static_cast<double>(end)) return end_bpm;
        return start_bpm + slope() * (frame - static_cast<double>(start));
    }

    // Quarter notes from `start` to `frame` (negative before it). Past `end`
    // the tempo holds `end_bpm`.
    double quarters_from_start(double frame, double sample_rate) const noexcept {
        const double per_frame = 1.0 / (60.0 * sample_rate);
        const double dt = frame - static_cast<double>(start);
        if (!is_ramp() || dt <= 0.0) return dt * start_bpm * per_frame;
        const double ramp = std::max(0.0, std::min(frame, static_cast<double>(end))
                                              - static_cast<double>(start));
        const double inside = (start_bpm * ramp + 0.5 * slope() * ramp * ramp) * per_frame;
        return inside
            + std::max(0.0, frame - static_cast<double>(end)) * end_bpm * per_frame;
    }

    double quarters_between(double from, double to, double sample_rate) const noexcept {
        return quarters_from_start(to, sample_rate) - quarters_from_start(from, sample_rate);
    }

    // The frame `quarters` quarter notes after `from` (before it if negative).
    double frame_after(double from, double quarters, double sample_rate) const noexcept {
        const double target = quarters_from_start(from, sample_rate) + quarters;
        const double frames_per_quarter_at = 60.0 * sample_rate;
        if (!is_ramp() || target <= 0.0)
            return static_cast<double>(start) + target * frames_per_quarter_at / start_bpm;
        const double ramp_quarters = quarters_from_start(static_cast<double>(end), sample_rate);
        if (target >= ramp_quarters)
            return static_cast<double>(end)
                + (target - ramp_quarters) * frames_per_quarter_at / end_bpm;
        // a·dt + k/2·dt² = 60·sr·q, the root that stays finite as k → 0.
        const double a = start_bpm;
        const double k = slope();
        const double q = frames_per_quarter_at * target;
        return static_cast<double>(start)
            + 2.0 * q / (a + std::sqrt(std::max(0.0, a * a + 2.0 * k * q)));
    }
};

// The stretch of the song's tempo map that rules at `frame`: `song.bpm`
// before the first marker, then from each marker to the next, a ramp when
// the marker has one. bpms clamp to the engine's 20-300 range.
inline TempoSpan tempo_span_at(const Song* song, Frame frame) noexcept {
    TempoSpan span;
    if (!song) return span;
    const auto clamp_bpm = [](double bpm) { return std::clamp(bpm, 20.0, 300.0); };
    span.start = song->start_frame;
    span.start_bpm = span.end_bpm = clamp_bpm(song->bpm);
    const auto& markers = song->tempo_markers;
    for (std::size_t i = 0; i < markers.size(); ++i) {
        if (markers[i].frame > frame) {
            span.end = markers[i].frame;
            return span;
        }
        span.start = markers[i].frame;
        span.start_bpm = clamp_bpm(markers[i].bpm);
        span.end = std::numeric_limits<Frame>::max();
        span.end_bpm = span.start_bpm;
        if (markers[i].ramp && i + 1 < markers.size() && markers[i + 1].frame > markers[i].frame)
            span.end_bpm = clamp_bpm(markers[i + 1].bpm);
    }
    return span;
}

} // namespace lt
