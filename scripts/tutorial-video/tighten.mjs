// Takes the dead air out of a composed tutorial/release video: the stretches
// where nothing is said AND nothing moves (a scene padded to its narration, a
// hold after a click, the wait for something to load). Works on the finished
// MP4, so it can be re-run with other thresholds without recording anything.
//
//   node scripts/tutorial-video/tighten.mjs <in.mp4> <out.mp4> [--min 0.8] [--keep 0.35] [--noise -38]
//
// --min   shortest dead stretch worth cutting, in seconds
// --keep  breathing room left on each side of a cut, in seconds
// --noise level under which the audio counts as silent, in dB
// --tail  seconds at the end that are never cut (the end card stays up)
//
// A stretch is cut only when ffmpeg's silencedetect AND freezedetect agree on
// it: silence alone would cut a scene that is still showing something, and a
// still picture alone would cut a sentence over a static screen. The subtitles
// are burnt in and only show while the voice speaks, so they are never split.
import { execFileSync, spawnSync } from "node:child_process";

const [, , input, output, ...rest] = process.argv;
if (!input || !output) {
  console.error("usage: tighten.mjs <in.mp4> <out.mp4> [--min 0.8] [--keep 0.35] [--noise -38]");
  process.exit(1);
}
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? Number(rest[i + 1]) : fallback;
};
const MIN = opt("min", 0.8);
const KEEP = opt("keep", 0.35);
const NOISE = opt("noise", -38);
const TAIL = opt("tail", 3);
// Cuts shorter than this are not worth the jump they put in the picture.
const MIN_CUT = 0.5;

const duration = Number(
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]).toString(),
);

/** Runs a detection filter and parses its start/end pairs from stderr. */
function detect(args, startKey, endKey) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", input, ...args, "-f", "null", "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ranges = [];
  let start = null;
  for (const line of run.stderr.split(/\r?\n/)) {
    const s = line.match(new RegExp(`${startKey}:\\s*([0-9.]+)`));
    if (s) start = Number(s[1]);
    const e = line.match(new RegExp(`${endKey}:\\s*([0-9.]+)`));
    if (e && start !== null) {
      ranges.push([start, Number(e[1])]);
      start = null;
    }
  }
  if (start !== null) ranges.push([start, duration]);
  return ranges;
}

const silent = detect(["-af", `silencedetect=noise=${NOISE}dB:d=${MIN}`, "-vn"], "silence_start", "silence_end");
const frozen = detect(["-vf", `freezedetect=n=0.003:d=${MIN}`, "-an"], "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end");

// Where both agree, minus the breathing room on each side.
const cuts = [];
for (const [a0, a1] of silent) {
  for (const [b0, b1] of frozen) {
    const s = Math.max(a0, b0) + KEEP;
    const e = Math.min(a1, b1) - KEEP;
    const end = Math.min(e, duration - TAIL);
    if (end - s >= MIN_CUT) cuts.push([s, end]);
  }
}
cuts.sort((x, y) => x[0] - y[0]);

const keep = [];
let cursor = 0;
for (const [s, e] of cuts) {
  if (s > cursor) keep.push([cursor, s]);
  cursor = Math.max(cursor, e);
}
if (cursor < duration) keep.push([cursor, duration]);

const removed = cuts.reduce((sum, [s, e]) => sum + (e - s), 0);
console.log(`${cuts.length} dead stretches, ${removed.toFixed(1)} s out of ${duration.toFixed(1)} s`);
for (const [s, e] of cuts) console.log(`  cut ${s.toFixed(2)} → ${e.toFixed(2)} (${(e - s).toFixed(2)} s)`);

if (!cuts.length) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-c", "copy", output]);
  process.exit(0);
}

const parts = keep
  .map(
    ([s, e], i) =>
      `[0:v]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];` +
      `[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, e - s - 0.02).toFixed(3)}:d=0.02[a${i}]`,
  )
  .join(";");
const inputs = keep.map((_, i) => `[v${i}][a${i}]`).join("");
const filter = `${parts};${inputs}concat=n=${keep.length}:v=1:a=1[v][a]`;
execFileSync(
  "ffmpeg",
  [
    "-y", "-loglevel", "error", "-i", input,
    "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output,
  ],
  { stdio: "inherit", maxBuffer: 64 * 1024 * 1024 },
);
const after = Number(
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output]).toString(),
);
console.log(`→ ${output}: ${after.toFixed(1)} s`);
