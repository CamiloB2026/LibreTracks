import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { jsonEqual, mergeSongView } from "./mergeSongView";

// Lo que llega del backend: un objeto nuevo en cada revisión. `structuredClone`
// imita eso (mismo contenido, ninguna referencia compartida).
function songFixture(): SongView {
  return {
    id: "song-1",
    title: "Sesión",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 300,
    projectRevision: 1,
    tracks: [
      { id: "t1", name: "Bombo", volume: 1, pan: 0, muted: false, parentTrackId: null },
      { id: "t2", name: "Bajo", volume: 0.8, pan: 0, muted: false, parentTrackId: "f1" },
      { id: "f1", name: "Ritmo", volume: 1, pan: 0, muted: false, kind: "folder" },
    ],
    clips: [
      { id: "c1", trackId: "t1", timelineStartSeconds: 0, durationSeconds: 120 },
      { id: "c2", trackId: "t2", timelineStartSeconds: 0, durationSeconds: 120 },
      { id: "c3", trackId: "t2", timelineStartSeconds: 150, durationSeconds: 60 },
    ],
    regions: [
      { id: "r1", name: "Canción 1", startSeconds: 0, endSeconds: 140, warpEnabled: false, transposeSemitones: 0 },
      { id: "r2", name: "Canción 2", startSeconds: 150, endSeconds: 300, warpEnabled: false, transposeSemitones: 0 },
    ],
    sectionMarkers: [{ id: "m1", name: "Intro", startSeconds: 0 }],
    tempoMarkers: [],
    timeSignatureMarkers: [],
    automationTrack: { volume: 1, muted: false },
    waveforms: [],
  } as unknown as SongView;
}

function revise(song: SongView, edit: (draft: SongView) => void): SongView {
  const next = structuredClone(song);
  next.projectRevision = song.projectRevision + 1;
  edit(next);
  return next;
}

describe("mergeSongView", () => {
  it("cambiar el volumen de una pista deja === lo demás", () => {
    const previous = songFixture();
    const next = revise(previous, (draft) => {
      (draft.tracks[1] as { volume: number }).volume = 0.5;
    });

    const merged = mergeSongView(previous, next);

    expect(merged).toEqual(next);
    expect(merged.tracks).not.toBe(previous.tracks);
    expect(merged.tracks[0]).toBe(previous.tracks[0]);
    expect(merged.tracks[1]).not.toBe(previous.tracks[1]);
    expect(merged.tracks[2]).toBe(previous.tracks[2]);
    expect(merged.clips).toBe(previous.clips);
    expect(merged.regions).toBe(previous.regions);
    expect(merged.sectionMarkers).toBe(previous.sectionMarkers);
    expect(merged.tempoMarkers).toBe(previous.tempoMarkers);
    expect(merged.automationTrack).toBe(previous.automationTrack);
  });

  it("activar el warp renueva la región y los clips que mueve, nada más", () => {
    const previous = songFixture();
    const next = revise(previous, (draft) => {
      (draft.regions[1] as { warpEnabled: boolean }).warpEnabled = true;
      (draft.clips[2] as { durationSeconds: number }).durationSeconds = 55;
    });

    const merged = mergeSongView(previous, next);

    expect(merged).toEqual(next);
    expect(merged.regions[0]).toBe(previous.regions[0]);
    expect(merged.regions[1]).not.toBe(previous.regions[1]);
    expect(merged.clips[0]).toBe(previous.clips[0]);
    expect(merged.clips[1]).toBe(previous.clips[1]);
    expect(merged.clips[2]).toBe(next.clips[2]);
    expect(merged.tracks).toBe(previous.tracks);
  });

  it("respeta altas, bajas y el orden nuevo", () => {
    const previous = songFixture();
    const next = revise(previous, (draft) => {
      draft.tracks = [draft.tracks[2], draft.tracks[0]];
      draft.clips.push({
        id: "c4",
        trackId: "t1",
        timelineStartSeconds: 200,
        durationSeconds: 10,
      } as unknown as SongView["clips"][number]);
    });

    const merged = mergeSongView(previous, next);

    expect(merged).toEqual(next);
    expect(merged.tracks.map((track) => track.id)).toEqual(["f1", "t1"]);
    expect(merged.tracks[0]).toBe(previous.tracks[2]);
    expect(merged.tracks[1]).toBe(previous.tracks[0]);
    expect(merged.clips).not.toBe(previous.clips);
    expect(merged.clips[0]).toBe(previous.clips[0]);
  });

  it("otra canción no hereda nada de la anterior", () => {
    const previous = songFixture();
    const next = revise(previous, (draft) => {
      draft.id = "song-2";
    });

    const merged = mergeSongView(previous, next);

    expect(merged).toBe(next);
    expect(merged.tracks[0]).not.toBe(previous.tracks[0]);
  });

  it("sin canción anterior devuelve la nueva tal cual", () => {
    const next = songFixture();
    expect(mergeSongView(null, next)).toBe(next);
  });
});

describe("jsonEqual", () => {
  it("compara por contenido y trata undefined como ausente", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual({ a: null }, { a: undefined })).toBe(false);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual({ a: {} }, { a: { x: 1 } })).toBe(false);
  });
});
