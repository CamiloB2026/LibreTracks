import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SongRegionSummary } from "@libretracks/shared/models";
import { CompactSongHeaderComponent } from "./CompactSongHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "liveView.queued" ? "En cola" : key),
  }),
}));

const region: SongRegionSummary = {
  id: "second",
  name: "Segunda",
  startSeconds: 40,
  endSeconds: 80,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
};

const renderHeader = (isQueued: boolean, onSelect = vi.fn()) => (
  <CompactSongHeaderComponent
    region={region}
    isActive={false}
    isQueued={isQueued}
    bpm={120}
    onMasterGainChange={vi.fn()}
    onMasterGainCommit={vi.fn()}
    onPlay={vi.fn()}
    onRename={vi.fn()}
    onSetBpm={vi.fn()}
    onDelete={vi.fn()}
    onExport={vi.fn()}
    onSetKey={vi.fn()}
    isSelected={false}
    onSelect={onSelect}
  />
);

function touchPointerDown(pointerId: number) {
  const event = new MouseEvent("pointerdown", {
    bubbles: true,
    clientX: 24,
    clientY: 12,
  });
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: pointerId },
  });
  return event;
}

describe("CompactSongHeader", () => {
  afterEach(() => vi.useRealTimers());

  it("identifies the destination of an armed song jump", () => {
    const { container, rerender } = render(renderHeader(true));

    expect(container.firstElementChild?.classList.contains("is-queued")).toBe(true);
    expect(screen.getByText("En cola")).toBeTruthy();

    rerender(renderHeader(false));

    expect(container.firstElementChild?.classList.contains("is-queued")).toBe(false);
    expect(screen.queryByText("En cola")).toBeNull();
  });

  it("el selector de nota tiene atras y vuelve al menu raiz", () => {
    const { container } = render(renderHeader(false));
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.queryByText("transport.menu.levelSongs")).toBeNull();
    fireEvent.click(screen.getByText("compactView.songKey ▸"));
    expect(screen.getByText(/Sin nota/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(screen.queryByText(/Sin nota/)).toBeNull();
    expect(screen.getByText("compactView.renameSong")).toBeTruthy();
  });

  it("abre el menu al mantener pulsada la canción y absorbe el clic posterior", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const { container } = render(renderHeader(false, onSelect));
    const header = container.firstElementChild as HTMLElement;

    fireEvent(header, touchPointerDown(11));
    act(() => vi.advanceTimersByTime(550));
    expect(screen.getByText("compactView.renameSong")).toBeTruthy();

    fireEvent.click(header);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the reorder grip only when reordering is wired", () => {
    const onKeyDown = vi.fn();
    const { rerender } = render(renderHeader(false));
    expect(screen.queryByRole("button", { name: "liveView.reorderSong" })).toBeNull();

    rerender(
      <CompactSongHeaderComponent
        {...renderHeader(false).props}
        reorderHandleProps={{
          onPointerDown: vi.fn(),
          onClick: vi.fn(),
          onKeyDown,
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "liveView.reorderSong" }), {
      key: "ArrowRight",
    });
    expect(onKeyDown).toHaveBeenCalled();
  });
});
