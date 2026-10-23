import { describe, expect, it } from "vitest";

import { buildTrackRowLayout, spacersFor, visibleTrackWindow, type TrackRowLayout } from "./trackLayout";

/** `resolveVisibleTrackWindow` as it lived in `Renderer/drawTracks.ts` before
 * it moved here. The canvas must keep culling exactly these rows. */
function legacyCanvasWindow(layout: TrackRowLayout, viewportScrollTop: number, viewportHeight: number) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const trackCount = layout.heights.length;
  const safeScrollTop = Math.max(0, viewportScrollTop);
  const safeViewportHeight = Math.max(layout.baseHeight, viewportHeight || layout.baseHeight);
  const startIndex = clamp(layout.rowAt(safeScrollTop) - 1, 0, trackCount);
  const endIndex = clamp(
    layout.rowAt(safeScrollTop + safeViewportHeight) + 2,
    startIndex,
    trackCount,
  );
  return { startIndex, endIndex };
}

const canvasMargin = { rowsBefore: 1, rowsAfter: 1 };

function uniformLayout(count: number, height = 40) {
  return buildTrackRowLayout(
    Array.from({ length: count }, (_, index) => ({ id: `t${index}` })),
    height,
  );
}

function mixedLayout(count: number) {
  return buildTrackRowLayout(
    Array.from({ length: count }, (_, index) => ({
      id: `t${index}`,
      heightOffset: [0, 36, -10, 120, 0, 8][index % 6],
    })),
    48,
  );
}

const sumHeights = (layout: TrackRowLayout, start: number, end: number) =>
  layout.heights.slice(start, end).reduce((sum, height) => sum + height, 0);

describe("visibleTrackWindow", () => {
  const layouts: Array<[string, TrackRowLayout]> = [
    ["uniform", uniformLayout(138)],
    ["mixed heights", mixedLayout(138)],
    ["single row", uniformLayout(1)],
    ["empty", uniformLayout(0)],
  ];

  for (const [name, layout] of layouts) {
    it(`matches the canvas's previous window (${name})`, () => {
      const scrolls = [0, 1, 37, layout.totalHeight / 2, layout.totalHeight - 300, layout.totalHeight, layout.totalHeight + 500, -20];
      const heights = [0, 1, 300, 600, 1080];
      for (const scrollTop of scrolls) {
        for (const viewportHeight of heights) {
          expect(
            visibleTrackWindow(layout, scrollTop, viewportHeight, canvasMargin),
            `scrollTop=${scrollTop} height=${viewportHeight}`,
          ).toEqual(legacyCanvasWindow(layout, scrollTop, viewportHeight));
        }
      }
    });
  }

  it("widens the band by overscanPx on both sides", () => {
    const layout = uniformLayout(100, 40);
    expect(visibleTrackWindow(layout, 2000, 400)).toEqual({ startIndex: 50, endIndex: 61 });
    expect(visibleTrackWindow(layout, 2000, 400, { overscanPx: 400 })).toEqual({
      startIndex: 40,
      endIndex: 71,
    });
  });
});

describe("spacersFor", () => {
  const cases: Array<[string, TrackRowLayout]> = [
    ["uniform", uniformLayout(60)],
    ["mixed heights", mixedLayout(60)],
    ["single row", uniformLayout(1)],
    ["empty", uniformLayout(0)],
  ];

  for (const [name, layout] of cases) {
    it(`keeps top + mounted + bottom === totalHeight (${name})`, () => {
      const count = layout.heights.length;
      const windows = [
        [0, count],
        [0, Math.min(count, 5)],
        [Math.max(0, count - 5), count],
        [Math.floor(count / 3), Math.floor((2 * count) / 3)],
        [count, count],
        [0, 0],
      ];
      for (const [startIndex, endIndex] of windows) {
        const { top, bottom } = spacersFor(layout, { startIndex, endIndex });
        expect(top + sumHeights(layout, startIndex, endIndex) + bottom, `${startIndex}-${endIndex}`).toBe(
          layout.totalHeight,
        );
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("puts the window's first row at its layout top", () => {
    const layout = mixedLayout(60);
    const { top } = spacersFor(layout, { startIndex: 17, endIndex: 30 });
    expect(top).toBe(layout.tops[17]);
  });
});
