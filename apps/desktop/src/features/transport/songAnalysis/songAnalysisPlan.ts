import type {
  ProposedSignatureMarker,
  ProposedTempoMarker,
  SongView,
  TempoProposal,
} from "../desktopApi";

/**
 * Pure helpers of "Analizar canción" (tempo and meter from the click): which
 * track is the click, and what to send to `applySongTempoAnalysis` once the
 * user has reviewed and edited the proposal.
 */

/** The click stem, Spanish and English, as `isCueTrackName` spells it. */
const CLICK_NAME = /\b(click|clic|clik|metr[oó]nom[oe]?)\b/i;

/** Shortest overlap that puts a clip inside a song (see level_songs.rs). */
const MIN_SONG_OVERLAP_SECONDS = 0.01;
/** Same marker position, as the backend compares them. */
const SAME_POSITION_SECONDS = 0.0005;

export type ClickTrackOption = { id: string; name: string; looksLikeClick: boolean };

/**
 * Audio tracks with sound inside the song, click-named first. The first one is
 * preselected only when its name says it is a click: guessing any other track
 * would analyse a guitar as a metronome.
 */
export function clickTrackOptions(
  song: SongView,
  regionId: string,
): { options: ClickTrackOption[]; preselected: string | null } {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return { options: [], preselected: null };
  const sounds = (trackId: string) =>
    song.clips.some(
      (clip) =>
        clip.trackId === trackId &&
        Math.max(clip.timelineStartSeconds, region.startSeconds) + MIN_SONG_OVERLAP_SECONDS <
          Math.min(clip.timelineStartSeconds + clip.durationSeconds, region.endSeconds),
    );
  const options = song.tracks
    .filter((track) => track.kind === "audio" && sounds(track.id))
    .map((track) => ({
      id: track.id,
      name: track.name,
      looksLikeClick: CLICK_NAME.test(track.name),
    }));
  // Stable: click-named first, session order otherwise.
  options.sort((a, b) => Number(b.looksLikeClick) - Number(a.looksLikeClick));
  const preselected = options[0]?.looksLikeClick ? options[0].id : null;
  return { options, preselected };
}

/** "1:05.3", from the song start. */
export function formatSongPosition(secondsFromSongStart: number): string {
  const safe = Math.max(0, secondsFromSongStart);
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function parseBpm(text: string): number | null {
  const value = Number(text.replace(",", ".").trim());
  return Number.isFinite(value) && value >= 20 && value <= 300 ? value : null;
}

export function parseSignature(text: string): string | null {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(text);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (numerator < 1 || ![1, 2, 4, 8, 16, 32].includes(denominator)) return null;
  return `${numerator}/${denominator}`;
}

/** One editable row of the review: a proposed marker and its current text. */
export type ReviewRow =
  | { kind: "tempo"; index: number; startSeconds: number; restoresNextSong: boolean; text: string }
  | {
      kind: "signature";
      index: number;
      startSeconds: number;
      restoresNextSong: boolean;
      text: string;
    };

export function reviewRows(proposal: TempoProposal): ReviewRow[] {
  const rows: ReviewRow[] = [
    ...proposal.tempoMarkers.map((marker, index) => ({
      kind: "tempo" as const,
      index,
      startSeconds: marker.startSeconds,
      restoresNextSong: marker.restoresNextSong,
      text: String(marker.bpm),
    })),
    ...proposal.signatureMarkers.map((marker, index) => ({
      kind: "signature" as const,
      index,
      startSeconds: marker.startSeconds,
      restoresNextSong: marker.restoresNextSong,
      text: marker.signature,
    })),
  ];
  // Tempo before meter at the same spot, the way the ruler reads.
  return rows.sort(
    (a, b) =>
      a.startSeconds - b.startSeconds || (a.kind === b.kind ? 0 : a.kind === "tempo" ? -1 : 1),
  );
}

export function rowIsValid(row: ReviewRow): boolean {
  return row.kind === "tempo" ? parseBpm(row.text) !== null : parseSignature(row.text) !== null;
}

/**
 * What to apply. Applying replaces BOTH kinds of markers inside the song, so
 * the kind the user left out is sent back as the song has it now.
 */
export function buildApplyPayload(
  song: SongView,
  regionId: string,
  rows: ReviewRow[],
  include: { tempo: boolean; signature: boolean },
): { tempoMarkers: ProposedTempoMarker[]; signatureMarkers: ProposedSignatureMarker[] } | null {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return null;
  const inside = (seconds: number) =>
    seconds >= region.startSeconds - SAME_POSITION_SECONDS &&
    seconds < region.endSeconds - SAME_POSITION_SECONDS;

  let tempoMarkers: ProposedTempoMarker[];
  if (include.tempo) {
    tempoMarkers = [];
    for (const row of rows) {
      if (row.kind !== "tempo") continue;
      const bpm = parseBpm(row.text);
      if (bpm === null) return null;
      tempoMarkers.push({
        startSeconds: row.startSeconds,
        bpm,
        restoresNextSong: row.restoresNextSong,
      });
    }
  } else {
    tempoMarkers = song.tempoMarkers
      .filter((marker) => inside(marker.startSeconds))
      .map((marker) => ({
        startSeconds: marker.startSeconds,
        bpm: marker.bpm,
        restoresNextSong: false,
      }));
  }

  let signatureMarkers: ProposedSignatureMarker[];
  if (include.signature) {
    signatureMarkers = [];
    for (const row of rows) {
      if (row.kind !== "signature") continue;
      const signature = parseSignature(row.text);
      if (signature === null) return null;
      signatureMarkers.push({
        startSeconds: row.startSeconds,
        signature,
        restoresNextSong: row.restoresNextSong,
      });
    }
  } else {
    signatureMarkers = song.timeSignatureMarkers
      .filter((marker) => inside(marker.startSeconds))
      .map((marker) => ({
        startSeconds: marker.startSeconds,
        signature: marker.signature,
        restoresNextSong: false,
      }));
  }
  return { tempoMarkers, signatureMarkers };
}
