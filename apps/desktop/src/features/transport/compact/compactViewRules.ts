/**
 * Small, pure rules for the compact view, kept out of TransportPanelContent
 * so they can be tested without mounting the whole panel.
 */

import type { ClipSummary, SongRegionSummary } from "../desktopApi";

type ViewMode = "daw" | "compact" | "live" | (string & {});

/**
 * The compact mixer narrows to the song under the playhead whenever that song
 * changes — on a card click, a song jump, or simply playing past the end of
 * the previous song. Between songs (no active region) nothing changes.
 */
export function shouldNarrowMixerToActiveSong(
  viewMode: ViewMode,
  activeRegionId: string,
): boolean {
  return viewMode === "compact" && activeRegionId !== "";
}

/**
 * The utility toolbar (Vamp, marker jump, song transition, master,
 * transpose…) in the compact view follows its own "Herramientas" button. The
 * waveform is permanent and does not affect it. Other view modes keep their
 * own rule.
 */
export function isCompactUtilityToolbarVisible(
  viewMode: ViewMode,
  toolsOpen: boolean,
): boolean {
  return viewMode === "compact" && toolsOpen;
}

/**
 * The DAW timeline toolbar stays in DAW, stays hidden in Live, and in Compact
 * it follows the Herramientas button. Live is an explicit exclusion: the old
 * `viewMode !== "compact"` test made the toolbar reappear there.
 */
export function isTimelineToolbarVisible(
  viewMode: ViewMode,
  compactEditorOpen: boolean,
): boolean {
  return (
    viewMode !== "live" &&
    (viewMode !== "compact" ||
      isCompactUtilityToolbarVisible(viewMode, compactEditorOpen))
  );
}

/** Real content end used by the compact waveform: the last region or clip,
 * never the DAW workspace tail (which always appends an hour). */
export function computeCompactWaveformDurationSeconds(
  regions: ReadonlyArray<Pick<SongRegionSummary, "endSeconds">>,
  clips: ReadonlyArray<
    Pick<ClipSummary, "timelineStartSeconds" | "durationSeconds">
  >,
  fallbackSeconds = 1,
): number {
  let contentEnd = 0;
  for (const region of regions) {
    if (Number.isFinite(region.endSeconds)) {
      contentEnd = Math.max(contentEnd, region.endSeconds);
    }
  }
  for (const clip of clips) {
    const clipEnd = clip.timelineStartSeconds + clip.durationSeconds;
    if (Number.isFinite(clipEnd)) {
      contentEnd = Math.max(contentEnd, clipEnd);
    }
  }
  if (contentEnd > 0) return contentEnd;
  return Number.isFinite(fallbackSeconds)
    ? Math.max(0.001, fallbackSeconds)
    : 1;
}

/**
 * Compact duration for a SongView. `song.durationSeconds` is the model's real
 * end, so it is a safe fallback when a project has no region or clip yet;
 * `workspaceDurationSeconds` would add the artificial one-hour DAW tail.
 */
export function compactSongDurationSeconds(
  song: {
    regions: ReadonlyArray<Pick<SongRegionSummary, "endSeconds">>;
    clips: ReadonlyArray<
      Pick<ClipSummary, "timelineStartSeconds" | "durationSeconds">
    >;
    durationSeconds: number;
  } | null,
): number {
  if (!song) return 0;
  return computeCompactWaveformDurationSeconds(
    song.regions,
    song.clips,
    song.durationSeconds,
  );
}
