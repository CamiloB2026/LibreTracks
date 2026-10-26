import {
  buildVisibleTimelineGrid,
  getBeatDurationSeconds,
  getCumulativeMusicalPosition,
  type TimelineRegion,
} from "@libretracks/shared/timelineMath";

/** A song span in timeline seconds. Only what the compact grid needs. */
export type CompactGridSong = {
  startSeconds: number;
  endSeconds: number;
};

export type CompactGridMarker = {
  seconds: number;
  barNumber: number;
  beatInBar: number;
  isBarStart: boolean;
};

/** The compact view has always hidden beat lines below this pitch. */
export const MIN_COMPACT_BEAT_PIXELS = 10;

const MUSICAL_POSITION_EPSILON = 1e-9;

function safeBpm(bpm: number): number {
  return Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
}

function safeTimeSignature(timeSignature: string | undefined): string {
  return timeSignature || "4/4";
}

/**
 * Tempo regions clipped to one song and shifted so the song start is local
 * zero. That is what makes bar 1 line up with the song, instead of inheriting
 * a grid anchored to project time zero, while still preserving every tempo or
 * time-signature change inside the song.
 */
export function buildCompactLocalTempoRegions(
  songStartSeconds: number,
  songEndSeconds: number,
  tempoRegions: ReadonlyArray<TimelineRegion>,
  bpm: number,
  timeSignature: string | undefined,
): TimelineRegion[] {
  const start = Math.max(0, songStartSeconds);
  const duration = Math.max(0, songEndSeconds - start);
  if (duration <= 0) return [];

  const localRegions = tempoRegions
    .map((region) => ({
      startSeconds: Math.max(0, region.startSeconds - start),
      endSeconds: Math.min(duration, region.endSeconds - start),
      bpm: region.bpm,
      timeSignature: region.timeSignature,
    }))
    .filter((region) => region.endSeconds > region.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);

  if (localRegions.length > 0) return localRegions;

  return [
    {
      startSeconds: 0,
      endSeconds: duration,
      bpm: safeBpm(bpm),
      timeSignature: safeTimeSignature(timeSignature),
    },
  ];
}

function tempoRegionAtSeconds(
  seconds: number,
  regions: ReadonlyArray<TimelineRegion>,
): TimelineRegion | null {
  return (
    regions.find(
      (region) =>
        seconds >= region.startSeconds && seconds < region.endSeconds,
    ) ??
    [...regions].reverse().find((region) => seconds >= region.endSeconds) ??
    regions[0] ??
    null
  );
}

/**
 * Grid markers for the rolling compact window. Each song gets its own local
 * zero so its first bar starts at the song start; tempo and time-signature
 * changes inside it still come from the shared timeline math. The result is
 * already filtered to the visible window and to the compact beat-line pitch.
 */
export function buildCompactWaveformGrid(params: {
  songs: ReadonlyArray<CompactGridSong>;
  tempoRegions?: ReadonlyArray<TimelineRegion>;
  bpm: number;
  timeSignature?: string;
  viewStartSeconds: number;
  viewEndSeconds: number;
  pixelsPerSecond: number;
}): CompactGridMarker[] {
  const tempoRegions = params.tempoRegions ?? [];
  const baseBpm = safeBpm(params.bpm);
  const baseTimeSignature = safeTimeSignature(params.timeSignature);
  const pixelsPerSecond =
    Number.isFinite(params.pixelsPerSecond) && params.pixelsPerSecond > 0
      ? params.pixelsPerSecond
      : 1;
  const markers: CompactGridMarker[] = [];

  for (const song of params.songs) {
    const songStart = Math.max(0, song.startSeconds);
    const songEnd = Math.max(songStart, song.endSeconds);
    if (songEnd <= songStart) continue;

    const visibleStart = Math.max(songStart, params.viewStartSeconds);
    const visibleEnd = Math.min(songEnd, params.viewEndSeconds);
    if (visibleEnd < visibleStart) continue;

    const localTempoRegions = buildCompactLocalTempoRegions(
      songStart,
      songEnd,
      tempoRegions,
      baseBpm,
      baseTimeSignature,
    );
    if (localTempoRegions.length === 0) continue;

    const grid = buildVisibleTimelineGrid({
      durationSeconds: songEnd - songStart,
      bpm: baseBpm,
      timeSignature: baseTimeSignature,
      regions: localTempoRegions,
      zoomLevel: 1,
      pixelsPerSecond,
      viewportStartSeconds: Math.max(0, visibleStart - songStart),
      viewportEndSeconds: Math.max(0, visibleEnd - songStart),
    });

    for (const marker of grid.markers) {
      const seconds = marker.seconds + songStart;
      if (
        seconds < params.viewStartSeconds - MUSICAL_POSITION_EPSILON ||
        seconds > params.viewEndSeconds + MUSICAL_POSITION_EPSILON
      ) {
        continue;
      }

      if (!marker.isBarStart) {
        const region = tempoRegionAtSeconds(
          marker.seconds,
          localTempoRegions,
        );
        const beatPixels = region
          ? getBeatDurationSeconds(region.bpm, region.timeSignature) *
            pixelsPerSecond
          : 0;
        if (beatPixels < MIN_COMPACT_BEAT_PIXELS) continue;
      }

      markers.push({
        seconds,
        barNumber: marker.barNumber,
        beatInBar: marker.beatInBar,
        isBarStart: marker.isBarStart,
      });
    }
  }

  return markers.sort((left, right) => left.seconds - right.seconds);
}

/**
 * Bar under the playhead, counted from the song start ("C 1" = first bar of
 * that song). Tempo and time-signature changes are resolved through the shared
 * cumulative musical position instead of a fixed 60/bpm bar.
 */
export function compactWaveformBarNumber(params: {
  positionSeconds: number;
  song?: CompactGridSong | null;
  tempoRegions?: ReadonlyArray<TimelineRegion>;
  bpm: number;
  timeSignature?: string;
}): number {
  const baseBpm = safeBpm(params.bpm);
  const baseTimeSignature = safeTimeSignature(params.timeSignature);

  if (!params.song) {
    const position = Math.max(0, params.positionSeconds);
    return getCumulativeMusicalPosition(
      position,
      [...(params.tempoRegions ?? [])],
      baseBpm,
      baseTimeSignature,
    ).barNumber;
  }

  const songStart = Math.max(0, params.song.startSeconds);
  const localPosition = Math.max(0, params.positionSeconds - songStart);
  const localTempoRegions = buildCompactLocalTempoRegions(
    songStart,
    params.song.endSeconds,
    params.tempoRegions ?? [],
    baseBpm,
    baseTimeSignature,
  );
  return getCumulativeMusicalPosition(
    localPosition,
    localTempoRegions,
    baseBpm,
    baseTimeSignature,
  ).barNumber;
}
