import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompactView } from "./CompactView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: false,
}));

vi.mock("../store", () => ({
  useTransportStore: (selector: (state: { optimisticRegionMaster: object }) => unknown) =>
    selector({ optimisticRegionMaster: {} }),
}));

vi.mock("../tracks/TrackMeter", () => ({
  SongMasterMeter: () => null,
  TrackMeter: () => null,
}));

vi.mock("../structure/ArrangementBadge", () => ({
  ArrangementBadge: () => null,
}));

const region = {
  id: "song-1",
  name: "Cancion",
  startSeconds: 0,
  endSeconds: 60,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
};

const clip = {
  id: "clip-1",
  clipName: "bateria.wav",
  trackId: "track-1",
  trackName: "Bateria",
};

function renderCompactView(onDeleteClip: () => void) {
  const props = {
    regions: [region],
    tracks: [],
    activeRegionId: null,
    pendingRegionId: null,
    clipsByRegion: { [region.id]: [clip] },
    audioRoutingOptions: [],
    mixerHandlers: {
      onToggleMute: vi.fn(),
      onToggleSolo: vi.fn(),
      onToggleTranspose: vi.fn(),
      onVolumeChange: vi.fn(),
      onCommitVolume: vi.fn(),
      onPanChange: vi.fn(),
      onCommitPan: vi.fn(),
      onAudioToChange: vi.fn(),
    },
    onTrackContextMenu: vi.fn(),
    selectedTrackIds: [],
    onTrackSelect: vi.fn(),
    onTrackDragStart: vi.fn(),
    selectedRegionId: null,
    onSelectRegion: vi.fn(),
    compactMixerFilterActiveSong: false,
    collapsedFolders: new Set<string>(),
    onToggleFolder: vi.fn(),
    onMasterGainChange: vi.fn(),
    onMasterGainCommit: vi.fn(),
    onDropOsFilesIntoSong: vi.fn(),
    onDropLibraryAssetsIntoSong: vi.fn(),
    onMoveClipToTrack: vi.fn(),
    onDeleteClip,
    onPlaySong: vi.fn(),
    onRenameSong: vi.fn(),
    onSetSongBpm: vi.fn(),
    onDeleteSong: vi.fn(),
    onExportSong: vi.fn(),
    onSongColumnWidthChange: vi.fn(),
    onSetSongKey: vi.fn(),
    bpmByRegion: {},
    onSnapshotApplied: vi.fn(),
    onImportSongPackageFromDialog: vi.fn(),
    onImportSongPackageFromOsFile: vi.fn(),
    dragPreview: null,
  } satisfies ComponentProps<typeof CompactView>;

  render(<CompactView {...props} />);
}

function touchPointer(type: "pointerdown" | "pointerup", pointerId: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: 24, clientY: 12 });
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: pointerId },
  });
  return event;
}

describe("CompactView touch context menu", () => {
  afterEach(() => vi.useRealTimers());

  it("opens a clip menu on long-press and keeps its actions clickable", () => {
    vi.useFakeTimers();
    const onDeleteClip = vi.fn();
    renderCompactView(onDeleteClip);
    const clipEntry = screen.getByText(clip.clipName).closest(".lt-compact-clip-entry");

    expect(clipEntry).not.toBeNull();
    fireEvent(clipEntry!, touchPointer("pointerdown", 12));
    act(() => vi.advanceTimersByTime(550));

    expect(screen.getByText("compactView.deleteClip")).toBeTruthy();
    fireEvent(clipEntry!, touchPointer("pointerup", 12));
    fireEvent.click(clipEntry!);
    fireEvent.click(screen.getByText("compactView.deleteClip"));

    expect(onDeleteClip).toHaveBeenCalledWith(clip.id);
  });
});