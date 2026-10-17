import type { MarkerCategory, MarkerKind, SongView } from "../desktopApi";
import { markerCategory, markerKindCategory } from "../markerKinds";

/** Two markers this close are on the same spot (markers snap to the grid). */
const SAME_SPOT_SECONDS = 0.01;

/**
 * The section marker already on this spot, if any. Two sections cannot share
 * one: the second must go in the cue lane. `exceptId` leaves out the marker
 * being changed.
 */
export function sectionMarkerAt(
  song: SongView | null | undefined,
  seconds: number,
  exceptId?: string,
): SongView["sectionMarkers"][number] | null {
  return (
    song?.sectionMarkers.find(
      (marker) =>
        marker.id !== exceptId &&
        Math.abs(marker.startSeconds - seconds) < SAME_SPOT_SECONDS &&
        markerCategory(marker) === "section",
    ) ?? null
  );
}

/**
 * The lane a marker of `kind` would end up in: the one it already has when
 * it is overridden, the kind's own otherwise (an untyped marker is a section).
 */
export function laneFor(kind: MarkerKind | null, categoryOverride?: MarkerCategory | null) {
  return categoryOverride ?? markerKindCategory(kind ?? "custom");
}
