// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyzeSongRequest,
  AnalyzeSongResult,
  ProposedSignatureMarker,
  ProposedTempoMarker,
} from "@libretracks/shared/desktopApi";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";

/**
 * From the user's side: the click and the harmonic tracks are found by name,
 * the proposal is shown for review, and Apply sends exactly what the review
 * shows, in one call (one undo).
 */
type TempoChange = {
  tempoMarkers: ProposedTempoMarker[];
  signatureMarkers: ProposedSignatureMarker[];
};
const analyzeSong = vi.fn<(request: AnalyzeSongRequest) => Promise<AnalyzeSongResult>>();
const applySongAnalysis =
  vi.fn<
    (regionId: string, tempo: TempoChange | null, key: string | null) => Promise<TransportSnapshot>
  >();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  analyzeSong: (request: AnalyzeSongRequest) => analyzeSong(request),
  cancelAnalyzeSong: async () => {},
  listenToSongAnalysisProgress: async () => () => {},
  applySongAnalysis: (regionId: string, tempo: TempoChange | null, key: string | null) =>
    applySongAnalysis(regionId, tempo, key),
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
      { id: "a", name: "First", startSeconds: 0, endSeconds: 100, key: null } as never,
      {
        id: "b",
        name: "Second",
        startSeconds: 100,
        endSeconds: 200,
        key: "C",
        transposeSemitones: 0,
      } as never,
    ],
    tracks: [audioTrack("keys", "Keys"), audioTrack("drums", "Drums"), audioTrack("click", "Click")],
    clips: [
      { id: "c1", trackId: "keys", timelineStartSeconds: 0, durationSeconds: 200 } as never,
      { id: "c2", trackId: "drums", timelineStartSeconds: 0, durationSeconds: 200 } as never,
      { id: "c3", trackId: "click", timelineStartSeconds: 0, durationSeconds: 200 } as never,
    ],
    projectRevision: 1,
  };
}

function result(overrides: Partial<AnalyzeSongResult> = {}): AnalyzeSongResult {
  return {
    cancelled: false,
    regionId: "b",
    regionStartSeconds: 100,
    tempo: {
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
    },
    tempoUnavailable: null,
    key: {
      analysis: {
        key: "D",
        confidence: 0.2,
        alternative: null,
        relativeDoubt: false,
        tuningCents: -32,
        candidates: [{ key: "D", score: 0.8 }],
      },
      currentKey: "C",
      transposeSemitones: 0,
    },
    missingFiles: [],
    ...overrides,
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

async function analyzeAndReview() {
  fireEvent.click(screen.getByText("transport.songAnalysis.analyze"));
  await waitFor(() => expect(analyzeSong).toHaveBeenCalledTimes(1));
}

describe("SongAnalysisModal", () => {
  it("renders nothing while closed", () => {
    useSongAnalysisStore.setState({ target: null });
    const { container } = render(<SongAnalysisModal onApplied={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("reads the tempo from the click and the key from the harmonic tracks", async () => {
    analyzeSong.mockResolvedValue(result());
    render(<SongAnalysisModal onApplied={() => {}} />);

    expect(
      (screen.getByLabelText("transport.songAnalysis.clickTrack") as HTMLSelectElement).value,
    ).toBe("click");
    await analyzeAndReview();
    // Drums and click stay out of the key; keys go in.
    expect(analyzeSong).toHaveBeenCalledWith({
      regionId: "b",
      clickTrackIds: ["click"],
      keyTrackIds: ["keys"],
    });
    await screen.findByText("transport.songAnalysis.warning.clickGap");
    // Positions are read from the song start: 1:01.0, not 2:41.0.
    expect(screen.getByText("1:01.0")).toBeTruthy();
    expect(screen.getByText(/transport\.songAnalysis\.tuningFlat.*32/)).toBeTruthy();
  });

  it("applies tempo, meter and key in one call, edits included", async () => {
    analyzeSong.mockResolvedValue(result());
    const snapshot = { projectRevision: 2 } as TransportSnapshot;
    applySongAnalysis.mockResolvedValue(snapshot);
    const onApplied = vi.fn();
    render(<SongAnalysisModal onApplied={onApplied} />);
    await analyzeAndReview();

    const bpmInput = await screen.findByDisplayValue("92");
    fireEvent.change(bpmInput, { target: { value: "92,5" } });
    fireEvent.change(screen.getByLabelText("transport.songAnalysis.key"), {
      target: { value: "Bm" },
    });
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));

    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongAnalysis).toHaveBeenCalledWith(
      "b",
      {
        tempoMarkers: [
          { startSeconds: 100.5, bpm: 92.5, restoresNextSong: false },
          { startSeconds: 200, bpm: 120, restoresNextSong: true },
        ],
        signatureMarkers: [
          { startSeconds: 100.5, signature: "6/8", restoresNextSong: false },
          { startSeconds: 200, signature: "4/4", restoresNextSong: true },
        ],
      },
      "Bm",
    );
    expect(onApplied).toHaveBeenCalledWith(snapshot);
    await screen.findByText("transport.songAnalysis.applied");
  });

  it("can analyze only the key, and applies only the key", async () => {
    analyzeSong.mockResolvedValue(result({ tempo: null }));
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    fireEvent.change(screen.getByLabelText("transport.songAnalysis.clickTrack"), {
      target: { value: "" },
    });
    await analyzeAndReview();
    expect(analyzeSong.mock.calls[0][0].clickTrackIds).toEqual([]);

    await screen.findByLabelText("transport.songAnalysis.key");
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledWith("b", null, "D"));
  });

  it("leaves the key alone when it is unticked", async () => {
    analyzeSong.mockResolvedValue(result());
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    fireEvent.click(await screen.findByLabelText("transport.songAnalysis.applyKey"));
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongAnalysis.mock.calls[0][2]).toBeNull();
  });

  it("will not apply an invalid value", async () => {
    analyzeSong.mockResolvedValue(result());
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();

    const meterInput = await screen.findByDisplayValue("6/8");
    fireEvent.change(meterInput, { target: { value: "6/7" } });
    expect(
      screen.getByText("transport.songAnalysis.apply").closest("button")?.disabled,
    ).toBe(true);
  });

  it("explains why a warped song got its key but not its tempo", async () => {
    analyzeSong.mockResolvedValue(
      result({ tempo: null, tempoUnavailable: "song_analysis_warp" }),
    );
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    await screen.findByText("transport.songAnalysis.errorWarp");
    expect(screen.getByLabelText("transport.songAnalysis.key")).toBeTruthy();
  });

  it("offers the relative key when the call is close", async () => {
    analyzeSong.mockResolvedValue(
      result({
        key: {
          analysis: {
            key: "C",
            confidence: 0.03,
            alternative: "Am",
            relativeDoubt: true,
            tuningCents: 0,
            candidates: [],
          },
          currentKey: null,
          transposeSemitones: 2,
        },
      }),
    );
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    await screen.findByText(/transport\.songAnalysis\.keyRelativeDoubt.*Am/);
    // Transposed +2, it sounds a tone up.
    expect(screen.getByText(/transport\.songAnalysis\.keyTransposed.*"key":"D"/)).toBeTruthy();
  });
});
