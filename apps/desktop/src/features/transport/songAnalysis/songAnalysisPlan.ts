import { buildSongTempoRegions } from "@libretracks/shared/models";
import { getBeatDurationSeconds, nextDownbeatAfter } from "@libretracks/shared/timelineMath";

import type {
  GuideAnalysis,
  MarkerCategory,
  MarkerKind,
  ProposedSignatureMarker,
  ProposedTempoMarker,
  SongView,
  TempoProposal,
} from "../desktopApi";
import { isCueTrackName } from "../levelSongs/levelSongsPlan";
import { CUE_KINDS, MARKER_KINDS, markerKindVariants } from "../markerKinds";

/**
 * Pure helpers of "Analizar canción": which track is the click, which tracks
 * carry the harmony the key is read from, and what to send to
 * `applySongAnalysis` once the user has reviewed and edited the proposal.
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

/**
 * Drums and percussion: pitched noise that only blurs the chromagram. A name
 * test, like the click's; the user can tick them back.
 */
const PERCUSSION_NAME =
  /\b(drums?|bater[ií]a|kick|bombo|snare|caja|perc\w*|hi-?hats?|hats?|loops?|toms?|overheads?|oh|cymbals?|platos?|shakers?|pandero\w*|tamb\w*|claps?|room)\b/i;

export type KeyTrackOption = { id: string; name: string; preselected: boolean };

/**
 * Audio tracks with sound inside the song, for the key. Preselected: all but
 * the click, cues, guide and percussion (the folder a track sits in counts,
 * so "Drums / Kick" is out).
 */
export function keyTrackOptions(song: SongView, regionId: string): KeyTrackOption[] {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return [];
  const byId = new Map(song.tracks.map((track) => [track.id, track]));
  const names = (trackId: string) => {
    const chain: string[] = [];
    let current = byId.get(trackId);
    // Bounded like the engine's folder walk.
    for (let depth = 0; current && depth < 8; depth += 1) {
      chain.push(current.name);
      current = current.parentTrackId ? byId.get(current.parentTrackId) : undefined;
    }
    return chain;
  };
  const sounds = (trackId: string) =>
    song.clips.some(
      (clip) =>
        clip.trackId === trackId &&
        Math.max(clip.timelineStartSeconds, region.startSeconds) + MIN_SONG_OVERLAP_SECONDS <
          Math.min(clip.timelineStartSeconds + clip.durationSeconds, region.endSeconds),
    );
  return song.tracks
    .filter((track) => track.kind === "audio" && sounds(track.id))
    .map((track) => {
      const chain = names(track.id);
      const excluded = chain.some(
        (name) => isCueTrackName(name) || CLICK_NAME.test(name) || PERCUSSION_NAME.test(name),
      );
      return { id: track.id, name: track.name, preselected: !excluded };
    });
}

/**
 * No click: the tracks the tempo is estimated from. Everything with sound in
 * the song but the click and the cues; drums are the best of it.
 */
export function musicTempoTrackIds(song: SongView, regionId: string): string[] {
  return keyTrackOptions(song, regionId)
    .filter((option) => {
      const track = song.tracks.find((candidate) => candidate.id === option.id);
      const name = track?.name ?? "";
      return !isCueTrackName(name) && !CLICK_NAME.test(name);
    })
    .map((option) => option.id);
}

/**
 * Every tempo marker's BPM times `factor` (×2 / ÷2 for a tempo estimated at
 * double or half). Values that would leave the app's range stay as they are.
 */
export function scaleTempoRows(rows: ReviewRow[], factor: number): ReviewRow[] {
  return rows.map((row) => {
    if (row.kind !== "tempo" || row.restoresNextSong) return row;
    const bpm = parseBpm(row.text);
    if (bpm === null) return row;
    const scaled = Math.round(bpm * factor * 100) / 100;
    return scaled >= 20 && scaled <= 300 ? { ...row, text: String(scaled) } : row;
  });
}

/** The guide stem: a voice announcing the sections. */
const GUIDE_NAME = /\b(guides?|gu[ií]as?|cues?)\b/i;

/** Audio tracks with sound in the song, the guide-named one preselected. */
export function guideTrackOptions(
  song: SongView,
  regionId: string,
): { options: { id: string; name: string }[]; preselected: string | null } {
  const options = keyTrackOptions(song, regionId).map(({ id, name }) => ({ id, name }));
  const named = options.find((option) => GUIDE_NAME.test(option.name.normalize("NFC")));
  return { options, preselected: named?.id ?? null };
}

/**
 * What a guide group puts on the timeline: a section (`chorus`,
 * `verse:3`, or "" for none), a cue (`drums_in`, or ""), or nothing because
 * it is ignored (a count-in). "Verso 3, entra batería" is both a section and
 * a cue. The cue may be a section kind: "Verso a capella" is the section
 * verse plus a capella in the cue lane, since two sections cannot share a
 * spot. The section may be a cue kind: "Toda la banda" said with a count-in
 * starts a section, so it goes in the section lane.
 */
export type GroupMarkers = { section: string; cue: string; ignored: boolean };

const isSectionKind = (kind: string) => MARKER_KINDS.includes(kind as MarkerKind);
const isCueKind = (kind: string) => CUE_KINDS.includes(kind as MarkerKind);

/** One label (`verse_3`, `drums_in`) as a select value (`verse:3`), if known. */
function labelValue(label: string): { value: string; cue: boolean } | null {
  const match = /^([a-z_]+?)(?:_(\d+))?$/.exec(label);
  if (!match) return null;
  const kind = match[1];
  const variant = match[2] ? Number(match[2]) : null;
  if (isCueKind(kind) && !isSectionKind(kind)) return { value: kind, cue: true };
  if (!isSectionKind(kind)) return null;
  const offered = variant !== null && markerKindVariants(kind as MarkerKind).includes(variant);
  return { value: offered ? `${kind}:${variant}` : kind, cue: false };
}

/** The markers a group's labels name: its first section and its first cue;
 * with a count-in and no section named, the cue is the section. */
export function markersForLabels(labels: string[], countedIn = false): GroupMarkers {
  if (labels.includes("count")) return { section: "", cue: "", ignored: true };
  let section = "";
  let cue = "";
  let extraSection = "";
  for (const label of labels) {
    const value = labelValue(label);
    if (!value) continue;
    if (value.cue && !cue) cue = value.value;
    else if (!value.cue && !section) section = value.value;
    else if (!value.cue && !extraSection) extraSection = value.value;
  }
  if (countedIn && !section && cue) return { section: cue, cue: extraSection, ignored: false };
  // A second section, with no cue named, rides in the cue lane.
  return { section, cue: cue || extraSection, ignored: false };
}

/** Nothing recognised and not ignored: the review asks the user. */
export function isUnrecognised(markers: GroupMarkers | undefined): boolean {
  return !markers || (!markers.ignored && markers.section === "" && markers.cue === "");
}

function parseMarkerValue(value: string): { kind: MarkerKind; variant: number | null } | null {
  if (!value) return null;
  const [kind, variant] = value.split(":");
  return { kind: kind as MarkerKind, variant: variant ? Number(variant) : null };
}

/**
 * The voice speaks in the bar before its section, but the tail of its last
 * word ("…cuatro") can run a few milliseconds past the section's downbeat:
 * measured on a real guide against markers placed by hand. A downbeat this
 * many beats before the end of the announcement still counts as after it.
 */
const ANNOUNCEMENT_TAIL_BEATS = 0.3;

/**
 * Where each announcement's markers go: on the first downbeat after the
 * announcement ends (see `ANNOUNCEMENT_TAIL_BEATS`), or `leadBars - 1` bars
 * later for a guide that speaks two bars ahead. The grid is the song's, or
 * the one the tempo review is about to write when `tempo` is given. Returns
 * rendered-timeline seconds.
 */
export function placeGuideSections(
  song: SongView,
  regionId: string,
  renderStartSeconds: number,
  analysis: GuideAnalysis,
  markers: GroupMarkers[],
  tempo: { tempoMarkers: ProposedTempoMarker[]; signatureMarkers: ProposedSignatureMarker[] } | null,
  leadBars = 1,
): {
  startSeconds: number;
  kind: MarkerKind;
  variant: number | null;
  categoryOverride: MarkerCategory | null;
}[] {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return [];
  let grid = song;
  if (tempo) {
    const inside = (seconds: number) =>
      seconds >= region.startSeconds - SAME_POSITION_SECONDS &&
      seconds < region.endSeconds - SAME_POSITION_SECONDS;
    grid = {
      ...song,
      tempoMarkers: [
        ...song.tempoMarkers.filter((marker) => !inside(marker.startSeconds)),
        ...tempo.tempoMarkers.map((marker, index) => ({
          id: `proposed-tempo-${index}`,
          startSeconds: marker.startSeconds,
          bpm: marker.bpm,
        })),
      ].sort((a, b) => a.startSeconds - b.startSeconds),
      timeSignatureMarkers: [
        ...song.timeSignatureMarkers.filter((marker) => !inside(marker.startSeconds)),
        ...tempo.signatureMarkers.map((marker, index) => ({
          id: `proposed-signature-${index}`,
          startSeconds: marker.startSeconds,
          signature: marker.signature,
        })),
      ].sort((a, b) => a.startSeconds - b.startSeconds),
    };
  }
  const regions = buildSongTempoRegions(grid);
  const beatAt = (seconds: number) => {
    const current =
      regions.find((r) => seconds >= r.startSeconds && seconds < r.endSeconds) ??
      regions[regions.length - 1];
    return current
      ? getBeatDurationSeconds(current.bpm, current.timeSignature)
      : getBeatDurationSeconds(grid.bpm, grid.timeSignature);
  };
  const placed: {
    startSeconds: number;
    kind: MarkerKind;
    variant: number | null;
    categoryOverride: MarkerCategory | null;
  }[] = [];
  const onSpot = (seconds: number) =>
    placed.filter((other) => Math.abs(other.startSeconds - seconds) < SAME_POSITION_SECONDS);
  for (const announcement of analysis.announcements) {
    const group = markers[announcement.group];
    if (!group || group.ignored) continue;
    const end = renderStartSeconds + announcement.endSeconds;
    let startSeconds = nextDownbeatAfter(
      end - ANNOUNCEMENT_TAIL_BEATS * beatAt(end),
      grid.bpm,
      grid.timeSignature,
      regions,
    );
    for (let extra = 1; extra < leadBars; extra += 1) {
      startSeconds = nextDownbeatAfter(
        startSeconds + beatAt(startSeconds) / 2,
        grid.bpm,
        grid.timeSignature,
        regions,
      );
    }
    const slots = [
      { marker: parseMarkerValue(group.section), sectionSlot: true },
      { marker: parseMarkerValue(group.cue), sectionSlot: false },
    ];
    for (const { marker, sectionSlot } of slots) {
      if (!marker) continue;
      const here = onSpot(startSeconds);
      // The same marker twice on one downbeat ("Coro 1." … "Coro 1.") is one.
      if (here.some((other) => other.kind === marker.kind && other.variant === marker.variant)) {
        continue;
      }
      // Two sections cannot share a spot: the later one goes in the cue lane.
      const sectionHere = here.some((other) => inSectionLane(other));
      const categoryOverride: MarkerCategory | null = isSectionKind(marker.kind)
        ? sectionHere
          ? "cue"
          : null
        : sectionSlot && !sectionHere
          ? "section"
          : null;
      placed.push({ startSeconds, ...marker, categoryOverride });
    }
  }
  return placed;
}

function inSectionLane(marker: { kind: string; categoryOverride: MarkerCategory | null }) {
  return marker.categoryOverride
    ? marker.categoryOverride === "section"
    : isSectionKind(marker.kind);
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
