import { describe, expect, it } from "vitest";

import type { SongLoudness } from "@libretracks/shared/desktopApi";
import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import {
  defaultSongsToApply,
  groupLevelTracks,
  isCueTrackName,
  levelableTracks,
  planLevels,
  type LevelTrack,
} from "./levelSongsPlan";

const track = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name,
    kind: "audio",
    depth: 0,
    parentTrackId: null,
    muted: false,
    solo: false,
    audioTo: "master",
    ...extra,
  }) as never;

function song(tracks: unknown[]): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 600,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    sectionMarkers: [],
    regions: [],
    tracks: tracks as never,
    clips: (tracks as { id: string; kind: string }[])
      .filter((t) => t.kind !== "folder")
      .map((t) => ({ id: `c-${t.id}`, trackId: t.id, timelineStartSeconds: 0, durationSeconds: 10 })) as never,
    projectRevision: 1,
  };
}

const cueRoutes = { metronomeOutput: "master", voiceGuideOutput: "monitor" };
const exclusions = (tracks: LevelTrack[]) =>
  Object.fromEntries(tracks.map((t) => [t.id, t.exclusion]));

describe("levelableTracks", () => {
  it("counts what reaches the PA and explains every track left out", () => {
    const tracks = levelableTracks(
      song([
        track("drums", "Drums"),
        track("keys", "Keys", { muted: true }),
        track("click", "Click"),
        track("guide", "Guía"),
        track("ears", "Pad", { audioTo: "monitor" }),
        track("midi", "Lights", { kind: "midi" }),
      ]),
      cueRoutes,
    );
    expect(exclusions(tracks)).toEqual({
      drums: null,
      keys: "muted",
      click: "cueName",
      guide: "cueName",
      ears: "inEarRoute",
    });
  });

  it("leaves out the output the click goes to, unless that output is the master", () => {
    const tracks = levelableTracks(
      song([track("a", "Bass", { audioTo: "ext:2-3" }), track("b", "Gtr", { audioTo: "ext:0-1" })]),
      { metronomeOutput: "ext:2-3", voiceGuideOutput: "monitor" },
    );
    expect(exclusions(tracks)).toEqual({ a: "inEarRoute", b: null });
  });

  it("resolves inherited routes, folder mute and folder names through the folder", () => {
    const tracks = levelableTracks(
      song([
        track("cues", "Cues", { kind: "folder", audioTo: "ext:4-5" }),
        track("count", "Count 1", { parentTrackId: "cues", audioTo: "inherit" }),
        track("band", "Band", { kind: "folder", muted: true }),
        track("bass", "Bass", { parentTrackId: "band" }),
        track("named", "Section voice", { parentTrackId: "cues", audioTo: "master" }),
      ]),
      { metronomeOutput: "ext:4-5", voiceGuideOutput: "monitor" },
    );
    expect(tracks.find((t) => t.id === "count")?.route).toBe("ext:4-5");
    expect(exclusions(tracks)).toEqual({ count: "inEarRoute", bass: "muted", named: "cueName" });
  });

  it("with a solo active only the soloed tracks sound", () => {
    const tracks = levelableTracks(
      song([track("a", "Drums", { solo: true }), track("b", "Bass")]),
      cueRoutes,
    );
    expect(exclusions(tracks)).toEqual({ a: null, b: "muted" });
  });
});

describe("isCueTrackName", () => {
  it.each(["Click", "CLICK 2", "Metrónomo", "Cues", "Guide", "Guia", "Count-in", "Timecode", "SMPTE"])(
    "%s is a cue stem",
    (name) => expect(isCueTrackName(name)).toBe(true),
  );
  it.each(["Drums", "Clicky Synth", "Guitars", "Acoustic", "Bass"])("%s is music", (name) =>
    expect(isCueTrackName(name)).toBe(false),
  );
});

const region = (id: string, gain = 1) =>
  ({ id, name: `Song ${id}`, startSeconds: 0, endSeconds: 1, master: { gain } }) as SongRegionSummary;
const measured = (
  regionId: string,
  loudLufs: number,
  extra: Partial<SongLoudness> = {},
): SongLoudness => ({
  regionId,
  hasSignal: true,
  integratedLufs: loudLufs - 2,
  loudLufs,
  loudnessRangeLu: 5,
  samplePeak: 0.1,
  tracksWithAudio: ["drums", "keys"],
  ...extra,
});

describe("planLevels", () => {
  it("brings every song to the median of the setlist", () => {
    const plan = planLevels(
      [region("a"), region("b"), region("c")],
      [measured("a", -10), measured("b", -14), measured("c", -16)],
      { kind: "median" },
    );
    expect(plan.targetLufs).toBe(-14);
    const change = Object.fromEntries(plan.songs.map((s) => [s.regionId, s.changeDb]));
    expect(change.a).toBeCloseTo(-4);
    expect(change.b).toBeCloseTo(0);
    expect(change.c).toBeCloseTo(2);
    expect(plan.songs[0].proposedGain).toBeCloseTo(10 ** (-4 / 20));
  });

  it("the proposal does not depend on the master the song has now", () => {
    const plan = planLevels(
      [region("a", 0.5), region("b", 1)],
      [measured("a", -12), measured("b", -12)],
      { kind: "median" },
    );
    expect(plan.songs[0].proposedGain).toBeCloseTo(1);
    expect(plan.songs[0].changeDb).toBeCloseTo(6.02, 1);
  });

  it("can match a reference song instead of the median", () => {
    const plan = planLevels(
      [region("a"), region("b")],
      [measured("a", -10), measured("b", -14)],
      { kind: "song", regionId: "b" },
    );
    expect(plan.targetLufs).toBe(-14);
    expect(plan.songs[0].changeDb).toBeCloseTo(-4);
  });

  it("stops a boost where the song's peak would pass -1 dBFS", () => {
    const plan = planLevels(
      [region("a"), region("b")],
      [measured("a", -10), measured("b", -16, { samplePeak: 0.5 })],
      { kind: "song", regionId: "a" },
    );
    const b = plan.songs[1];
    expect(b.limitedByPeak).toBe(true);
    // 0.5 peak → room up to 0.891/0.5 = +5 dB, not the +6 asked.
    expect(b.changeDb).toBeCloseTo(5, 1);
  });

  it("never makes a song quieter only because it already peaks high", () => {
    const plan = planLevels(
      [region("a", 1), region("b", 1)],
      [measured("a", -10), measured("b", -14, { samplePeak: 1.4 })],
      { kind: "song", regionId: "a" },
    );
    expect(plan.songs[1].changeDb).toBeCloseTo(0);
    expect(plan.songs[1].limitedByPeak).toBe(true);
  });

  it("caps at the fader's +6 dB", () => {
    const plan = planLevels(
      [region("a"), region("b")],
      [measured("a", -6), measured("b", -20, { samplePeak: 0.01 })],
      { kind: "song", regionId: "a" },
    );
    expect(plan.songs[1].proposedGain).toBe(2);
    expect(plan.songs[1].limitedByFader).toBe(true);
  });

  it("leaves silent songs alone", () => {
    const plan = planLevels(
      [region("a"), region("b"), region("c"), region("d")],
      [
        measured("a", -12),
        measured("b", -12),
        measured("c", -12, { tracksWithAudio: ["keys", "pad"] }),
        measured("d", -70, { hasSignal: false, tracksWithAudio: [] }),
      ],
      { kind: "median" },
    );
    expect(plan.songs.find((s) => s.regionId === "d")?.proposedGain).toBeNull();
  });

  it("ticks by default only songs that change audibly and are not silenced on purpose", () => {
    const plan = planLevels(
      [region("a"), region("b"), region("c"), region("off", 0)],
      [measured("a", -10), measured("b", -14.2), measured("c", -14), measured("off", -20)],
      { kind: "song", regionId: "c" },
    );
    expect([...defaultSongsToApply(plan)]).toEqual(["a"]);
  });
});

describe("groupLevelTracks", () => {
  // Two songs with their own stems, plus a click that runs through both.
  const setlist = (): SongView => ({
    ...song([]),
    regions: [
      { id: "r2", name: "Second", startSeconds: 100, endSeconds: 200 } as never,
      { id: "r1", name: "First", startSeconds: 0, endSeconds: 100 } as never,
    ],
    tracks: [
      track("d1", "Drums"),
      track("d2", "Drums"),
      track("click", "Click"),
      track("loose", "Outside"),
    ] as never,
    clips: [
      { id: "a", trackId: "d1", timelineStartSeconds: 0, durationSeconds: 90 },
      { id: "b", trackId: "d2", timelineStartSeconds: 110, durationSeconds: 80 },
      { id: "c", trackId: "click", timelineStartSeconds: 0, durationSeconds: 200 },
      { id: "d", trackId: "loose", timelineStartSeconds: 250, durationSeconds: 10 },
    ] as never,
  });

  it("gives each song its own tracks, in timeline order, with shared ones once and first", () => {
    const value = setlist();
    const groups = groupLevelTracks(value, levelableTracks(value, cueRoutes));
    expect(groups.map((g) => [g.key, g.tracks.map((t) => t.id)])).toEqual([
      ["shared", ["click"]],
      ["r1", ["d1"]],
      ["r2", ["d2"]],
    ]);
    expect(groups[1].region?.name).toBe("First");
  });

  it("lists no track that sounds outside every song: it is never measured", () => {
    const value = setlist();
    const ids = groupLevelTracks(value, levelableTracks(value, cueRoutes)).flatMap((g) =>
      g.tracks.map((t) => t.id),
    );
    expect(ids).not.toContain("loose");
  });
});
