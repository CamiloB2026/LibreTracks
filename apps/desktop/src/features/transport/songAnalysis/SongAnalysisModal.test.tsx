// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyzeSongTempoResult,
  ProposedSignatureMarker,
  ProposedTempoMarker,
} from "@libretracks/shared/desktopApi";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";

/**
 * From the user's side: the click is found by name, the proposal is shown for
 * review, and Apply sends exactly what the table shows, in one call (one undo).
 */
const analyzeSongTempo =
  vi.fn<(request: { regionId: string; trackIds: string[] }) => Promise<AnalyzeSongTempoResult>>();
const applySongTempoAnalysis =
  vi.fn<
    (
      regionId: string,
      tempo: ProposedTempoMarker[],
      signatures: ProposedSignatureMarker[],
    ) => Promise<TransportSnapshot>
  >();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  analyzeSongTempo: (request: { regionId: string; trackIds: string[] }) =>
    analyzeSongTempo(request),
  cancelAnalyzeSongTempo: async () => {},
  listenToSongAnalysisProgress: async () => () => {},
  applySongTempoAnalysis: (
    regionId: string,
    tempo: ProposedTempoMarker[],
    signatures: ProposedSignatureMarker[],
  ) => applySongTempoAnalysis(regionId, tempo, signatures),
  seekTransport: async () => ({}) as TransportSnapshot,
}));

const { SongAnalysisModal } = await import("./SongAnalysisModal");
const { useSongAnalysisStore } = await import("./songAnalysisStore");
const { useSongStore } = await import("../songStore");

const audioTrack = (id: string, name: string) =>
  ({ id, name, kind: "audio", depth: 0, parentTrackId: null }) as never;

function song(): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 300,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    sectionMarkers: [],
    regions: [
      { id: "a", name: "First", startSeconds: 0, endSeconds: 100 } as never,
      { id: "b", name: "Second", startSeconds: 100, endSeconds: 200 } as never,
    ],
    tracks: [audioTrack("keys", "Keys"), audioTrack("click", "Click")],
    clips: [
      { id: "c1", trackId: "keys", timelineStartSeconds: 0, durationSeconds: 200 } as never,
      { id: "c2", trackId: "click", timelineStartSeconds: 0, durationSeconds: 200 } as never,
    ],
    projectRevision: 1,
  };
}

function result(): AnalyzeSongTempoResult {
  return {
    cancelled: false,
    regionId: "b",
    regionStartSeconds: 100,
    analysis: {
      segments: [{ startSeconds: 0.5, bpm: 92, beatsPerBar: 6, beatUnit: 8, bars: 40 }],
      warnings: [{ seconds: 61, kind: "clickGap" }],
      beatCount: 240,
      downbeatKnown: true,
    },
    proposal: {
      tempoMarkers: [
        { startSeconds: 100.5, bpm: 92, restoresNextSong: false },
        { startSeconds: 200, bpm: 120, restoresNextSong: true },
      ],
      signatureMarkers: [
        { startSeconds: 100.5, signature: "6/8", restoresNextSong: false },
        { startSeconds: 200, signature: "4/4", restoresNextSong: true },
      ],
      currentBpm: 120,
      currentSignature: "4/4",
      unchanged: false,
    },
    missingFiles: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSongStore.setState({ song: song() });
  useSongAnalysisStore.setState({ target: { regionId: "b", regionName: "Second" } });
});

afterEach(() => {
  cleanup();
  useSongAnalysisStore.setState({ target: null });
});

describe("SongAnalysisModal", () => {
  it("renders nothing while closed", () => {
    useSongAnalysisStore.setState({ target: null });
    const { container } = render(<SongAnalysisModal onApplied={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("analyzes the click-named track of the chosen song", async () => {
    analyzeSongTempo.mockResolvedValue(result());
    render(<SongAnalysisModal onApplied={() => {}} />);

    expect(screen.getByRole("combobox")).toHaveProperty("value", "click");
    fireEvent.click(screen.getByText("transport.songAnalysis.analyze"));

    await waitFor(() => expect(analyzeSongTempo).toHaveBeenCalledTimes(1));
    expect(analyzeSongTempo).toHaveBeenCalledWith({ regionId: "b", trackIds: ["click"] });
    await screen.findByText("transport.songAnalysis.warning.clickGap");
    // Positions are read from the song start: 1:01.0, not 2:41.0.
    expect(screen.getByText("1:01.0")).toBeTruthy();
  });

  it("applies the reviewed values in one call, edits included", async () => {
    analyzeSongTempo.mockResolvedValue(result());
    const snapshot = { projectRevision: 2 } as TransportSnapshot;
    applySongTempoAnalysis.mockResolvedValue(snapshot);
    const onApplied = vi.fn();
    render(<SongAnalysisModal onApplied={onApplied} />);
    fireEvent.click(screen.getByText("transport.songAnalysis.analyze"));

    const bpmInput = (await screen.findByDisplayValue("92")) as HTMLInputElement;
    fireEvent.change(bpmInput, { target: { value: "92,5" } });
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));

    await waitFor(() => expect(applySongTempoAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongTempoAnalysis).toHaveBeenCalledWith(
      "b",
      [
        { startSeconds: 100.5, bpm: 92.5, restoresNextSong: false },
        { startSeconds: 200, bpm: 120, restoresNextSong: true },
      ],
      [
        { startSeconds: 100.5, signature: "6/8", restoresNextSong: false },
        { startSeconds: 200, signature: "4/4", restoresNextSong: true },
      ],
    );
    expect(onApplied).toHaveBeenCalledWith(snapshot);
    await screen.findByText("transport.songAnalysis.applied");
  });

  it("will not apply an invalid value", async () => {
    analyzeSongTempo.mockResolvedValue(result());
    render(<SongAnalysisModal onApplied={() => {}} />);
    fireEvent.click(screen.getByText("transport.songAnalysis.analyze"));

    const meterInput = await screen.findByDisplayValue("6/8");
    fireEvent.change(meterInput, { target: { value: "6/7" } });
    expect(
      screen.getByText("transport.songAnalysis.apply").closest("button")?.disabled,
    ).toBe(true);
  });

  it("explains why a warped song cannot be analyzed", async () => {
    analyzeSongTempo.mockRejectedValue(new Error("song_analysis_warp"));
    render(<SongAnalysisModal onApplied={() => {}} />);
    fireEvent.click(screen.getByText("transport.songAnalysis.analyze"));
    await screen.findByText(/transport\.songAnalysis\.errorWarp/);
  });
});
