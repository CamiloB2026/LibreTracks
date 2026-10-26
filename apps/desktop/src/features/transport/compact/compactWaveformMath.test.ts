import { describe, expect, it } from "vitest";

import {
  buildCompactWaveformGrid,
  compactWaveformBarNumber,
} from "./compactWaveformMath";

const song = { startSeconds: 0, endSeconds: 30 };
const tempoRegion = (startSeconds: number, endSeconds: number, bpm: number, timeSignature: string) => ({
  startSeconds,
  endSeconds,
  bpm,
  timeSignature,
});

function barStarts(
  params: Parameters<typeof buildCompactWaveformGrid>[0],
): number[] {
  return buildCompactWaveformGrid(params)
    .filter((marker) => marker.isBarStart)
    .map((marker) => marker.seconds);
}

describe("buildCompactWaveformGrid", () => {
  it("uses the denominator for 6/8 bars", () => {
    const bars = barStarts({
      songs: [song],
      tempoRegions: [tempoRegion(0, 30, 120, "6/8")],
      bpm: 120,
      timeSignature: "6/8",
      viewStartSeconds: 0,
      viewEndSeconds: 6,
      pixelsPerSecond: 20,
    });

    // 6/8 at 120 BPM: an eighth-note beat is 0.25 s, so a bar is 1.5 s.
    expect(bars[0]).toBeCloseTo(0);
    expect(bars[1]).toBeCloseTo(1.5);
    expect(bars[2]).toBeCloseTo(3);
    expect(
      compactWaveformBarNumber({
        positionSeconds: 3.1,
        song,
        tempoRegions: [tempoRegion(0, 30, 120, "6/8")],
        bpm: 120,
        timeSignature: "6/8",
      }),
    ).toBe(3);
  });

  it("uses the denominator for 2/2 bars", () => {
    const bars = barStarts({
      songs: [song],
      tempoRegions: [tempoRegion(0, 30, 120, "2/2")],
      bpm: 120,
      timeSignature: "2/2",
      viewStartSeconds: 0,
      viewEndSeconds: 6,
      pixelsPerSecond: 20,
    });

    // 2/2 at 120 BPM: a half-note beat is 1 s, so a bar is 2 s.
    expect(bars[0]).toBeCloseTo(0);
    expect(bars[1]).toBeCloseTo(2);
    expect(bars[2]).toBeCloseTo(4);
    expect(
      compactWaveformBarNumber({
        positionSeconds: 2.1,
        song,
        tempoRegions: [tempoRegion(0, 30, 120, "2/2")],
        bpm: 120,
        timeSignature: "2/2",
      }),
    ).toBe(2);
  });

  it("keeps tempo and time-signature changes inside the song", () => {
    const tempoRegions = [
      tempoRegion(0, 10, 120, "4/4"),
      tempoRegion(10, 30, 60, "6/8"),
    ];
    const bars = barStarts({
      songs: [song],
      tempoRegions,
      bpm: 120,
      timeSignature: "4/4",
      viewStartSeconds: 8,
      viewEndSeconds: 20,
      pixelsPerSecond: 20,
    });

    // 10 s at 120/4/4 = five bars. The next region is 6/8 at 60 BPM
    // (0.5 s per eighth-note beat), so its bars are 3 s long.
    expect(bars[0]).toBeCloseTo(8);
    expect(bars[1]).toBeCloseTo(10);
    expect(bars[2]).toBeCloseTo(13);
    expect(bars[3]).toBeCloseTo(16);
    expect(
      compactWaveformBarNumber({
        positionSeconds: 14,
        song,
        tempoRegions,
        bpm: 120,
        timeSignature: "4/4",
      }),
    ).toBe(7);
    expect(
      compactWaveformBarNumber({
        positionSeconds: 12,
        song,
        tempoRegions,
        bpm: 120,
        timeSignature: "4/4",
      }),
    ).toBe(6);
  });

  it("anchors bar 1 to a non-zero song start", () => {
    const songs = [{ startSeconds: 100, endSeconds: 130 }];
    const tempoRegions = [tempoRegion(0, 200, 120, "4/4")];
    const bars = barStarts({
      songs,
      tempoRegions,
      bpm: 120,
      timeSignature: "4/4",
      viewStartSeconds: 99,
      viewEndSeconds: 106,
      pixelsPerSecond: 20,
    });

    expect(bars[0]).toBeCloseTo(100);
    expect(bars[1]).toBeCloseTo(102);
    expect(bars[2]).toBeCloseTo(104);
    expect(
      compactWaveformBarNumber({
        positionSeconds: 100.5,
        song: songs[0],
        tempoRegions,
        bpm: 120,
        timeSignature: "4/4",
      }),
    ).toBe(1);
    expect(
      compactWaveformBarNumber({
        positionSeconds: 102.1,
        song: songs[0],
        tempoRegions,
        bpm: 120,
        timeSignature: "4/4",
      }),
    ).toBe(2);
  });
});
