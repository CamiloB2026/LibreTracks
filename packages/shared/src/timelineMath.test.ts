import { describe, expect, it } from "vitest";

import { buildSongTempoRegions } from "./models";
import {
  buildVisibleTimelineGrid,
  firstIndexAtOrAfter,
  getCumulativeMusicalPosition,
  nextDownbeatAfter,
  rampQuartersBetween,
  rampSecondsAfter,
  snapToTimelineGrid,
} from "./timelineMath";

describe("firstIndexAtOrAfter", () => {
  it("encuentra el primer índice >= target", () => {
    const values = [0, 1, 2, 5, 5, 9];
    expect(firstIndexAtOrAfter(values, -1)).toBe(0);
    expect(firstIndexAtOrAfter(values, 0)).toBe(0);
    expect(firstIndexAtOrAfter(values, 3)).toBe(3);
    // Con valores repetidos devuelve el PRIMERO, no uno cualquiera.
    expect(firstIndexAtOrAfter(values, 5)).toBe(3);
    expect(firstIndexAtOrAfter(values, 9)).toBe(5);
    expect(firstIndexAtOrAfter(values, 10)).toBe(6);
    expect(firstIndexAtOrAfter([], 1)).toBe(0);
  });

  it("coincide con el barrido lineal para cualquier entrada", () => {
    const values = Array.from({ length: 200 }, (_, index) => index * 0.5);
    for (const target of [-5, 0, 0.25, 50, 99.5, 100, 1000]) {
      const linear = values.findIndex((value) => value >= target);
      expect(firstIndexAtOrAfter(values, target)).toBe(
        linear === -1 ? values.length : linear,
      );
    }
  });
});

describe("la rejilla sale ordenada", () => {
  // Premisa de la que depende la búsqueda binaria del dibujo. Si algún día
  // `buildVisibleTimelineGrid` emitiera fuera de orden, el timeline dejaría de
  // pintar parte de la rejilla en silencio.
  it("emite bars, beats y markers en orden ascendente", () => {
    const regions = [
      { startSeconds: 0, endSeconds: 60, bpm: 120, timeSignature: "4/4" },
      // A propósito desordenada en la entrada y con otro compás.
      { startSeconds: 120, endSeconds: 180, bpm: 90, timeSignature: "3/4" },
      { startSeconds: 60, endSeconds: 120, bpm: 140, timeSignature: "4/4" },
    ];
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 180,
      bpm: 120,
      timeSignature: "4/4",
      regions,
      zoomLevel: 1,
      pixelsPerSecond: 18,
      viewportStartSeconds: 0,
      viewportEndSeconds: 180,
    });

    const isAscending = (values: number[]) =>
      values.every((value, index) => index === 0 || values[index - 1] <= value);

    expect(grid.bars.length).toBeGreaterThan(0);
    expect(isAscending(grid.bars)).toBe(true);
    expect(isAscending(grid.beats)).toBe(true);
    expect(isAscending(grid.markers.map((marker) => marker.seconds))).toBe(true);
  });
});

describe("una marca de compás empieza compás, como el metrónomo", () => {
  // El metrónomo del motor reinicia la cuenta en cada marca
  // (`timing_segment_start`). La rejilla lo hace en las marcas de compás,
  // aunque no cambien la medida; una marca de tempo sola conserva la fase
  // (test "keeps beat phase continuous…"). "Analizar canción" se apoya en esto.
  type Region = {
    startSeconds: number;
    endSeconds: number;
    bpm: number;
    timeSignature: string;
    startsBar?: boolean;
  };
  const gridFor = (regions: Region[]) =>
    buildVisibleTimelineGrid({
      durationSeconds: 40,
      bpm: 120,
      timeSignature: "4/4",
      regions,
      zoomLevel: 12,
      pixelsPerSecond: 200,
      viewportStartSeconds: 0,
      viewportEndSeconds: 40,
    });

  it("una marca de compás fuera de la línea de compás es el tiempo 1 de un compás nuevo", () => {
    // 120 BPM 4/4 → compás de 2 s. La marca a 5 s cae a mitad del compás 3.
    const grid = gridFor([
      { startSeconds: 0, endSeconds: 5, bpm: 120, timeSignature: "4/4" },
      { startSeconds: 5, endSeconds: 40, bpm: 90, timeSignature: "4/4", startsBar: true },
    ]);
    const atMarker = grid.markers.find((marker) => Math.abs(marker.seconds - 5) < 1e-6);
    expect(atMarker).toMatchObject({ isBarStart: true, beatInBar: 1, barNumber: 4 });
    // El compás siguiente llega un compás de 90 BPM (2,666 s) después.
    expect(grid.bars).toContainEqual(expect.closeTo(5 + 8 / 3, 6));
  });

  it("unos milisegundos de más sobre la línea de compás no la duplican", () => {
    // La marca llega 4 ms después del compás 5 (8 s): es ese compás.
    const grid = gridFor([
      { startSeconds: 0, endSeconds: 8.004, bpm: 120, timeSignature: "4/4" },
      { startSeconds: 8.004, endSeconds: 40, bpm: 120, timeSignature: "4/4", startsBar: true },
    ]);
    const nearBoundary = grid.bars.filter((seconds) => Math.abs(seconds - 8) < 0.1);
    expect(nearBoundary).toEqual([8.004]);
    const atMarker = grid.markers.find((marker) => marker.seconds === 8.004);
    expect(atMarker?.barNumber).toBe(5);
  });

  it("buildSongTempoRegions marca las regiones que empiezan en una marca de compás", () => {
    const regions = buildSongTempoRegions({
      bpm: 120,
      timeSignature: "4/4",
      tempoMarkers: [{ id: "t", startSeconds: 3, bpm: 90 }],
      timeSignatureMarkers: [{ id: "s", startSeconds: 5, signature: "4/4" }],
      regions: [],
    } as never);
    expect(regions.map((region) => [region.startSeconds, region.startsBar])).toEqual([
      [0, false],
      [3, false],
      [5, true],
    ]);
  });
});

describe("rampas de tempo", () => {
  // Un compás a 60 y luego 60 → 120 BPM en 10 s, 4/4: dentro de la rampa el
  // tiempo k cae donde 60·t + 3·t² = 60·k.
  const beatAt = (k: number) => 4 + (-60 + Math.sqrt(3600 + 720 * k)) / 6;
  const song = {
    id: "s",
    title: "S",
    bpm: 60,
    timeSignature: "4/4",
    durationSeconds: 30,
    tempoMarkers: [
      { id: "ramp", startSeconds: 4, bpm: 60, ramp: true },
      { id: "fast", startSeconds: 14, bpm: 120 },
    ],
    timeSignatureMarkers: [],
    sectionMarkers: [],
    regions: [],
    tracks: [],
    clips: [],
    projectRevision: 1,
  } as never;

  it("las fórmulas se invierten", () => {
    const ramp = { startSeconds: 2, endSeconds: 12, startBpm: 140, endBpm: 70 };
    for (const from of [0, 2, 7, 12, 15]) {
      for (const quarters of [-2, 0, 0.5, 3, 40]) {
        const to = rampSecondsAfter(ramp, from, quarters);
        expect(rampQuartersBetween(ramp, from, to)).toBeCloseTo(quarters, 9);
      }
    }
  });

  it("la región de tempo lleva el bpm del final de la rampa", () => {
    const ramp = buildSongTempoRegions(song).find((region) => region.startSeconds === 4);
    expect(ramp?.bpm).toBe(60);
    expect(ramp?.endBpm).toBe(120);
  });

  it("la rejilla pone cada tiempo donde lo pone la rampa", () => {
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 30,
      bpm: 60,
      timeSignature: "4/4",
      regions: buildSongTempoRegions(song),
      zoomLevel: 20,
      pixelsPerSecond: 400,
      viewportStartSeconds: 4,
      viewportEndSeconds: 13.9,
    });
    const inRamp = grid.markers.filter((m) => m.seconds >= 4 - 1e-9 && m.seconds < 14);
    // 15 tiempos (el 16.º es la marca de 120 a los 14 s), empezando el compás 2.
    expect(inRamp.length).toBe(15);
    inRamp.forEach((marker, index) => {
      expect(marker.seconds).toBeCloseTo(beatAt(index), 6);
    });
    expect(inRamp[0].barNumber).toBe(2);
    expect(inRamp[4].isBarStart).toBe(true);
  });

  it("posición musical, ajuste y siguiente compás siguen la rampa", () => {
    const regions = buildSongTempoRegions(song);
    expect(nextDownbeatAfter(4.5, 60, "4/4", regions)).toBeCloseTo(beatAt(4), 6);
    expect(getCumulativeMusicalPosition(beatAt(5) + 1e-6, regions, 60, "4/4").display).toBe(
      "3.2.00",
    );
    expect(snapToTimelineGrid(beatAt(6) + 0.05, 60, "4/4", 20, 400, regions)).toBeCloseTo(
      beatAt(6),
      6,
    );
  });
});
