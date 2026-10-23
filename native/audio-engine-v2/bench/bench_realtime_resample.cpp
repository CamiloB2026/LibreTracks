// Banco del paso 2 del plan realtime-resample: coste por pista estéreo y por
// bloque de reamuestrear 44,1k -> 48k con SincInterpolator, frente a la ruta
// Direct de hoy (copiar con ganancia a la mezcla) y frente a una voz Bungee,
// que es lo que cuesta el warp. El criterio del plan es relativo al warp, así
// que las tres columnas se miden en la misma máquina y con el mismo bloque.
//
// No enlaza el motor: compila sinc_interpolator.cpp directamente, para que se
// pueda construir con el NDK o en iOS sin el resto de dependencias.
//
//   bench_realtime_resample [pistas=32] [bloque=512] [segundos=4]
//
// Bungee se añade con -DLT_BENCH_WITH_BUNGEE=1 y su include/lib. En Windows
// lo hace el objetivo de CMake (LT_ENGINE_BUILD_BENCHES=ON + Bungee). Android,
// desde la raíz del motor, con el NDK 27 y el SDK de Bungee para Android:
//
//   $NDK/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang++ //     -O3 -std=c++20 -DNDEBUG -DLT_BENCH_WITH_BUNGEE=1 -Iinclude -I$BUNGEE/include //     bench/bench_realtime_resample.cpp src/sources/sinc_interpolator.cpp //     $BUNGEE/android-arm64-v8a/libbungee.a $BUNGEE/android-arm64-v8a/libpffft.a //     -llog -static-libstdc++ -o bench_rr_android
//   adb push bench_rr_android /data/local/tmp/ && adb shell chmod +x /data/local/tmp/bench_rr_android
//   adb shell /data/local/tmp/bench_rr_android 32 512
#include <lt_engine/sources/sinc_interpolator.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <memory>
#include <vector>

#if LT_BENCH_WITH_BUNGEE
#include <bungee/Bungee.h>
#include <bungee/Stream.h>
#endif

using lt::Frame;
using lt::SincInterpolator;

namespace {

constexpr int kSrcRate = 44100;
constexpr int kDstRate = 48000;
constexpr int kChannels = 2;
constexpr int kBlocks = 1200;
constexpr int kWarmup = 200;

struct Stats { double avg, p95, max; };

// Mide `blocks` llamadas a `fn(bloque)` y devuelve microsegundos por bloque.
Stats measure(const std::function<void(int)>& fn) {
    std::vector<double> samples;
    samples.reserve(kBlocks);
    for (int b = 0; b < kBlocks; ++b) {
        const auto t0 = std::chrono::steady_clock::now();
        fn(b);
        const auto t1 = std::chrono::steady_clock::now();
        if (b >= kWarmup)
            samples.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
    }
    std::sort(samples.begin(), samples.end());
    double sum = 0.0;
    for (double s : samples) sum += s;
    return {sum / samples.size(), samples[samples.size() * 95 / 100], samples.back()};
}

void print_row(const char* name, int tracks, double budget_us, Stats s) {
    const double per_track = s.avg / tracks;
    std::printf("%-12s %10.1f %10.1f %10.1f %10.2f %9.3f%% %9.1f%%\n",
                name, s.avg, s.p95, s.max, per_track,
                100.0 * per_track / budget_us, 100.0 * per_track * 138.0 / budget_us);
}

} // namespace

int main(int argc, char** argv) {
    const int tracks = argc > 1 ? std::atoi(argv[1]) : 32;
    const int block = argc > 2 ? std::atoi(argv[2]) : 512;
    const int seconds = argc > 3 ? std::atoi(argv[3]) : 4;
    const double budget_us = block * 1e6 / kDstRate;

    // Una fuente distinta por pista, como en una sesión real: si todas leyeran
    // el mismo buffer el banco mediría la caché L2, no el reamuestreo.
    const Frame src_frames = static_cast<Frame>(kSrcRate) * seconds;
    std::vector<std::vector<float>> sources(static_cast<std::size_t>(tracks));
    for (int t = 0; t < tracks; ++t) {
        auto& s = sources[static_cast<std::size_t>(t)];
        s.resize(static_cast<std::size_t>(src_frames) * kChannels);
        for (Frame f = 0; f < src_frames; ++f)
            for (int c = 0; c < kChannels; ++c)
                s[static_cast<std::size_t>(f) * kChannels + c] =
                    0.3f * std::sin(0.013f * f * (1 + t % 7)) + 0.1f * std::sin(0.31f * f + c);
    }
    std::vector<float> mix(static_cast<std::size_t>(block) * kChannels);
    std::vector<float> scratch(static_cast<std::size_t>(block) * kChannels);
    const Frame out_total = static_cast<Frame>(kDstRate) * seconds - block;

    std::printf("pistas=%d bloque=%d @%d  presupuesto=%.1f us  (44,1k -> 48k, estéreo)\n",
                tracks, block, kDstRate, budget_us);
    std::printf("%-12s %10s %10s %10s %10s %10s %10s\n",
                "ruta", "avg us", "p95 us", "max us", "us/pista", "%/pista", "138 pistas");

    // Direct: la fuente ya está a la SR del motor; copia con ganancia.
    {
        const Stats s = measure([&](int b) {
            std::fill(mix.begin(), mix.end(), 0.0f);
            const Frame pos = (static_cast<Frame>(b) * block) % (src_frames - block);
            for (int t = 0; t < tracks; ++t) {
                const float* x = sources[static_cast<std::size_t>(t)].data() +
                                 static_cast<std::size_t>(pos) * kChannels;
                for (std::size_t i = 0; i < mix.size(); ++i) mix[i] += 0.8f * x[i];
            }
        });
        print_row("direct", tracks, budget_us, s);
    }

    for (int taps : {16, 32, 64}) {
        SincInterpolator si(kSrcRate, kDstRate, taps);
        const Stats s = measure([&](int b) {
            std::fill(mix.begin(), mix.end(), 0.0f);
            const Frame out_start = (static_cast<Frame>(b) * block) % out_total;
            Frame first = 0, last = 0;
            si.source_span(out_start, block, first, last);
            first = std::max<Frame>(first, 0);
            last = std::min(last, src_frames);
            for (int t = 0; t < tracks; ++t) {
                const float* x = sources[static_cast<std::size_t>(t)].data() +
                                 static_cast<std::size_t>(first) * kChannels;
                si.render(x, first, last - first, kChannels, out_start, block, scratch.data());
                for (std::size_t i = 0; i < mix.size(); ++i) mix[i] += 0.8f * scratch[i];
            }
        });
        char name[16];
        std::snprintf(name, sizeof(name), "sinc %d", taps);
        print_row(name, tracks, budget_us, s);
    }

#if LT_BENCH_WITH_BUNGEE
    {
        // Igual que TrackRenderer::render_path_stretched con ratio 1: el coste
        // de Bungee no depende del ratio (memoria warp-cpu-scales-with-tracks).
        using Edition = Bungee::Basic;
        struct Voice {
            std::unique_ptr<Bungee::Stretcher<Edition>> st;
            std::unique_ptr<Bungee::Stream<Edition>> stream;
            std::vector<std::vector<float>> in, out;
            std::vector<const float*> in_ptrs;
            std::vector<float*> out_ptrs;
        };
        const int max_in = block * 4;
        std::vector<Voice> voices(static_cast<std::size_t>(tracks));
        for (auto& v : voices) {
            Bungee::SampleRates rates{kDstRate, kDstRate};
            v.st = std::make_unique<Bungee::Stretcher<Edition>>(rates, kChannels, -1);
            v.stream = std::make_unique<Bungee::Stream<Edition>>(*v.st, max_in, kChannels);
            v.in.assign(kChannels, std::vector<float>(static_cast<std::size_t>(max_in)));
            v.out.assign(kChannels, std::vector<float>(static_cast<std::size_t>(max_in)));
            for (int c = 0; c < kChannels; ++c) {
                for (int i = 0; i < max_in; ++i)
                    v.in[c][static_cast<std::size_t>(i)] = 0.3f * std::sin(0.013f * i) + 0.1f * c;
                v.in_ptrs.push_back(v.in[c].data());
                v.out_ptrs.push_back(v.out[c].data());
            }
        }
        const Stats s = measure([&](int) {
            for (auto& v : voices)
                v.stream->process(v.in_ptrs.data(), v.out_ptrs.data(), block,
                                  static_cast<double>(block), 1.0);
        });
        print_row("bungee", tracks, budget_us, s);
    }
#endif
    return 0;
}
