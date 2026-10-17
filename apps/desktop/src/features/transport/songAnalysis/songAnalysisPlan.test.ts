import { describe, expect, it } from "vitest";

import type { TempoProposal } from "@libretracks/shared/desktopApi";
import type { SongView } from "@libretracks/shared/models";

import {
  buildApplyPayload,
  clickTrackOptions,
  formatSongPosition,
  guideTrackOptions,
  isUnrecognised,
  keyTrackOptions,
  markersForLabels,
  placeGuideSections,
  musicTempoTrackIds,
  scaleTempoRows,
  parseBpm,
  parseSignature,
  reviewRows,
} from "./songAnalysisPlan";

const audioTrack = (id: string, name: string, kind = "audio") =>
  ({ id, name, kind, depth: 0, parentTrackId: null }) as never;

function song(): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 300,
    tempoMarkers: [
      { id: "t-before", startSeconds: 50, bpm: 100 },
      { id: "t-inside", startSeconds: 130, bpm: 88 },
    ],
    timeSignatureMarkers: [{ id: "s-inside", startSeconds: 110, signature: "3/4" }],
    sectionMarkers: [],
    regions: [
      { id: "a", name: "First", startSeconds: 0, endSeconds: 100 } as never,
      { id: "b", name: "Second", startSeconds: 100, endSeconds: 200 } as never,
    ],
    tracks: [
      audioTrack("keys", "Keys"),
      audioTrack("folder", "Click folder", "folder"),
      audioTrack("metro", "Metrónomo"),
      audioTrack("guide", "Guía"),
      audioTrack("other-song", "Click"),
    ],
    clips: [
      { id: "c1", trackId: "keys", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      { id: "c2", trackId: "metro", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      { id: "c3", trackId: "guide", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      // Only in the first song: not a candidate for the second.
      { id: "c4", trackId: "other-song", timelineStartSeconds: 0, durationSeconds: 100 } as never,
    ],
    projectRevision: 1,
  };
}

const proposal: TempoProposal = {
  tempoMarkers: [
    { startSeconds: 100.5, bpm: 92, restoresNextSong: false },
    { startSeconds: 200, bpm: 100, restoresNextSong: true },
  ],
  signatureMarkers: [{ startSeconds: 100.5, signature: "6/8", restoresNextSong: false }],
  currentBpm: 100,
  currentSignature: "4/4",
  unchanged: false,
};

describe("clickTrackOptions", () => {
  it("offers the song's audio tracks with a click-named one first and preselected", () => {
    const { options, preselected } = clickTrackOptions(song(), "b");
    expect(options.map((option) => option.id)).toEqual(["metro", "keys", "guide"]);
    expect(preselected).toBe("metro");
  });

  it("preselects nothing when no track is named like a click", () => {
    const withoutClick = song();
    withoutClick.tracks = withoutClick.tracks.filter((track) => track.id !== "metro");
    expect(clickTrackOptions(withoutClick, "b").preselected).toBeNull();
  });
});

describe("keyTrackOptions", () => {
  it("preselects the harmonic tracks and leaves out click, guide and percussion", () => {
    const withDrums = song();
    withDrums.tracks.push(audioTrack("drums-folder", "Drums", "folder"));
    withDrums.tracks.push({
      ...(audioTrack("kick", "Kick In") as object),
      parentTrackId: "drums-folder",
    } as never);
    withDrums.tracks.push({
      ...(audioTrack("tom", "Low") as object),
      parentTrackId: "drums-folder",
    } as never);
    withDrums.clips.push(
      { id: "c5", trackId: "kick", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      { id: "c6", trackId: "tom", timelineStartSeconds: 100, durationSeconds: 100 } as never,
    );
    const options = keyTrackOptions(withDrums, "b");
    expect(options.map((option) => [option.id, option.preselected])).toEqual([
      ["keys", true],
      ["metro", false],
      ["guide", false],
      ["kick", false],
      // Its own name says nothing; its folder does.
      ["tom", false],
    ]);
  });
});

describe("tempo from the music", () => {
  it("uses every track but the click and the cues", () => {
    // In the fixture: Keys, Metrónomo (click) and Guía (cue) sound in "b".
    expect(musicTempoTrackIds(song(), "b")).toEqual(["keys"]);
  });

  it("scales the song's tempo markers, not the next song's", () => {
    const scaled = scaleTempoRows(reviewRows(proposal), 2);
    expect(scaled.filter((row) => row.kind === "tempo").map((row) => row.text)).toEqual([
      "184",
      "100",
    ]);
    // Out of range stays.
    const tooFast = scaleTempoRows(scaled, 2);
    expect(tooFast.find((row) => row.kind === "tempo")?.text).toBe("184");
  });
});

describe("guide", () => {
  it("preselects the guide-named track", () => {
    expect(guideTrackOptions(song(), "b").preselected).toBe("guide");
  });

  it("reads the labels as a section and a cue", () => {
    expect(markersForLabels(["verse_3", "drums_in"])).toEqual({
      section: "verse:3",
      cue: "drums_in",
      ignored: false,
    });
    expect(markersForLabels(["chorus"])).toEqual({ section: "chorus", cue: "", ignored: false });
    expect(markersForLabels(["count"])).toEqual({ section: "", cue: "", ignored: true });
    // A variant the picker does not offer becomes the plain kind.
    expect(markersForLabels(["verse_9"]).section).toBe("verse");
    expect(markersForLabels(["not_a_kind"])).toEqual({ section: "", cue: "", ignored: false });
    expect(isUnrecognised(markersForLabels([]))).toBe(true);
    expect(isUnrecognised(markersForLabels(["count"]))).toBe(false);
  });

  const plain = () => ({ ...song(), tempoMarkers: [], timeSignatureMarkers: [] });
  const oneAnnouncement = (endSeconds: number, labels: string[]) => ({
    analysis: {
      announcements: [{ startSeconds: endSeconds - 0.5, endSeconds, group: 0 }],
      groups: [
        {
          labels,
          transcript: null,
          matchCost: null,
          occurrences: 1,
          firstStartSeconds: endSeconds - 0.5,
          firstEndSeconds: endSeconds,
        },
      ],
    },
    markers: [markersForLabels(labels)],
  });

  it("puts both markers of one announcement on the next downbeat", () => {
    const { analysis, markers } = oneAnnouncement(5.3, ["verse_3", "drums_in"]);
    // 120 BPM 4/4: bars of 2 s. Song at 100 s; ends at 105.3 → 106.
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)).toEqual([
      { startSeconds: 106, kind: "verse", variant: 3, categoryOverride: null },
      { startSeconds: 106, kind: "drums_in", variant: null, categoryOverride: null },
    ]);
  });

  it("a second section of one announcement goes in the cue lane", () => {
    // "Verso a capella": two sections cannot share a spot.
    expect(markersForLabels(["verse", "acapella"])).toEqual({
      section: "verse",
      cue: "acapella",
      ignored: false,
    });
    const { analysis, markers } = oneAnnouncement(5.3, ["verse", "acapella"]);
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)).toEqual([
      { startSeconds: 106, kind: "verse", variant: null, categoryOverride: null },
      { startSeconds: 106, kind: "acapella", variant: null, categoryOverride: "cue" },
    ]);
  });

  it("two announcements naming sections on one downbeat: the later is a cue", () => {
    const analysis = {
      announcements: [
        { startSeconds: 4.0, endSeconds: 4.5, group: 0 },
        { startSeconds: 4.8, endSeconds: 5.3, group: 1 },
      ],
      groups: [0, 1].map(() => ({
        labels: [],
        transcript: null,
        matchCost: null,
        occurrences: 1,
        firstStartSeconds: 4,
        firstEndSeconds: 5.3,
      })),
    };
    const markers = [markersForLabels(["chorus"]), markersForLabels(["tag"])];
    expect(
      placeGuideSections(plain(), "b", 100, analysis, markers, null).map((m) => [
        m.kind,
        m.categoryOverride,
      ]),
    ).toEqual([
      ["chorus", null],
      ["tag", "cue"],
    ]);
  });

  it("a word's tail just past the downbeat still lands on it", () => {
    // "…cuatro" ends 50 ms after the downbeat at 106 (measured on a real
    // guide against markers placed by hand): the section is at 106, not 108.
    const { analysis, markers } = oneAnnouncement(6.05, ["intro"]);
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)[0].startSeconds).toBe(106);
  });

  it("a guide that speaks two bars ahead puts the section a bar later", () => {
    const { analysis, markers } = oneAnnouncement(5.3, ["intro"]);
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null, 2)[0].startSeconds).toBe(
      108,
    );
  });

  it("follows the tempo the review is about to write", () => {
    const { analysis, markers } = oneAnnouncement(5.3, ["intro"]);
    const tempo = {
      tempoMarkers: [{ startSeconds: 100, bpm: 60, restoresNextSong: false }],
      signatureMarkers: [{ startSeconds: 100, signature: "4/4", restoresNextSong: false }],
    };
    // 60 BPM: bars of 4 s from 100 → 108.
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, tempo)[0].startSeconds).toBe(108);
  });
});

describe("parsing the edited values", () => {
  it("accepts BPMs in the app's range, comma or point", () => {
    expect(parseBpm("92,5")).toBe(92.5);
    expect(parseBpm(" 120 ")).toBe(120);
    expect(parseBpm("10")).toBeNull();
    expect(parseBpm("abc")).toBeNull();
  });

  it("accepts real meters only", () => {
    expect(parseSignature(" 6 / 8 ")).toBe("6/8");
    expect(parseSignature("7/4")).toBe("7/4");
    expect(parseSignature("4/3")).toBeNull();
    expect(parseSignature("0/4")).toBeNull();
  });

  it("formats positions from the song start", () => {
    expect(formatSongPosition(65.27)).toBe("1:05.3");
    expect(formatSongPosition(0)).toBe("0:00.0");
  });
});

describe("buildApplyPayload", () => {
  it("sends the edited values of both kinds", () => {
    const rows = reviewRows(proposal).map((row) =>
      row.kind === "tempo" && row.index === 0 ? { ...row, text: "93" } : row,
    );
    expect(buildApplyPayload(song(), "b", rows, { tempo: true, signature: true })).toEqual({
      tempoMarkers: [
        { startSeconds: 100.5, bpm: 93, restoresNextSong: false },
        { startSeconds: 200, bpm: 100, restoresNextSong: true },
      ],
      signatureMarkers: [{ startSeconds: 100.5, signature: "6/8", restoresNextSong: false }],
    });
  });

  it("keeps the song's own markers of the kind left out, since apply replaces both", () => {
    const payload = buildApplyPayload(song(), "b", reviewRows(proposal), {
      tempo: false,
      signature: true,
    });
    expect(payload?.tempoMarkers).toEqual([
      { startSeconds: 130, bpm: 88, restoresNextSong: false },
    ]);
    const signatureOnly = buildApplyPayload(song(), "b", reviewRows(proposal), {
      tempo: true,
      signature: false,
    });
    expect(signatureOnly?.signatureMarkers).toEqual([
      { startSeconds: 110, signature: "3/4", restoresNextSong: false },
    ]);
  });

  it("refuses to build while a value is invalid", () => {
    const rows = reviewRows(proposal).map((row) =>
      row.kind === "signature" ? { ...row, text: "6/7" } : row,
    );
    expect(buildApplyPayload(song(), "b", rows, { tempo: true, signature: true })).toBeNull();
  });
});
