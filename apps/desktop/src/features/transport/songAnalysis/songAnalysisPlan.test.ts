import { describe, expect, it } from "vitest";

import type { TempoProposal } from "@libretracks/shared/desktopApi";
import type { SongView } from "@libretracks/shared/models";

import {
  buildApplyPayload,
  clickTrackOptions,
  formatSongPosition,
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
