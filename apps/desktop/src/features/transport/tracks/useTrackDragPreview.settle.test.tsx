// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import type { TrackDragState } from "../types";
import { buildTrackRowLayout } from "./trackLayout";
import { useTrackDragPreview } from "./useTrackDragPreview";

/**
 * Soltar una pista: la vista previa ya enseña el resultado, asi que se queda
 * quieta (sin copia flotante, sin fantasma) hasta que llega el orden nuevo, por
 * mucho que tarde el backend. Antes volvia atras a los 250 ms y luego saltaba.
 */

const ROW = 40;
const ids = ["a", "b", "c", "d"];

const songWith = (order: string[]) =>
  ({
    id: "song",
    tracks: order.map((id) => ({ id, parentTrackId: null, kind: "audio" })),
    automationTrack: null,
  }) as unknown as SongView;

function mountRows() {
  const shell = document.createElement("div");
  ids.forEach((id, index) => {
    const row = document.createElement("div");
    row.className = "lt-track-header-row";
    row.dataset.trackId = id;
    Object.defineProperty(row, "offsetHeight", { value: ROW });
    Object.defineProperty(row, "offsetWidth", { value: 200 });
    row.getBoundingClientRect = () =>
      ({ top: index * ROW, bottom: (index + 1) * ROW, height: ROW, left: 0, right: 200, width: 200 }) as DOMRect;
    shell.append(row);
  });
  document.body.append(shell);
  return shell;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-track-id="${id}"]`)!;

function dragOf(trackId: string, y: number): NonNullable<TrackDragState> {
  return {
    trackId,
    pointerId: 1,
    startClientX: 10,
    startClientY: y,
    currentClientX: 10,
    currentClientY: 3 * ROW + 30,
    pointerScaleX: 1,
    pointerScaleY: 1,
    isDragging: true,
    rowElement: row(trackId) as HTMLDivElement,
    headerElement: null,
    originSurface: "daw",
  } as NonNullable<TrackDragState>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("settling a track drop", () => {
  it("holds the shifted rows until the new order is painted, then lets go without sliding", () => {
    const shell = mountRows();
    const layout = buildTrackRowLayout(ids.map((id) => ({ id })), ROW);
    const songRef = { current: songWith(ids) };
    const { result, rerender } = renderHook(
      ({ song }) =>
        useTrackDragPreview({
          song,
          songRef,
          timelineShellRef: { current: shell },
          getVisibleTrackIds: () => ids,
          getTrackLayout: () => layout,
        }),
      { initialProps: { song: songRef.current } },
    );

    // Arrastra "a" debajo de "d".
    const drag = dragOf("a", 10);
    const drop = result.current.resolveTrackDrop(drag, 10, 3 * ROW + 30);
    expect(drop).toEqual({ targetTrackId: "d", mode: "after" });
    result.current.applyTrackDragVisuals(drag, drop);
    const shifted = row("a").style.transform;
    expect(shifted).not.toBe("");
    expect(row("a").classList.contains("lt-reorder-ghost")).toBe(true);
    expect(document.querySelector(".lt-drag-lift")).not.toBeNull();

    act(() => result.current.clearTrackDragVisuals({ settle: true }));
    // Aceptado: sin copia flotante y sin fantasma, en su hueco final.
    expect(document.querySelector(".lt-drag-lift")).toBeNull();
    expect(row("a").classList.contains("lt-reorder-ghost")).toBe(false);
    expect(row("a").style.transform).toBe(shifted);

    // El backend tarda: la lista NO vuelve a su sitio antiguo.
    act(() => vi.advanceTimersByTime(2000));
    expect(row("a").style.transform).toBe(shifted);

    // Llega el orden nuevo: se suelta de golpe, sin animar.
    songRef.current = songWith(["b", "c", "d", "a"]);
    rerender({ song: songRef.current });
    expect(row("a").style.transform).toBe("");
    expect(row("a").classList.contains("lt-reorder-shifting")).toBe(false);
  });

  it("slides the rows back when the drop is reverted", () => {
    const shell = mountRows();
    const layout = buildTrackRowLayout(ids.map((id) => ({ id })), ROW);
    const songRef = { current: songWith(ids) };
    const { result } = renderHook(() =>
      useTrackDragPreview({
        song: songRef.current,
        songRef,
        timelineShellRef: { current: shell },
        getVisibleTrackIds: () => ids,
        getTrackLayout: () => layout,
      }),
    );
    const drag = dragOf("a", 10);
    const drop = result.current.resolveTrackDrop(drag, 10, 3 * ROW + 30);
    result.current.applyTrackDragVisuals(drag, drop);
    act(() => result.current.clearTrackDragVisuals({ settle: true }));

    act(() => result.current.clearTrackDragVisuals({ revert: true }));

    expect(row("a").style.transform).toBe("");
  });
});
