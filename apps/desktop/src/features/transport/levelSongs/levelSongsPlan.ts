import { dbToGain, gainToDb } from "@libretracks/shared/faderScale";
import type { SongLoudness } from "@libretracks/shared/desktopApi";
import type { SongRegionSummary, SongView, TrackSummary } from "@libretracks/shared/models";

import { songIdsByTrack } from "../panels/trackSongGroups";

/**
 * Pure logic behind "Nivelar canciones": which tracks count as "what reaches
 * the PA", and what master each song needs so they all play equally loud.
 *
 * The measurement (commands/level_songs.rs) is the loudness of each song's
 * loud parts with its master at unity. Matching that figure across songs is
 * what saves the engineer riding the faders between songs.
 */

/** Same ceiling as the song master fader (+6 dB). */
export const MAX_SONG_MASTER_GAIN = 2;
/** Peak the levelling never pushes a song past: room under the limiter. */
export const PEAK_CEILING_DBFS = -1;
/** Smaller changes than this are left alone: nobody hears them live. */
export const MIN_CHANGE_DB = 0.5;

export type TrackExclusion = "muted" | "inEarRoute" | "cueName";

export type LevelTrack = {
  id: string;
  name: string;
  color: string | null;
  /** Route after resolving "inherit" through the folders. */
  route: string;
  /** Why it is left out by default; null = it counts. */
  exclusion: TrackExclusion | null;
};

const MAX_FOLDER_DEPTH = 8;

function ancestors(track: TrackSummary, byId: Map<string, TrackSummary>): TrackSummary[] {
  const chain: TrackSummary[] = [];
  let parentId = track.parentTrackId ?? null;
  for (let depth = 0; parentId && depth < MAX_FOLDER_DEPTH; depth += 1) {
    const parent = byId.get(parentId);
    if (!parent) break;
    chain.push(parent);
    parentId = parent.parentTrackId ?? null;
  }
  return chain;
}

/** Where the track's audio goes, with "inherit" resolved like the engine. */
export function effectiveRoute(track: TrackSummary, byId: Map<string, TrackSummary>): string {
  const own = (track.audioTo || "master").trim().toLowerCase();
  if (own !== "inherit") return own;
  for (const parent of ancestors(track, byId)) {
    const route = (parent.audioTo || "master").trim().toLowerCase();
    if (route !== "inherit") return route;
  }
  return "master";
}

/**
 * Tracks that multitracks ship for the band's ears, not the audience: click,
 * cues, guide vocals announcing sections, timecode. Spanish and English, as
 * the stems people buy are named.
 */
const CUE_NAME = /\b(click|clic|clik|metr[oó]nom[oe]?|cues?|guide|gu[ií]a|count[- ]?in|conteo|timecode|smpte|ltc)\b/i;

export function isCueTrackName(name: string): boolean {
  return CUE_NAME.test(name.normalize("NFC"));
}

/**
 * Audio tracks with any clip, and whether each counts by default. A track
 * does NOT count when it is silent now (muted, or outside an active solo),
 * goes to the in-ears (the monitor bus, or an output the click or the voice
 * guide use), or is named like a click/cue stem.
 */
export function levelableTracks(
  song: SongView | null,
  cueRoutes: { metronomeOutput: string; voiceGuideOutput: string },
): LevelTrack[] {
  if (!song) return [];
  const byId = new Map(song.tracks.map((track) => [track.id, track]));
  const withClips = new Set(song.clips.map((clip) => clip.trackId));
  const anySolo = song.tracks.some((track) => track.solo);
  const inEarRoutes = new Set(
    [cueRoutes.metronomeOutput, cueRoutes.voiceGuideOutput]
      .map((route) => route.trim().toLowerCase())
      // The click on the master means there is no separate in-ear output.
      .filter((route) => route && route !== "master"),
  );
  inEarRoutes.add("monitor");

  return song.tracks
    .filter((track) => track.kind === "audio" && withClips.has(track.id))
    .map((track) => {
      const chain = [track, ...ancestors(track, byId)];
      const route = effectiveRoute(track, byId);
      let exclusion: TrackExclusion | null = null;
      if (chain.some((t) => t.muted) || (anySolo && !chain.some((t) => t.solo))) {
        exclusion = "muted";
      } else if (inEarRoutes.has(route)) {
        exclusion = "inEarRoute";
      } else if (chain.some((t) => isCueTrackName(t.name))) {
        exclusion = "cueName";
      }
      return { id: track.id, name: track.name, color: track.color ?? null, route, exclusion };
    });
}

/**
 * - `noClip` (default): the loudest level EVERY song can reach without its
 *   peaks passing the ceiling. On real multitracks the stems summed at unity
 *   already peak near or over 0 dBFS, so boosts are rarely possible and the
 *   median left the quiet songs short (measured: 1.6 LU apart after levelling
 *   vs 0.2 LU with this). Levelling down is free live: the desk gain comes up
 *   once at soundcheck.
 * - `median`: moves the setlist as little as possible.
 * - `song`: match one song the user trusts.
 */
export type LevelTarget =
  | { kind: "noClip" }
  | { kind: "median" }
  | { kind: "song"; regionId: string };

export type SongProposal = {
  regionId: string;
  name: string;
  currentGain: number;
  measurement: SongLoudness | null;
  /** null: nothing to measure in this song, it is left as it is. */
  proposedGain: number | null;
  /** proposed − current, in dB. 0 when there is no proposal. */
  changeDb: number;
  /** The boost was cut short so the song's peaks stay under the ceiling. */
  limitedByPeak: boolean;
  /** The proposal hit the fader's +6 dB ceiling. */
  limitedByFader: boolean;
};

export type LevelPlan = {
  /** Loud-parts loudness every song is brought to, or null if none measured. */
  targetLufs: number | null;
  /** The setlist median, to say how far below it the target sits. */
  medianLufs: number | null;
  songs: SongProposal[];
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The most a song's master can be: up to where its peak meets the ceiling,
 * never below what it has now (a song is not forced down for peaking high
 * already), never past the fader. In dB, relative to unity.
 */
function maxMasterDb(measurement: SongLoudness, currentGain: number): number {
  const room =
    measurement.samplePeak > 0
      ? PEAK_CEILING_DBFS - gainToDb(measurement.samplePeak)
      : Number.POSITIVE_INFINITY;
  return Math.min(gainToDb(MAX_SONG_MASTER_GAIN), Math.max(gainToDb(currentGain), room));
}

/**
 * The master each song needs to sit at the target (see {@link LevelTarget}
 * for how the target is chosen). Boosts stop where a song's peak would pass
 * {@link PEAK_CEILING_DBFS} — but a song never has to come DOWN just because
 * it already peaks high at its current master.
 */
export function planLevels(
  regions: SongRegionSummary[],
  measurements: SongLoudness[],
  target: LevelTarget,
): LevelPlan {
  const byRegion = new Map(measurements.map((m) => [m.regionId, m]));
  const measured = measurements.filter((m) => m.hasSignal);

  const gainOf = (regionId: string) =>
    regions.find((region) => region.id === regionId)?.master?.gain ?? 1;
  const medianLufs = median(measured.map((m) => m.loudLufs));
  let targetLufs: number | null;
  if (target.kind === "song") {
    const reference = byRegion.get(target.regionId);
    targetLufs = reference?.hasSignal ? reference.loudLufs : null;
  } else if (target.kind === "median") {
    targetLufs = medianLufs;
  } else {
    const reachable = measured.map((m) => m.loudLufs + maxMasterDb(m, gainOf(m.regionId)));
    targetLufs = reachable.length > 0 ? Math.min(...reachable) : null;
  }

  const ceiling = dbToGain(PEAK_CEILING_DBFS);
  const songs = regions.flatMap((region): SongProposal[] => {
    const measurement = byRegion.get(region.id);
    if (!measurement) return [];
    const currentGain = region.master?.gain ?? 1;
    const proposal: SongProposal = {
      regionId: region.id,
      name: region.name,
      currentGain,
      measurement,
      proposedGain: null,
      changeDb: 0,
      limitedByPeak: false,
      limitedByFader: false,
    };
    if (!measurement.hasSignal || targetLufs === null) return [proposal];


    let gain = dbToGain(targetLufs - measurement.loudLufs);
    if (gain > currentGain && measurement.samplePeak > 0) {
      const peakRoom = Math.max(currentGain, ceiling / measurement.samplePeak);
      if (gain > peakRoom) {
        gain = peakRoom;
        proposal.limitedByPeak = true;
      }
    }
    if (gain > MAX_SONG_MASTER_GAIN) {
      gain = MAX_SONG_MASTER_GAIN;
      proposal.limitedByFader = true;
      proposal.limitedByPeak = false;
    }
    proposal.proposedGain = gain;
    proposal.changeDb = currentGain > 0 ? gainToDb(gain) - gainToDb(currentGain) : gainToDb(gain);
    return [proposal];
  });

  return { targetLufs, medianLufs, songs };
}

/**
 * Songs worth touching by default: a proposal that changes something audible.
 * A song whose master is at zero was silenced on purpose and stays unticked.
 */
export function defaultSongsToApply(plan: LevelPlan): Set<string> {
  return new Set(
    plan.songs
      .filter(
        (song) =>
          song.proposedGain !== null &&
          song.currentGain > 0 &&
          Math.abs(song.changeDb) >= MIN_CHANGE_DB,
      )
      .map((song) => song.regionId),
  );
}

export type LevelTrackGroup = {
  /** Region id, or "shared" for tracks that sound in several songs. */
  key: string;
  /** null = the shared group. */
  region: SongRegionSummary | null;
  tracks: LevelTrack[];
};

/**
 * The picker's groups: one per song, in timeline order, so ten songs with ten
 * tracks read as ten rows instead of a hundred unnamed ones. A track that
 * sounds in several songs (a session-wide click) goes once, in a "shared"
 * group first, rather than repeated under every song where ticking it in one
 * would silently tick it in all. Tracks outside every song are not measured
 * and not listed.
 */
export function groupLevelTracks(song: SongView | null, tracks: LevelTrack[]): LevelTrackGroup[] {
  if (!song) return [];
  const songsOf = songIdsByTrack(song);
  const shared = tracks.filter((track) => (songsOf.get(track.id)?.length ?? 0) > 1);
  const groups: LevelTrackGroup[] = [];
  if (shared.length > 0) groups.push({ key: "shared", region: null, tracks: shared });
  const regions = [...song.regions].sort((a, b) => a.startSeconds - b.startSeconds);
  for (const region of regions) {
    const own = tracks.filter((track) => {
      const ids = songsOf.get(track.id);
      return ids?.length === 1 && ids[0] === region.id;
    });
    if (own.length > 0) groups.push({ key: region.id, region, tracks: own });
  }
  return groups;
}
