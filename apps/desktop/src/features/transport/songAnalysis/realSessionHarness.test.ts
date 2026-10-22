// The review's path (÷2 reading, tempo rows, guide placement) over the
// results `dump_real_session_analysis` (commands/song_analysis.rs) writes for
// a real session, to check a change on real multitracks. Skipped without
// LT_AN_SESSION (the .ltsession) and LT_AN_AUDIO (its results folder):
//
//   LT_AN_SESSION=<file.ltsession> LT_AN_AUDIO=<dir> [LT_AN_ONLY=<n>]
//     npx vitest run realSessionHarness --silent=false
import { readFileSync, existsSync } from "node:fs";

import { it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import {
  bpmFromNames,
  buildApplyPayload,
  markersForLabels,
  placeGuideSections,
  reviewRows,
  startsOnEighths,
  tempoInView,
  tempoLevel,
  DEFAULT_TEMPO_DETAIL,
} from "./songAnalysisPlan";

const audio = process.env.LT_AN_AUDIO;
const sessionFile = process.env.LT_AN_SESSION;

it.skipIf(!audio || !sessionFile)("real session analysis", () => {
  const song = JSON.parse(readFileSync(sessionFile!, "utf8")) as SongView;
  const only = process.env.LT_AN_ONLY;
  for (const [index, region] of song.regions.entries()) {
    if (only && Number(only) !== index) continue;
    const file = `${audio}/${index}_result.json`;
    if (!existsSync(file)) continue;
    const result = JSON.parse(readFileSync(file, "utf8"));
    const click = song.clips.find(
      (clip) =>
        clip.timelineStartSeconds >= region.startSeconds - 0.01 &&
        clip.timelineStartSeconds < region.endSeconds &&
        /click|clic/i.test(song.tracks.find((t) => t.id === clip.trackId)?.name ?? ""),
    );
    const onEighths = startsOnEighths(
      click ? bpmFromNames(song, region.id, click.trackId) : null,
      result.tempo?.analysis.segments[0]?.bpm,
      result.tempo?.asEighths?.analysis.segments[0]?.bpm,
    );
    const reading = (onEighths ? result.tempo.asEighths : null) ?? result.tempo;
    const rows = reviewRows(tempoLevel(reading, DEFAULT_TEMPO_DETAIL).proposal);
    const payload = buildApplyPayload(
      song,
      region.id,
      rows,
      { tempo: true, signature: true },
      result,
    );
    const groups = result.guide.analysis.groups;
    const markers = groups.map((g: { labels: string[]; countedIn: boolean }) =>
      markersForLabels(g.labels, g.countedIn),
    );
    const placed = placeGuideSections(
      song,
      region.id,
      result.renderStartSeconds,
      result.guide.analysis,
      markers,
      payload ? tempoInView(payload, result) : null,
    );
    const rel = (s: number) => (s - region.startSeconds).toFixed(3);
    const lines: string[] = [];
    lines.push(`=== ${index} ${region.name} eighths=${onEighths}`);
    lines.push(
      `segments: ${reading.analysis.segments
        .slice(0, 6)
        .map(
          (s: { startSeconds: number; bpm: number; bars: number }) =>
            `${s.startSeconds.toFixed(3)}@${s.bpm}x${s.bars}`,
        )
        .join(
          " ",
        )}  warnings: ${reading.analysis.warnings.map((w: { kind: string; seconds: number }) => `${w.kind}@${w.seconds.toFixed(2)}`).join(" ")}`,
    );
    for (const row of rows) {
      lines.push(`  row ${row.kind} ${rel(row.startSeconds)} ${row.text}`);
    }
    for (const a of result.guide.analysis.announcements) {
      const g = groups[a.group];
      const words = a.countWords
        .map(
          (w: { number: number; startSeconds: number }) =>
            `${w.number}@${w.startSeconds.toFixed(2)}`,
        )
        .join(",");
      lines.push(
        `  ann ${a.startSeconds.toFixed(2)}-${a.endSeconds.toFixed(2)} g${a.group} [${g.labels.join(",")}] "${g.transcript ?? ""}"${words ? " words " + words : ""}`,
      );
    }
    for (const p of placed) {
      lines.push(
        `  mk ${rel(p.startSeconds)} ${p.kind}${p.variant ? " " + p.variant : ""}${p.categoryOverride ? " (" + p.categoryOverride + ")" : ""}`,
      );
    }
    console.log(lines.join("\n"));
  }
});
