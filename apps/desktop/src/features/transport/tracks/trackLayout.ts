/**
 * Vertical layout of the arrangement's rows.
 *
 * Every row used to be `trackHeight` tall, so a row's top was just
 * `index * trackHeight` and its height was the global value — the arithmetic
 * was inlined in the canvas, the DOM lanes and the clip drag. A track can now
 * carry its own `heightOffset`, so those three places need one shared answer to
 * "where does row N start and how tall is it", which is what this module is.
 *
 * The per-track value is an OFFSET over the global height rather than an
 * absolute height: the global control (Ctrl + wheel, the toolbar buttons) keeps
 * shifting every row by the same amount, and the differences the user set
 * survive it. The sum is clamped per row, so a track can never collapse past
 * the global minimum nor grow past `TRACK_HEIGHT_ROW_MAX`.
 */
import { TRACK_HEIGHT_MIN, TRACK_HEIGHT_ROW_MAX } from "../constants";

/** The bit of a track this module needs: its id and its own height offset. */
export type TrackRowSource = {
  id: string;
  heightOffset?: number | null;
};

export type TrackRowLayout = {
  /** Height of each row, in draw order. */
  heights: number[];
  /** Top edge of each row, in draw order (the heights, prefix-summed). */
  tops: number[];
  /** Total height of every row together. */
  totalHeight: number;
  /** The global height rows without an offset of their own use. */
  baseHeight: number;
  /** True when no row carries an offset — lets callers take a uniform path. */
  isUniform: boolean;
  /** Row height for a track id; the base height for an id that has no row. */
  heightOf: (trackId: string) => number;
  /** Top edge for a track id; null for an id that has no row. */
  topOf: (trackId: string) => number | null;
  /** Index of the row containing `y`, clamped into the existing rows. */
  rowAt: (y: number) => number;
};

/** Height of a single row: the global height plus the track's own offset,
 * clamped so no row disappears or swallows the viewport. */
export function trackRowHeight(
  baseHeight: number,
  heightOffset?: number | null,
): number {
  const height = Math.round(baseHeight + (heightOffset ?? 0));
  return Math.min(TRACK_HEIGHT_ROW_MAX, Math.max(TRACK_HEIGHT_MIN, height));
}

/**
 * Offset that puts a row at `targetHeight` given the current global height.
 * Returns null when the result is the global height itself, which is how a
 * track is put back on the global height (the model stores no offset then).
 */
export function trackHeightOffsetFor(
  baseHeight: number,
  targetHeight: number,
): number | null {
  const clamped = Math.min(
    TRACK_HEIGHT_ROW_MAX,
    Math.max(TRACK_HEIGHT_MIN, Math.round(targetHeight)),
  );
  const offset = clamped - Math.round(baseHeight);
  return offset === 0 ? null : offset;
}

export function buildTrackRowLayout(
  tracks: readonly TrackRowSource[],
  baseHeight: number,
): TrackRowLayout {
  const safeBaseHeight = Math.max(1, Math.round(baseHeight));
  const heights: number[] = new Array(tracks.length);
  const tops: number[] = new Array(tracks.length);
  const indexById = new Map<string, number>();
  let isUniform = true;
  let cursor = 0;

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const height = trackRowHeight(safeBaseHeight, track.heightOffset);
    if (height !== safeBaseHeight) {
      isUniform = false;
    }
    heights[index] = height;
    tops[index] = cursor;
    indexById.set(track.id, index);
    cursor += height;
  }

  return {
    heights,
    tops,
    totalHeight: cursor,
    baseHeight: safeBaseHeight,
    isUniform,
    heightOf: (trackId) => {
      const index = indexById.get(trackId);
      return index === undefined ? safeBaseHeight : heights[index];
    },
    topOf: (trackId) => {
      const index = indexById.get(trackId);
      return index === undefined ? null : tops[index];
    },
    rowAt: (y) => {
      if (tracks.length === 0) {
        return 0;
      }
      if (y <= 0) {
        return 0;
      }
      // Binary search over the row tops: rows are variable height now, so the
      // old `Math.floor(y / trackHeight)` no longer lands on the right one.
      let low = 0;
      let high = tracks.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (tops[mid] <= y) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return low;
    },
  };
}

/**
 * Rows spanned when a row-based drag moves `fromIndex` by `deltaY` pixels.
 *
 * With uniform rows this was `Math.round(deltaY / trackHeight)`. With variable
 * rows the answer depends on which rows the pointer actually crossed, so it is
 * measured from the dragged row's own centre: the destination is the row whose
 * band contains that centre once moved.
 */
export function trackRowDeltaForDrag(
  layout: TrackRowLayout,
  fromIndex: number,
  deltaY: number,
): number {
  if (layout.isUniform || fromIndex < 0 || fromIndex >= layout.heights.length) {
    return Math.round(deltaY / layout.baseHeight);
  }

  const centre = layout.tops[fromIndex] + layout.heights[fromIndex] / 2;
  return layout.rowAt(centre + deltaY) - fromIndex;
}

export type TrackRowWindow = {
  /** First row included, inclusive. */
  startIndex: number;
  /** Row after the last one included, exclusive. */
  endIndex: number;
};

export type TrackRowWindowMargin = {
  /** Extra pixels above and below the viewport, applied before picking rows. */
  overscanPx?: number;
  /** Extra whole rows above the first row the (overscanned) band touches. */
  rowsBefore?: number;
  /** Extra whole rows below the last row the (overscanned) band touches. */
  rowsAfter?: number;
};

/**
 * Rows a viewport `[scrollTop, scrollTop + viewportHeight)` of the track area
 * touches, plus a margin. THE answer to "which rows can be seen": the canvas
 * culls with it and the DOM rows (`useVisibleTrackRows`) mount with it, so the
 * two can never disagree about where a row is.
 *
 * Works on per-row heights through `rowAt`; never divides by a shared height.
 */
export function visibleTrackWindow(
  layout: TrackRowLayout,
  scrollTop: number,
  viewportHeight: number,
  { overscanPx = 0, rowsBefore = 0, rowsAfter = 0 }: TrackRowWindowMargin = {},
): TrackRowWindow {
  const trackCount = layout.heights.length;
  const safeScrollTop = Math.max(0, scrollTop);
  const safeViewportHeight = Math.max(
    layout.baseHeight,
    viewportHeight || layout.baseHeight,
  );
  const bandTop = safeScrollTop - overscanPx;
  const bandBottom = safeScrollTop + safeViewportHeight + overscanPx;
  const startIndex = clampIndex(layout.rowAt(bandTop) - rowsBefore, 0, trackCount);
  const endIndex = clampIndex(
    layout.rowAt(bandBottom) + 1 + rowsAfter,
    startIndex,
    trackCount,
  );
  return { startIndex, endIndex };
}

/**
 * Heights that stand in for the rows outside `window`, so the content keeps
 * exactly `layout.totalHeight`: `top + Σ heights[start, end) + bottom`.
 */
export function spacersFor(
  layout: TrackRowLayout,
  { startIndex, endIndex }: TrackRowWindow,
): { top: number; bottom: number } {
  const trackCount = layout.heights.length;
  const start = clampIndex(startIndex, 0, trackCount);
  const end = clampIndex(endIndex, start, trackCount);
  const top = start < trackCount ? layout.tops[start] : layout.totalHeight;
  const bottom = end < trackCount ? layout.totalHeight - layout.tops[end] : 0;
  return { top, bottom };
}

function clampIndex(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A layout of `ids.length` rows of exactly `size` px each — no rounding, no
 * clamping. For lists of fixed-size items that are not track rows (the compact
 * mixer's strips) but want the same window and spacer arithmetic.
 */
export function buildUniformRowLayout(ids: readonly string[], size: number): TrackRowLayout {
  const safeSize = size > 0 ? size : 1;
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const heights = ids.map(() => safeSize);
  const tops = ids.map((_, index) => index * safeSize);
  return {
    heights,
    tops,
    totalHeight: ids.length * safeSize,
    baseHeight: safeSize,
    isUniform: true,
    heightOf: () => safeSize,
    topOf: (id) => {
      const index = indexById.get(id);
      return index === undefined ? null : tops[index];
    },
    rowAt: (y) =>
      ids.length === 0 ? 0 : Math.min(ids.length - 1, Math.max(0, Math.floor(y / safeSize))),
  };
}
