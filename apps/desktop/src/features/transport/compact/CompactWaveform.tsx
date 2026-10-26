import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";

import type { TimelineRegion } from "@libretracks/shared/timelineMath";
import type {
  ClipSummary,
  MarkerKind,
  SectionMarkerSummary,
  SongRegionSummary,
  WaveformSummaryDto,
} from "../desktopApi";
import { selectWaveformLod } from "../Renderer/WaveformTileCache";
import { cancelGatedFrame, requestGatedFrame } from "../frameGate";
import { markerColor } from "../markerKinds";
import {
  buildCompactWaveformGrid,
  compactWaveformBarNumber,
} from "./compactWaveformMath";

/**
 * The compact overview is a rolling 60-second window, not a miniature of the
 * whole project. The playhead stays pinned near the left edge and the canvas
 * is redrawn from the shared transport clock, so the wave, its bar grid and
 * its section spans all move by the same real position the audio uses.
 */
export const COMPACT_WAVEFORM_WINDOW_SECONDS = 60;

/** Pixels of already-played audio kept visible left of the playhead, like the
 * reference layout. The DOM playhead reads the same value via a CSS var. */
export const COMPACT_WAVEFORM_PLAYHEAD_X = 16;

/** Resolution of the precomputed mixed envelope, in buckets per second. Fine
 * enough for ~4px bars on any realistic window width, cheap to rebuild. */
const ENVELOPE_BUCKETS_PER_SECOND = 20;

/** Horizontal pitch of one waveform bar, and the share of it that is ink. */
const BAR_PITCH_PX = 3;
const BAR_WIDTH_PX = 2;

/** After manual scrolling (wheel / finger), the view returns to the playhead
 * once the user has left it alone this long. */
export const COMPACT_WAVEFORM_RETURN_DELAY_MS = 5000;

/** A finger must travel this far before a touch becomes a scroll, so a tap on
 * a section still counts as a tap. */
const TOUCH_SCROLL_THRESHOLD_PX = 6;

/** Double-tap on touch screens (Safari does not reliably fire dblclick for
 * taps): the second tap must land this soon and this close to the first. */
export const COMPACT_DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE_PX = 30;

/**
 * Keeps a manually scrolled view inside the project: from the start (minus
 * the playhead lead) up to where the last half window is still content.
 */
export function clampCompactViewStart(
  viewStartSeconds: number,
  totalSeconds: number,
  leadSeconds: number,
  windowSeconds = COMPACT_WAVEFORM_WINDOW_SECONDS,
): number {
  const minStart = -leadSeconds;
  const maxStart = Math.max(minStart, totalSeconds - windowSeconds / 2);
  if (!Number.isFinite(viewStartSeconds)) return minStart;
  return Math.min(maxStart, Math.max(minStart, viewStartSeconds));
}

/** Leftmost x a section tag may take, so it never sits on the "C 12" tag. */
const SECTION_TAG_MIN_X = COMPACT_WAVEFORM_PLAYHEAD_X + 30;

/** Map a song second to an x coordinate inside the rolling window. Exported so
 * the window contract can be tested without a canvas implementation. */
export function compactWaveformX(
  seconds: number,
  viewStartSeconds: number,
  width: number,
  windowSeconds = COMPACT_WAVEFORM_WINDOW_SECONDS,
): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  const span = Math.max(0.001, windowSeconds);
  return ((seconds - viewStartSeconds) / span) * width;
}

/** Inverse of compactWaveformX: the song second under an x coordinate, never
 * negative and never past the real content end. Used to place right-click
 * actions at the clicked time. */
export function compactWaveformSecondsAt(
  x: number,
  viewStartSeconds: number,
  width: number,
  windowSeconds = COMPACT_WAVEFORM_WINDOW_SECONDS,
  durationSeconds = Number.POSITIVE_INFINITY,
): number {
  if (!Number.isFinite(width) || width <= 0) {
    return Math.max(0, Math.min(durationSeconds, viewStartSeconds));
  }
  const seconds =
    viewStartSeconds + (x / width) * Math.max(0, windowSeconds);
  return Math.max(0, Math.min(durationSeconds, seconds));
}

/** Seconds per client pixel of the canvas, corrected for UI zoom. */
function secondsPerClientPx(canvas: HTMLCanvasElement): number {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, canvas.clientWidth);
  const zoom = rect.width > 0 ? canvas.clientWidth / rect.width : 1;
  return (COMPACT_WAVEFORM_WINDOW_SECONDS / width) * zoom;
}

/** Parse a `#rrggbb` marker colour. Custom marker colours are hex in the
 * current model; anything else falls back to white text. */
function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

/** Dark text on light section colours (yellow/green), white on dark ones. */
function readableTextColor(color: string): string {
  const rgb = parseHexColor(color);
  if (!rgb) return "#ffffff";
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? "#101410" : "#ffffff";
}

/** Rounded rect path without relying on CanvasRenderingContext2D.roundRect. */
function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export type CompactWaveformSectionSpan = {
  regionId: string;
  markerId: string;
  startSeconds: number;
  endSeconds: number;
  name: string;
  color: string;
  kind?: MarkerKind;
};

/**
 * Consecutive real section markers inside each real song region. The first
 * span starts at its marker (never before it) and the last one ends at the
 * region end. No decorative or invented span is produced.
 */
export function computeCompactSectionSpans(
  regions: SongRegionSummary[],
  markers: SectionMarkerSummary[],
): CompactWaveformSectionSpan[] {
  const spans: CompactWaveformSectionSpan[] = [];
  for (const region of regions) {
    const regionMarkers = markers
      .filter(
        (marker) =>
          marker.startSeconds >= region.startSeconds &&
          marker.startSeconds < region.endSeconds,
      )
      .sort((left, right) => left.startSeconds - right.startSeconds);
    for (let index = 0; index < regionMarkers.length; index += 1) {
      const marker = regionMarkers[index];
      const nextStart =
        regionMarkers[index + 1]?.startSeconds ?? region.endSeconds;
      const start = Math.max(marker.startSeconds, region.startSeconds);
      const end = Math.min(nextStart, region.endSeconds);
      if (end <= start) continue;
      const span: CompactWaveformSectionSpan = {
        regionId: region.id,
        markerId: marker.id,
        startSeconds: start,
        endSeconds: end,
        name: marker.name,
        color: markerColor(marker),
      };
      if (marker.kind) span.kind = marker.kind;
      spans.push(span);
    }
  }
  return spans;
}

/** Where a section tag was painted, in canvas CSS pixels. */
export type CompactTagHit = {
  markerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Slack around each tag so a small pill is still easy to hit. */
const TAG_HIT_SLOP_PX = 3;

/** Marker whose tag contains (x, y), or null. Later tags win, matching the
 * paint order (a later tag is drawn on top). */
export function hitTestCompactTag(
  hits: ReadonlyArray<CompactTagHit>,
  x: number,
  y: number,
): string | null {
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index];
    if (
      x >= hit.x - TAG_HIT_SLOP_PX &&
      x <= hit.x + hit.width + TAG_HIT_SLOP_PX &&
      y >= hit.y - TAG_HIT_SLOP_PX &&
      y <= hit.y + hit.height + TAG_HIT_SLOP_PX
    ) {
      return hit.markerId;
    }
  }
  return null;
}

/**
 * Short tag painted at the start of a section: a single letter for intros and
 * outros (drawn as a circle), otherwise up to four letters of the marker's own
 * name (drawn as a pill), e.g. "Verso" → "VERS".
 */
export function compactSectionShortLabel(
  name: string,
  kind?: MarkerKind,
): string {
  const letters = name
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
  if (kind === "intro" || kind === "outro") {
    return letters.slice(0, 1) || (kind === "intro" ? "I" : "O");
  }
  return letters.slice(0, 4);
}

/**
 * One mixed loudness envelope for the whole project, sampled at
 * ENVELOPE_BUCKETS_PER_SECOND. Each bucket is the power sum of every clip's
 * peak there (√Σpeak²), normalised so the loudest moment reaches 1. Drawing
 * this instead of overlaying every clip's own wave is what gives the overview
 * readable dynamics: ten overlapping stems otherwise saturate into a slab.
 */
export function computeCompactEnvelope(
  clips: ReadonlyArray<ClipSummary>,
  waveformCache: Record<string, WaveformSummaryDto>,
  durationSeconds: number,
  bucketsPerSecond = ENVELOPE_BUCKETS_PER_SECOND,
): Float32Array {
  const total = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
  const length = Math.max(1, Math.ceil(total * bucketsPerSecond));
  const power = new Float32Array(length);

  for (const clip of clips) {
    if (clip.isMissing) continue;
    const waveform = waveformCache[clip.waveformKey];
    if (!waveform) continue;
    const windowSeconds =
      clip.sourceWindowDurationSeconds ?? clip.durationSeconds;
    if (
      clip.durationSeconds <= 0 ||
      clip.sourceDurationSeconds <= 0 ||
      windowSeconds <= 0
    ) {
      continue;
    }
    const lod = selectWaveformLod(waveform, bucketsPerSecond);
    if (!lod || !lod.maxPeaks.length || !lod.minPeaks.length) continue;
    const peakCount = lod.maxPeaks.length;
    const hasRight =
      lod.maxPeaksRight.length === peakCount &&
      lod.minPeaksRight.length === peakCount;
    const gain = Number.isFinite(clip.gain) ? Math.max(0, clip.gain) : 1;
    const clipStart = clip.timelineStartSeconds;
    const clipEnd = clipStart + clip.durationSeconds;
    const first = Math.max(0, Math.floor(clipStart * bucketsPerSecond));
    const last = Math.min(length, Math.ceil(clipEnd * bucketsPerSecond));
    const peaksPerSourceSecond = peakCount / clip.sourceDurationSeconds;
    const sourcePerTimeline = windowSeconds / clip.durationSeconds;

    for (let bucket = first; bucket < last; bucket += 1) {
      const t0 = Math.max(clipStart, bucket / bucketsPerSecond);
      const t1 = Math.min(clipEnd, (bucket + 1) / bucketsPerSecond);
      if (t1 <= t0) continue;
      const s0 = clip.sourceStartSeconds + (t0 - clipStart) * sourcePerTimeline;
      const s1 = clip.sourceStartSeconds + (t1 - clipStart) * sourcePerTimeline;
      const i0 = Math.max(0, Math.floor(s0 * peaksPerSourceSecond));
      const i1 = Math.min(
        peakCount,
        Math.max(i0 + 1, Math.ceil(s1 * peaksPerSourceSecond)),
      );
      let peak = 0;
      for (let index = i0; index < i1; index += 1) {
        let value = Math.max(
          Math.abs(lod.maxPeaks[index]),
          Math.abs(lod.minPeaks[index]),
        );
        if (hasRight) {
          value = Math.max(
            value,
            Math.abs(lod.maxPeaksRight[index]),
            Math.abs(lod.minPeaksRight[index]),
          );
        }
        if (value > peak) peak = value;
      }
      const scaled = peak * gain;
      power[bucket] += scaled * scaled;
    }
  }

  let loudest = 0;
  for (let index = 0; index < length; index += 1) {
    const amplitude = Math.sqrt(power[index]);
    power[index] = amplitude;
    if (amplitude > loudest) loudest = amplitude;
  }
  if (loudest > 0) {
    for (let index = 0; index < length; index += 1) {
      power[index] /= loudest;
    }
  }
  return power;
}

type CompactWaveformProps = {
  clips: ClipSummary[];
  regions: SongRegionSummary[];
  waveformCache: Record<string, WaveformSummaryDto>;
  durationSeconds: number;
  /** Shared transport visual clock. The compact view never estimates time. */
  positionSecondsRef: MutableRefObject<number>;
  /** Song under the playhead; bar numbers on the playhead tag count from it. */
  activeRegionId?: string | null;
  /** Real section markers from the SongView. No marker is fabricated. */
  sectionMarkers?: SectionMarkerSummary[];
  /** Base tempo/time signature for the beat/bar grid. */
  bpm?: number;
  timeSignature?: string;
  /** Project tempo/time-signature regions from the shared model. */
  tempoRegions?: TimelineRegion[];
  /** Marker with an armed jump; its tag gets a white ring, like the DAW. */
  pendingMarkerId?: string | null;
  /** Click on a section tag. The parent runs the DAW marker action. */
  onMarkerAction?: (markerId: string) => void;
  /** Right-click anywhere on the wave, with the song second under the
   * pointer. The parent opens the DAW ruler menu (create marker, BPM, time
   * signature, automation, clear selection) at that time. */
  onTimelineContextMenu?: (
    event: ReactMouseEvent<HTMLCanvasElement>,
    positionSeconds: number,
  ) => void;
};

/** Compact overview built from the same cached waveform summaries as the DAW. */
export function CompactWaveform({
  clips,
  regions,
  waveformCache,
  durationSeconds,
  positionSecondsRef,
  activeRegionId = null,
  sectionMarkers = [],
  bpm,
  timeSignature,
  tempoRegions = [],
  pendingMarkerId = null,
  onMarkerAction,
  onTimelineContextMenu,
}: CompactWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Tag rectangles from the last paint, for click hit-testing. */
  const tagHitsRef = useRef<CompactTagHit[]>([]);
  /** Window of the last paint, to turn a pointer x back into song time. */
  const lastViewRef = useRef({ viewStart: 0, width: 1 });
  /** View start chosen by wheel / finger scrolling, or null to follow the
   * playhead. Visual only: the transport position is never touched. */
  const manualViewStartRef = useRef<number | null>(null);
  const returnTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const touchScrollRef = useRef<{
    pointerId: number;
    startX: number;
    lastX: number;
    scrolling: boolean;
  } | null>(null);
  /** Last finger tap (not a scroll), for double-tap detection. */
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(
    null,
  );
  /** When a double-tap fired, so a dblclick the browser may also synthesise
   * for the same taps does not trigger the section a second time. */
  const lastTouchActivationRef = useRef(0);
  const visualRef = useRef<HTMLDivElement>(null);

  const { t } = useTranslation();
  const barTagPrefix = t("compactView.barTag", { defaultValue: "C" });
  const sectionSpans = useMemo(
    () => computeCompactSectionSpans(regions, sectionMarkers),
    [regions, sectionMarkers],
  );
  const envelope = useMemo(
    () => computeCompactEnvelope(clips, waveformCache, durationSeconds),
    [clips, durationSeconds, waveformCache],
  );

  const drawAt = useCallback(
    (positionSeconds: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const ratio = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const tagHits: CompactTagHit[] = [];
      tagHitsRef.current = tagHits;
      context.fillStyle = "#121212";
      context.fillRect(0, 0, width, height);

      const total = Math.max(0.001, durationSeconds);
      const windowSeconds = COMPACT_WAVEFORM_WINDOW_SECONDS;
      const position = Math.max(0, Math.min(positionSeconds, total));
      const leadSeconds = (COMPACT_WAVEFORM_PLAYHEAD_X / width) * windowSeconds;
      const manualStart = manualViewStartRef.current;
      const viewStart =
        manualStart === null
          ? position - leadSeconds
          : clampCompactViewStart(manualStart, total, leadSeconds, windowSeconds);
      if (manualStart !== null) manualViewStartRef.current = viewStart;
      const viewEnd = viewStart + windowSeconds;
      lastViewRef.current = { viewStart, width };
      const xFor = (seconds: number) =>
        compactWaveformX(seconds, viewStart, width, windowSeconds);

      // Song regions read as a lighter grey slab; section colours then sit on
      // top. Space outside every song stays the darkest tone.
      for (const region of regions) {
        const left = Math.max(0, xFor(region.startSeconds));
        const right = Math.min(width, xFor(region.endSeconds));
        if (right <= left) continue;
        context.fillStyle = "#222222";
        context.fillRect(left, 0, right - left, height);
      }

      // Real section spans across the full height. Their bounds come from the
      // markers, never from a decorative block.
      for (const span of sectionSpans) {
        const left = Math.max(0, xFor(span.startSeconds));
        const right = Math.min(width, xFor(span.endSeconds));
        if (right <= left) continue;
        context.fillStyle = "#121212";
        context.fillRect(left, 0, right - left, height);
        context.globalAlpha = 0.34;
        context.fillStyle = span.color;
        context.fillRect(left, 0, right - left, height);
        context.globalAlpha = 1;
        // The whole coloured area is clickable, not just its small tag. Tags
        // are pushed later, so where they overlap the tag still wins.
        if (onMarkerAction) {
          tagHits.push({
            markerId: span.markerId,
            x: left,
            y: 0,
            width: right - left,
            height,
          });
        }
      }

      // Musical grid, only inside songs and only for lines in this window.
      // Shared timeline math resolves 6/8, 2/2 and tempo/time-signature
      // changes; anchoring each song to local zero keeps bar 1 on its start.
      const safeBpm =
        Number.isFinite(bpm) && (bpm ?? 0) > 0 ? (bpm as number) : 120;
      const safeTimeSignature = timeSignature || "4/4";
      const gridMarkers = buildCompactWaveformGrid({
        songs: regions,
        tempoRegions,
        bpm: safeBpm,
        timeSignature: safeTimeSignature,
        viewStartSeconds: viewStart,
        viewEndSeconds: viewEnd,
        pixelsPerSecond: width / windowSeconds,
      });
      for (const marker of gridMarkers) {
        const x = Math.round(xFor(marker.seconds)) + 0.5;
        if (x < 0 || x > width) continue;
        context.strokeStyle = marker.isBarStart
          ? "rgba(255, 255, 255, 0.11)"
          : "rgba(255, 255, 255, 0.05)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }

      // Centre line, then the mixed envelope as discrete bars. Bars are
      // anchored to song time (not to screen pixels) so they glide with the
      // transport instead of shimmering as the window scrolls.
      const centerY = Math.round(height * 0.5);
      const maxHalf = height * 0.42;
      context.fillStyle = "rgba(255, 255, 255, 0.16)";
      context.fillRect(0, centerY, width, 1);

      const barSecondsSpan = (BAR_PITCH_PX / width) * windowSeconds;
      const firstBar = Math.floor(Math.max(0, viewStart) / barSecondsSpan);
      const lastBar = Math.ceil(Math.min(total, viewEnd) / barSecondsSpan);
      context.fillStyle = "rgba(236, 231, 212, 0.9)";
      for (let index = firstBar; index < lastBar; index += 1) {
        const startSeconds = index * barSecondsSpan;
        const b0 = Math.floor(startSeconds * ENVELOPE_BUCKETS_PER_SECOND);
        const b1 = Math.max(
          b0 + 1,
          Math.ceil((startSeconds + barSecondsSpan) * ENVELOPE_BUCKETS_PER_SECOND),
        );
        let amplitude = 0;
        for (let bucket = b0; bucket < b1 && bucket < envelope.length; bucket += 1) {
          if (envelope[bucket] > amplitude) amplitude = envelope[bucket];
        }
        if (amplitude <= 0.004) continue;
        const half = Math.max(1, Math.pow(amplitude, 1.35) * maxHalf);
        const x = xFor(startSeconds);
        if (x + BAR_WIDTH_PX < 0 || x > width) continue;
        context.fillRect(
          Math.round(x),
          Math.round(centerY - half),
          BAR_WIDTH_PX,
          Math.max(1, Math.round(half * 2)),
        );
      }

      // Section boundaries: cyan edge with a small "↔" handle at mid height,
      // then the section tag (circle for one letter, pill otherwise).
      const accent = "#22d3ee";
      for (const span of sectionSpans) {
        const left = xFor(span.startSeconds);
        const right = Math.min(width, xFor(span.endSeconds));
        if (right <= 0 || left > width) continue;
        if (left >= 0) {
          const lineX = Math.round(left);
          context.fillStyle = accent;
          context.fillRect(lineX - 1, 0, 2, height);
          const handleW = 12;
          const handleH = 18;
          const handleX = lineX - handleW / 2;
          const handleY = Math.round(height / 2 - handleH / 2);
          roundedRectPath(context, handleX, handleY, handleW, handleH, 3);
          context.fillStyle = "#0c1f24";
          context.fill();
          context.strokeStyle = accent;
          context.lineWidth = 1;
          context.stroke();
          context.fillStyle = "#e6fbff";
          context.font = "700 9px 'Space Grotesk', sans-serif";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText("↔", lineX, handleY + handleH / 2 + 0.5);
        }

        const label = compactSectionShortLabel(span.name, span.kind);
        if (!label) continue;
        // A section that began before the window keeps its tag visible, but
        // clear of the playhead's bar tag at the top-left corner.
        const tagX =
          left + 6 >= SECTION_TAG_MIN_X ? left + 6 : SECTION_TAG_MIN_X;
        const tagY = 8;
        const tagH = 18;
        context.font = "800 9px 'Space Grotesk', sans-serif";
        const textWidth = context.measureText(label).width;
        const tagW = label.length === 1 ? tagH : Math.ceil(textWidth + 16);
        // Keep the tag inside its own section; skip it when the span is
        // too narrow (or has scrolled almost out) rather than overflowing.
        if (tagX + tagW > right - 4) continue;
        roundedRectPath(context, tagX, tagY, tagW, tagH, tagH / 2);
        context.fillStyle = span.color;
        context.fill();
        context.fillStyle = readableTextColor(span.color);
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(label, tagX + tagW / 2, tagY + tagH / 2 + 0.5);
        if (span.markerId === pendingMarkerId) {
          roundedRectPath(context, tagX - 2, tagY - 2, tagW + 4, tagH + 4, tagH / 2 + 2);
          context.strokeStyle = "#ffffff";
          context.lineWidth = 1.5;
          context.stroke();
        }
        if (onMarkerAction) {
          tagHits.push({ markerId: span.markerId, x: tagX, y: tagY, width: tagW, height: tagH });
        }
      }

      // Playhead tag: the bar the transport is in, counted from the start of
      // the song under it ("C 1" = compás 1). The line itself is a DOM node.
      const activeRegion =
        regions.find((region) => region.id === activeRegionId) ??
        regions.find(
          (region) =>
            position >= region.startSeconds && position < region.endSeconds,
        ) ??
        null;
      const barNumber = compactWaveformBarNumber({
        positionSeconds: position,
        song: activeRegion,
        tempoRegions,
        bpm: safeBpm,
        timeSignature: safeTimeSignature,
      });
      const tag = `${barTagPrefix} ${barNumber}`;
      context.font = "800 9px 'Space Grotesk', sans-serif";
      const tagWidth = Math.ceil(context.measureText(tag).width + 10);
      // The playhead line and its tag never move, even while the wave is
      // scrolled by wheel or finger (Playback-style): the wave slides under
      // them and the tag keeps showing the bar actually playing.
      const tagLeft = Math.max(
        2,
        COMPACT_WAVEFORM_PLAYHEAD_X - Math.round(tagWidth / 2),
      );
      roundedRectPath(context, tagLeft, 2, tagWidth, 13, 2);
      context.fillStyle = accent;
      context.fill();
      context.fillStyle = "#04161a";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(tag, tagLeft + tagWidth / 2, 9);
      context.textAlign = "left";
    },
    [
      activeRegionId,
      barTagPrefix,
      bpm,
      durationSeconds,
      envelope,
      onMarkerAction,
      pendingMarkerId,
      regions,
      sectionSpans,
      tempoRegions,
      timeSignature,
    ],
  );

  // Keep the latest draw function reachable from the transport loop without
  // restarting that loop every time a clip or marker list changes.
  const drawAtRef = useRef(drawAt);
  drawAtRef.current = drawAt;

  useEffect(() => {
    const redraw = () => drawAtRef.current(positionSecondsRef.current);
    redraw();
    const visual = visualRef.current;
    if (!visual || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(redraw);
    observer.observe(visual);
    return () => observer.disconnect();
  }, [positionSecondsRef]);

  // Props such as clips/markers can change while the transport is paused;
  // repaint immediately instead of waiting for the next movement tick.
  useEffect(() => {
    drawAtRef.current(positionSecondsRef.current);
  }, [drawAt, positionSecondsRef]);

  useEffect(() => {
    let animationFrameId = 0;
    let lastDrawnStart = Number.NaN;
    const tick = () => {
      const total = Math.max(0.001, durationSeconds);
      const start = Math.max(0, Math.min(positionSecondsRef.current, total));
      const width = visualRef.current?.clientWidth ?? 0;
      const pixelsPerSecond =
        width > 0 ? width / COMPACT_WAVEFORM_WINDOW_SECONDS : 0;
      const movedEnough =
        !Number.isFinite(lastDrawnStart) ||
        Math.abs(start - lastDrawnStart) * pixelsPerSecond >= 0.5;
      if (movedEnough) {
        drawAtRef.current(start);
        lastDrawnStart = start;
      }
      animationFrameId = requestGatedFrame(tick);
    };
    animationFrameId = requestGatedFrame(tick);
    return () => cancelGatedFrame(animationFrameId);
  }, [durationSeconds, positionSecondsRef]);

  // Manual horizontal scrolling (visual only): mouse wheel on PC, one-finger
  // swipe on touch screens. Each interaction restarts a 5 s countdown; when it
  // runs out the view returns to the playhead and follows it again. Playback
  // and the transport position are never touched.
  const setFollowing = (following: boolean) => {
    if (panelRef.current) {
      panelRef.current.dataset.following = following ? "true" : "false";
    }
  };
  const cancelReturn = () => {
    if (returnTimerRef.current !== null) {
      window.clearTimeout(returnTimerRef.current);
      returnTimerRef.current = null;
    }
  };
  const scheduleReturn = () => {
    cancelReturn();
    returnTimerRef.current = window.setTimeout(() => {
      returnTimerRef.current = null;
      manualViewStartRef.current = null;
      setFollowing(true);
      drawAtRef.current(positionSecondsRef.current);
    }, COMPACT_WAVEFORM_RETURN_DELAY_MS);
  };
  const scrollViewBy = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds === 0) return;
    const from = manualViewStartRef.current ?? lastViewRef.current.viewStart;
    manualViewStartRef.current = from + seconds;
    setFollowing(false);
    drawAtRef.current(positionSecondsRef.current);
  };
  const interactionRef = useRef({ scrollViewBy, scheduleReturn, cancelReturn });
  interactionRef.current = { scrollViewBy, scheduleReturn, cancelReturn };

  // Wheel: native listener because React registers wheel as passive, and the
  // page must not scroll while the pointer is over the waveform.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      const pixels =
        event.deltaMode === 1
          ? delta * 16
          : event.deltaMode === 2
            ? delta * 400
            : delta;
      interactionRef.current.scrollViewBy(pixels * secondsPerClientPx(canvas));
      interactionRef.current.scheduleReturn();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      interactionRef.current.cancelReturn();
    };
  }, []);

  // One-finger swipe (touch / pen only: a mouse never drags the wave).
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return;
    touchScrollRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      scrolling: false,
    };
    cancelReturn();
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const touch = touchScrollRef.current;
    if (!touch || touch.pointerId !== event.pointerId) return;
    if (
      !touch.scrolling &&
      Math.abs(event.clientX - touch.startX) >= TOUCH_SCROLL_THRESHOLD_PX
    ) {
      touch.scrolling = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (!touch.scrolling) return;
    // Content follows the finger: dragging left reveals what comes later.
    scrollViewBy(
      (touch.lastX - event.clientX) * secondsPerClientPx(event.currentTarget),
    );
    touch.lastX = event.clientX;
  };
  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const touch = touchScrollRef.current;
    if (!touch || touch.pointerId !== event.pointerId) return;
    touchScrollRef.current = null;
    if (manualViewStartRef.current !== null) scheduleReturn();
    if (touch.scrolling) {
      // A swipe never counts as a tap.
      lastTapRef.current = null;
      return;
    }
    const now = event.timeStamp || Date.now();
    const previous = lastTapRef.current;
    if (
      previous &&
      now - previous.time <= COMPACT_DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <=
        DOUBLE_TAP_DISTANCE_PX
    ) {
      lastTapRef.current = null;
      lastTouchActivationRef.current = Date.now();
      activateSectionAt(event);
      return;
    }
    lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
  };

  // Canvas-space point of a pointer event. clientWidth / rect.width undoes any
  // UI zoom, so hit-testing matches the paint at every zoom level.
  const pointFromEvent = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (event.clientX - rect.left) * (canvas.clientWidth / rect.width),
      y: (event.clientY - rect.top) * (canvas.clientHeight / rect.height),
    };
  };
  // Sections are activated with a double click (mouse) or a double tap
  // (touch); a single click or tap does nothing.
  function activateSectionAt(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (!onMarkerAction) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const markerId = hitTestCompactTag(tagHitsRef.current, point.x, point.y);
    if (markerId) onMarkerAction(markerId);
  }
  const handleCanvasDoubleClick = (
    event: ReactMouseEvent<HTMLCanvasElement>,
  ) => {
    if (Date.now() - lastTouchActivationRef.current < 600) return;
    activateSectionAt(event);
  };
  const handleCanvasContextMenu = (
    event: ReactMouseEvent<HTMLCanvasElement>,
  ) => {
    if (!onTimelineContextMenu) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const { viewStart, width } = lastViewRef.current;
    onTimelineContextMenu(
      event,
      compactWaveformSecondsAt(
        point.x,
        viewStart,
        width,
        COMPACT_WAVEFORM_WINDOW_SECONDS,
        durationSeconds,
      ),
    );
  };
  const handleCanvasMove = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event);
    const overTag =
      point !== null &&
      hitTestCompactTag(tagHitsRef.current, point.x, point.y) !== null;
    event.currentTarget.style.cursor = overTag ? "pointer" : "";
  };

  return (
    <div
      ref={panelRef}
      className="lt-compact-waveform-panel"
      data-following="true"
    >
      <div
        ref={visualRef}
        className="lt-compact-waveform-visual"
        style={
          {
            "--lt-compact-playhead-x": `${COMPACT_WAVEFORM_PLAYHEAD_X}px`,
          } as CSSProperties
        }
      >
        <canvas
          ref={canvasRef}
          onDoubleClick={handleCanvasDoubleClick}
          onContextMenu={handleCanvasContextMenu}
          onMouseMove={handleCanvasMove}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          aria-label={t("compactView.waveformAria", {
            defaultValue: "Forma de onda del proyecto",
          })}
        />
        <div className="lt-compact-waveform-playhead" aria-hidden="true" />
      </div>
    </div>
  );
}
