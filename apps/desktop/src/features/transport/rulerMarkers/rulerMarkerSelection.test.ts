import { beforeEach, describe, expect, it } from "vitest";

import type { SongView } from "../desktopApi";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";
import {
  duplicateOffsetSeconds,
  duplicatePlacements,
  groupContaining,
  groupMovePlacements,
  handleRulerMarkerClick,
  listRulerMarkers,
  markersBetween,
  markersInSpan,
  resolveRulerMarkers,
} from "./rulerMarkerSelection";

/** 120 BPM 4/4: un compás son 2 s. */
const SONG = {
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 60,
  regions: [],
  sectionMarkers: [
    { id: "s1", name: "Intro", startSeconds: 2 },
    { id: "s2", name: "Verse", startSeconds: 6 },
    { id: "s3", name: "Chorus", startSeconds: 10 },
  ],
  tempoMarkers: [{ id: "t1", startSeconds: 4, bpm: 120 }],
  timeSignatureMarkers: [{ id: "ts1", startSeconds: 8, signature: "4/4" }],
} as unknown as SongView;

const s = (id: string) => ({ kind: "section" as const, id });
const tempo = (id: string) => ({ kind: "tempo" as const, id });
const signature = (id: string) => ({ kind: "timeSignature" as const, id });

beforeEach(() => {
  useTimelineUIStore.getState().clearSelection();
});

describe("las marcas de la regla como una sola lista", () => {
  it("mezcla los tres tipos por posicion", () => {
    expect(listRulerMarkers(SONG).map((entry) => entry.id)).toEqual([
      "s1",
      "t1",
      "s2",
      "ts1",
      "s3",
    ]);
  });

  it("Shift coge todo lo que hay entre las dos, de cualquier tipo y en los dos sentidos", () => {
    const expected = [s("s1"), tempo("t1"), s("s2"), signature("ts1")];
    expect(markersBetween(SONG, s("s1"), signature("ts1"))).toEqual(expected);
    expect(markersBetween(SONG, signature("ts1"), s("s1"))).toEqual(expected);
  });

  it("sin ancla valida, Shift coge solo la pulsada", () => {
    expect(markersBetween(SONG, null, s("s2"))).toEqual([s("s2")]);
    expect(markersBetween(SONG, s("borrada"), s("s2"))).toEqual([s("s2")]);
  });

  it("un tramo de la regla coge las marcas que empiezan dentro, bordes incluidos", () => {
    expect(markersInSpan(SONG, 8, 4)).toEqual([tempo("t1"), s("s2"), signature("ts1")]);
  });
});

describe("mover y duplicar un grupo", () => {
  it("mueve todas lo mismo", () => {
    expect(groupMovePlacements(SONG, [s("s2"), tempo("t1")], 1.5)).toEqual([
      { ...s("s2"), startSeconds: 7.5 },
      { ...tempo("t1"), startSeconds: 5.5 },
    ]);
  });

  it("se para cuando la primera llega al cero, sin deformar el grupo", () => {
    expect(groupMovePlacements(SONG, [s("s1"), s("s2")], -5)).toEqual([
      { ...s("s1"), startSeconds: 0 },
      { ...s("s2"), startSeconds: 4 },
    ]);
  });

  it("una sola marca se duplica al compas siguiente", () => {
    const entries = resolveRulerMarkers(SONG, [s("s2")]);
    expect(duplicateOffsetSeconds(SONG, entries)).toBe(2);
  });

  it("un grupo se duplica detras de si mismo, en compases enteros", () => {
    // De 2 a 10 s son 4 compases justos: la copia de la primera caeria encima
    // de la ultima, asi que va un compas mas alla.
    const exact = resolveRulerMarkers(SONG, [s("s1"), s("s3")]);
    expect(duplicateOffsetSeconds(SONG, exact)).toBe(10);
    // De 2 a 8 s son 3 compases; con medio compas mas se redondea arriba.
    const partial = resolveRulerMarkers(SONG, [s("s1"), signature("ts1")]);
    expect(duplicateOffsetSeconds(SONG, partial)).toBe(8);
  });

  it("las copias conservan las distancias entre ellas", () => {
    expect(duplicatePlacements(SONG, [s("s1"), tempo("t1")])).toEqual([
      { ...s("s1"), startSeconds: 6 },
      { ...tempo("t1"), startSeconds: 8 },
    ]);
  });
});

describe("clic con modificadores", () => {
  const selected = () => selectedRulerMarkers(useTimelineUIStore.getState());

  it("sin modificadores deja paso al clic de siempre", () => {
    expect(handleRulerMarkerClick(SONG, s("s1"), { additive: false, range: false })).toBe(
      false,
    );
  });

  it("Ctrl pone y quita, sin perder lo que ya habia", () => {
    useTimelineUIStore.getState().selectSection("s1");
    handleRulerMarkerClick(SONG, tempo("t1"), { additive: true, range: false });
    expect(selected()).toEqual([s("s1"), tempo("t1")]);
    handleRulerMarkerClick(SONG, s("s1"), { additive: true, range: false });
    expect(selected()).toEqual([tempo("t1")]);
    // Con una sola, vuelve a ser la seleccion suelta de siempre.
    expect(useTimelineUIStore.getState().selectedTempoMarkerId).toBe("t1");
  });

  it("Ctrl en una y Shift en otra coge el tramo; otro Shift cuenta desde la misma", () => {
    handleRulerMarkerClick(SONG, s("s2"), { additive: true, range: false });
    handleRulerMarkerClick(SONG, s("s3"), { additive: false, range: true });
    expect(selected()).toEqual([s("s2"), signature("ts1"), s("s3")]);
    handleRulerMarkerClick(SONG, s("s1"), { additive: false, range: true });
    expect(selected()).toEqual([s("s1"), tempo("t1"), s("s2")]);
  });

  it("una marca de la seleccion arrastra o abre el menu del grupo; una suelta, no", () => {
    useTimelineUIStore.getState().setSelectedMarkers([s("s1"), s("s2")]);
    expect(groupContaining(s("s2"))).toEqual([s("s1"), s("s2")]);
    expect(groupContaining(s("s3"))).toBeNull();
    useTimelineUIStore.getState().selectSection("s1");
    expect(groupContaining(s("s1"))).toBeNull();
  });

  it("elegir cualquier otra cosa suelta las marcas", () => {
    useTimelineUIStore.getState().setSelectedMarkers([s("s1"), s("s2")]);
    useTimelineUIStore.getState().setSelectedClipIds(["c1"]);
    expect(selected()).toEqual([]);
  });
});
