import { browser, $ } from "@wdio/globals";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { rectOf, runInPage } from "../utils/annotate.js";
import { parkOsCursor } from "../utils/osCursor.js";
import { Recorder, type VideoOptions } from "../utils/record.js";
import { L } from "../utils/uiText.js";

/**
 * Not a test — records the DESKTOP scenes of the release video
 * (docs/RELEASE_PROCESS.md step 11a). Rewritten every release for that
 * release's feature; git history keeps the previous ones. This one is 1.14.0:
 * song arrangements, «Vamp entre canciones» and «Fade out y parar».
 *
 *   LT_RELEASEVIDEO=1 LT_TUTORIAL_DIR=marketing/video-1.14.0 LT_SHOTS_SESSION=<COPY of a real session> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/release-video.e2e.ts --mochaOpts.timeout 1800000
 *
 * The session is copied to a temp folder first (applying an arrangement
 * writes to it). Script: scripts/tutorial-video/novedades-1.14.0.es.json; the
 * mobile scenes come from tests/android/release-video/record.ts into the same
 * scenes/ folder, and compose.mjs joins both.
 *
 * Optional LT_TUTORIAL_SCENES=04-montar,06-vamp re-encodes only those scenes
 * (the rest still run, so the app reaches the right state).
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? "marketing/video-1.14.0");
const golden = process.env.LT_SHOTS_SESSION ?? "";
const workDir = path.join(os.tmpdir(), "lt-release-video-session");
const session = golden ? path.join(workDir, path.basename(golden)) : "";
const only = (process.env.LT_TUTORIAL_SCENES ?? "").split(",").filter(Boolean);
const loopback = path.join(repoRoot, "scripts", "tutorial-video", "loopback.py");
// The folder library scene shows a place on disk: a short path with no user
// name in it, like the tutorial (C:\Shows).
const PLACE = "C:\\Shows\\Multitracks";
const PLACE_SONG = "Fiel";
const PLACE_STEMS = ["Bateria.wav", "BajoSnt.wav", "Piano.wav", "Vocales.wav", "Click.wav", "Guia.wav"];
const TITLES = {
  intro: ["Novedades de LibreTracks 1.14.0", "Arreglos, vamp entre canciones, nivelar, biblioteca, MIDI y vídeo en el móvil"],
};

const tour = (id: string) => `[data-lt-tour="${id}"]`;
const W = 1920;
const H = 1080;
let video: VideoOptions;
let viewportW = W;
let viewportH = H;
let durations: Record<string, number> = {};
let scenesDir = "";

async function cdp<T = unknown>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
  const o = browser.options as { hostname?: string; port?: number };
  const url = `http://${o.hostname ?? "127.0.0.1"}:${o.port ?? 4444}/session/${browser.sessionId}/ms/cdp/execute`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, params }),
  });
  const body = (await res.json()) as { value: T };
  if (!res.ok) throw new Error(`cdp ${cmd}: ${JSON.stringify(body)}`);
  return body.value;
}

/** data-guide=<name> on the first visible match whose text contains `text` (or equals it). */
async function tagByText(selector: string, text: string, name: string, exact = false) {
  const ok = await runInPage(
    (sel: string, needle: string, tagName: string, isExact: boolean) => {
      document.querySelectorAll(`[data-guide="${tagName}"]`).forEach((el) => el.removeAttribute("data-guide"));
      const el = Array.from(document.querySelectorAll(sel)).find((e) => {
        const r = e.getBoundingClientRect();
        const label = (e.textContent ?? "").replace(/[▸›]/g, "").trim().toLowerCase();
        return r.width > 0 && r.height > 0 && (isExact ? label === needle.toLowerCase() : label.includes(needle.toLowerCase()));
      });
      if (!el) return false;
      el.setAttribute("data-guide", tagName);
      return true;
    },
    selector,
    text,
    name,
    exact,
  );
  if (!ok) throw new Error(`tagByText: ${selector} "${text}" not visible`);
  return `[data-guide="${name}"]`;
}

async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await browser.executeAsync(
    (c: string, a: Record<string, unknown>, done: (v: unknown) => void) => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      w.__TAURI_INTERNALS__.invoke(c, a).then(done, (e) => done({ __error: String(e) }));
    },
    cmd,
    args,
  )) as T;
}

async function setTimelineView(view: { cameraX?: number; zoomLevel?: number }) {
  await runInPage(
    (v: { cameraX?: number; zoomLevel?: number }) =>
      (window as unknown as { __ltE2E: { setTimelineView: (x: unknown) => void } }).__ltE2E.setTimelineView(v),
    view,
  );
  await browser.pause(800);
}

/**
 * A 16:9 page that fits INSIDE the real window. On a single 1080p monitor the
 * window cannot be 1080 tall (title bar, taskbar), and an emulated viewport
 * larger than the window gets scaled to fit, which puts every WebDriver click
 * a few pixels off; one past the screen edge is lost. Frames are still
 * encoded at 1920x1080 (see VideoOptions).
 */
async function emulate169(): Promise<{ w: number; h: number }> {
  const avail = await runInPage(() => ({ w: window.screen.availWidth, h: window.screen.availHeight }));
  await browser.setWindowRect(0, 0, Math.min(1940, avail.w), Math.min(1140, avail.h));
  await browser.pause(800);
  const real = await runInPage(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const h = Math.min(H, real.h, Math.floor((real.w * 9) / 16));
  const w = Math.round((h * 16) / 9);
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await browser.pause(1500);
  console.log(`[release-video] viewport ${w}x${h} (window ${real.w}x${real.h})`);
  return { w, h };
}

function scene(id: string) {
  const rec = new Recorder(
    cdp,
    id,
    { x: 0, y: 0, w: viewportW, h: viewportH },
    scenesDir,
    { x: viewportW * 0.62, y: viewportH * 0.7 },
    video,
  );
  const record = only.length === 0 || only.includes(id);
  const narration = durations[id] ?? 0;
  console.log(`[release-video] scene ${id}`);
  return {
    rec,
    /** Pads to the narration (plus a breath) and writes the clip. */
    async done() {
      await rec.holdUntil(narration + 0.7);
      if (record) await rec.encode();
    },
  };
}

/** Big centred title over the app. */
async function titleCard(text: string, sub: string) {
  await runInPage(
    (t: string, s: string) => {
      const el = document.createElement("div");
      el.id = "lt-tutorial-title";
      el.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;" +
        "justify-content:center;background:rgba(8,10,12,.82);font-family:Inter,Segoe UI,sans-serif;color:#fff";
      el.innerHTML =
        `<div style="font-size:64px;font-weight:800;letter-spacing:-1px">${t}</div>` +
        `<div style="margin-top:18px;font-size:28px;color:#57f1db">${s}</div>`;
      document.body.appendChild(el);
    },
    text,
    sub,
  );
}

async function removeTitleCard() {
  await runInPage(() => document.getElementById("lt-tutorial-title")?.remove());
}

describe("release video (desktop scenes)", function () {
  before(async function () {
    if (process.env.LT_RELEASEVIDEO !== "1") this.skip();
    if (!golden) throw new Error("LT_SHOTS_SESSION is required");
    durations = JSON.parse(readFileSync(path.join(tutorialDir, "narration", "durations.json"), "utf8"));
    scenesDir = path.join(tutorialDir, "scenes");
    mkdirSync(scenesDir, { recursive: true });
    rmSync(workDir, { recursive: true, force: true });
    cpSync(path.dirname(golden), workDir, { recursive: true });
    // «Organizar por canción» only shows with audio outside any folder: take
    // one song's audio out of its folder in the work copy.
    const libraryFile = path.join(workDir, "library.json");
    const library = JSON.parse(readFileSync(libraryFile, "utf8")) as {
      assets: Array<{ folderPath: string | null }>;
      folders: string[];
    };
    const unfiled = library.folders.find((f) => /^Voy Cantando/.test(f)) ?? library.folders[library.folders.length - 1];
    for (const asset of library.assets) if (asset.folderPath === unfiled) asset.folderPath = null;
    library.folders = library.folders.filter((f) => f !== unfiled);
    writeFileSync(libraryFile, JSON.stringify(library, null, 2));
    // The place for the folder library scene.
    rmSync(PLACE, { recursive: true, force: true });
    mkdirSync(path.join(PLACE, PLACE_SONG), { recursive: true });
    for (const stem of PLACE_STEMS) copyFileSync(path.join(workDir, "audio", stem), path.join(PLACE, PLACE_SONG, stem));
    await AppPage.waitUntilBooted();
    await AppPage.reopenSessionUntil(session, (s) => s.tracks.length >= 5, 180_000);
    await AppPage.resetShell();
    await browser.pause(4000);
    // The session carries a video track: with no projector set up the app
    // offers to configure one. «Ahora no» hides it (in memory only).
    await runInPage(() => {
      const notice = document.querySelector(".lt-video-setup-notice");
      const buttons = notice ? Array.from(notice.querySelectorAll("button")) : [];
      (buttons[buttons.length - 1] as HTMLButtonElement | undefined)?.click();
    });
    await browser.pause(500);
    const vp = await emulate169();
    viewportW = vp.w;
    viewportH = vp.h;
    video = { width: W, height: H, dpr: 2, viewport: vp };
  });

  beforeEach(() => parkOsCursor());

  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      try {
        await browser.saveScreenshot(path.join(tutorialDir, "FAILED.png"));
      } catch {
        /* the session may be gone */
      }
    }
  });

  it("records the scenes", async function () {
    const songBar = ".lt-region-hotspot";
    const regions = async () =>
      [...((await AppPage.songView())?.regions ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
    const first = (await regions())[0];
    if (!first) throw new Error("no song in the session");
    // The vamp setting persists in the app settings: start with it off, so
    // the scene really switches it ON on camera.
    await setTimelineView({ zoomLevel: 1, cameraX: 0 });
    await invoke("seek_transport", { positionSeconds: first.startSeconds });
    await browser.pause(800);

    // 01 — title over the timeline.
    {
      const { rec, done } = scene("01-intro");
      await titleCard(TITLES.intro[0], TITLES.intro[1]);
      await rec.hold(Math.max(3, durations["01-intro"] - 2.2));
      await removeTitleCard();
      await rec.hold(1.5);
      await done();
    }

    // 02 — the sections on the ruler, then right-click the song → Arreglo.
    {
      const { rec, done } = scene("02-abrir");
      const ruler = await rectOf(tour("timeline-ruler"));
      if (!ruler) throw new Error("no ruler");
      await rec.zoomTo({ x: ruler.x, y: ruler.y - 20, w: 1100, h: 240 }, { margin: 30 });
      await rec.hold(2.5);
      // Near the start of the band: at this zoom the song is wider than the
      // page, and its centre is off screen.
      const bar = await rectOf(songBar);
      if (!bar) throw new Error("02-abrir: no song band");
      await rec.rightClick({ x: Math.max(bar.x, 0) + 160, y: bar.y + bar.h / 2 });
      await rec.hold(0.8);
      await rec.click(await tagByText(".lt-context-menu button", L("Arreglo"), "mi-arr", true), 900);
      await rec.zoomOut(700);
      await done();
    }

    // 03 — save the original.
    {
      const { rec, done } = scene("03-original");
      await rec.zoomTo(".lt-structure-panel", { margin: 40, maxZoom: 1.6 });
      await rec.hold(1.5);
      if (await rectOf(".lt-structure-capture-button")) {
        // Below the fold of the panel, under the detected sections.
        await runInPage(() =>
          document.querySelector(".lt-structure-capture-button")?.scrollIntoView({ block: "center", behavior: "smooth" }),
        );
        for (let i = 0; i < 12; i++) await rec.frame(1 / 15);
        await rec.hold(0.8);
        await rec.click(".lt-structure-capture-button", 400);
        await rec.hold(1.2);
      }
      await done();
    }

    // 04 — New, then two more choruses at the end from the palette.
    {
      const { rec, done } = scene("04-montar");
      await rec.click(await tagByText(".lt-structure-toolbar button", L("Nuevo"), "arr-new", true), 900);
      const chorus = await tagByText(".lt-structure-palette .lt-structure-chip", "Coro", "arr-chorus").catch(
        () => tagByText(".lt-structure-palette .lt-structure-chip", "Chorus", "arr-chorus"),
      );
      await rec.hold(1.2);
      await rec.click(chorus, 900);
      await rec.click(chorus, 1200);
      await done();
    }

    // 05 — Apply: the song grows on the timeline and the next ones move.
    {
      const { rec, done } = scene("05-aplicar");
      await rec.click(".lt-structure-footer .is-primary", 1500);
      await rec.zoomOut(700);
      await rec.click(".lt-structure-close", 1200);
      const ruler = await rectOf(tour("timeline-ruler"));
      if (ruler) await rec.zoomTo({ x: ruler.x, y: ruler.y - 20, w: 1300, h: 300 }, { margin: 30 });
      await rec.hold(2.5);
      await rec.zoomOut(700);
      await done();
    }

    // 06 — Live View: «Entre canciones» on, then the end of the first song,
    // where the click keeps going until Play starts the next one.
    {
      const { rec, done } = scene("06-vamp");
      const toggle = ".lt-song-gap-vamp";
      await rec.key("Tab", 900);
      await rec.key("Tab", 1500);
      if (!(await rectOf(toggle))) throw new Error("06-vamp: no «Entre canciones» button");
      if ((await (await $(toggle)).getAttribute("aria-pressed")) === "true") {
        await (await $(toggle)).click();
        await browser.pause(400);
      }
      // The markers, each tinted with its colour, in as many columns as fit.
      await rec.zoomTo(".lt-live-cue-grid", { margin: 30, maxZoom: 1.5 });
      await rec.hold(4);
      await rec.zoomTo(".lt-live-settings", { margin: 60, maxZoom: 1.8 });
      await rec.click(toggle, 1200);
      await rec.zoomOut(600);
      const song = (await regions())[0];
      await invoke("seek_transport", { positionSeconds: Math.max(song.startSeconds, song.endSeconds - 5) });
      await browser.pause(500);
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(10_000, loopback);
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(3500, loopback);
      await rec.click(`button[aria-label="${L("Detener")}"]`, 600);
      // Back off, so the app's settings stay as they were.
      if ((await (await $(toggle)).getAttribute("aria-pressed")) === "true") {
        await (await $(toggle)).click();
        await browser.pause(400);
      }
      await done();
    }

    // 07 — song fades from the corners of the song, then «Fade out y parar».
    // On the SECOND song: the first one carries the arrangement applied in
    // 05, and the arrangement guard turns down edits to it.
    {
      const { rec, done } = scene("07-fade");
      await rec.key("Tab", 1200);
      const song = (await regions())[1] ?? (await regions())[0];
      const length = song.endSeconds - song.startSeconds;
      // The whole song in ~1100 px, with some room before it.
      const zoom = 1100 / (length * 18);
      await setTimelineView({ zoomLevel: zoom, cameraX: Math.max(0, song.startSeconds * zoom * 18 - 160) });
      // The playhead sits on a song's top-left corner, right over the fade-in
      // handle: park it in the middle of the song first.
      await invoke("seek_transport", { positionSeconds: song.startSeconds + length / 2 });
      await browser.pause(600);
      const bandSel = `.lt-region-hotspot[data-region-id="${song.id}"]`;
      const bandBox = await rectOf(bandSel);
      if (!bandBox) throw new Error("07-fade: no band for the second song");
      await browser
        .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
        .move({ x: Math.round(bandBox.x + bandBox.w * 0.35), y: Math.round(bandBox.y + bandBox.h / 2) })
        .down({ button: 0 })
        .up({ button: 0 })
        .perform();
      await browser.pause(700);
      const fadeRuler = await rectOf(tour("timeline-ruler"));
      if (fadeRuler) await rec.zoomTo({ x: fadeRuler.x, y: fadeRuler.y - 30, w: 1400, h: 420 }, { margin: 20 });
      const band = await rectOf(bandSel);
      const inHandle = `${bandSel} .lt-song-fade-handle.is-in`;
      const outHandle = `${bandSel} .lt-song-fade-handle.is-out`;
      if (band && (await rectOf(inHandle)) && (await rectOf(outHandle))) {
        // CDP, not WebDriver actions: the handles capture the pointer, and a
        // captured drag ignores WebDriver's synthetic moves (dragToCdp).
        await rec.dragToCdp({ x: band.x + band.w * 0.16, y: band.y + 4 }, 1300, { from: inHandle });
        await rec.hold(0.6);
        await rec.dragToCdp({ x: band.x + band.w * 0.8, y: band.y + 4 }, 1300, { from: outHandle });
        await rec.hold(0.4);
        // What the drags actually left, against what they showed.
        const after = (await regions()).find((r) => r.id === song.id) as
          | { fadeInSeconds?: number | null; fadeOutSeconds?: number | null }
          | undefined;
        const fadeIn = after?.fadeInSeconds ?? 0;
        const fadeOut = after?.fadeOutSeconds ?? 0;
        console.log(`[release-video] 07-fade: drags left in=${fadeIn.toFixed(1)}s out=${fadeOut.toFixed(1)}s of ${length.toFixed(1)}s`);
        const wantIn = length * 0.16;
        const wantOut = length * 0.2;
        if (Math.abs(fadeIn - wantIn) > length * 0.04 || Math.abs(fadeOut - wantOut) > length * 0.04) {
          const fixed = await invoke<{ __error?: string }>("update_song_region_fades", {
            regionId: song.id,
            fadeInSeconds: wantIn,
            fadeOutSeconds: wantOut,
          });
          console.log(`[release-video] 07-fade: set to in=${wantIn.toFixed(1)}s out=${wantOut.toFixed(1)}s ${fixed?.__error ?? "ok"}`);
        }
        await rec.hold(1.5);
      } else {
        console.log("[release-video] 07-fade: no fade handles on the second song");
      }
      await rec.zoomOut(600);
      await invoke("seek_transport", { positionSeconds: song.startSeconds + (song.endSeconds - song.startSeconds) / 3 });
      await browser.pause(500);
      const fade = `button[aria-label="${L("Fade out y parar")}"]`;
      await rec.zoomTo(".lt-transport-buttons", { margin: 260, maxZoom: 1.8 });
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      await rec.realtimeWithAudio(3500, loopback);
      await rec.click(fade, 100);
      await rec.realtimeWithAudio(6500, loopback);
      await rec.zoomOut(600);
      await done();
    }

    // 08 — Archivo → «Nivelar volumen de canciones…», measure, apply.
    {
      const { rec, done } = scene("08-nivelar");
      await rec.click(`${tour("topbar-file-menu")} .lt-top-menu-trigger`, 800);
      await rec.click(await tagByText(".lt-top-menu-dropdown button", L("Nivelar volumen de canciones"), "mi-level"), 1500);
      await rec.zoomTo(".lt-level-songs-modal", { margin: 30, maxZoom: 1.6 });
      await rec.hold(1.2);
      await rec.click(".lt-level-songs-modal .lt-export-modal-actions .is-primary", 400);
      for (let i = 0; i < 240 && !(await rectOf(".lt-level-songs-table")); i++) await rec.hold(0.5);
      await rec.hold(2.5);
      await rec.click(".lt-level-songs-modal .lt-export-modal-actions .is-primary", 1500);
      await rec.zoomOut(600);
      await done();
      // Escape does not close it: a click on the backdrop, outside the dialog.
      for (let i = 0; i < 3 && (await rectOf(".lt-level-songs-modal")); i++) {
        await browser
          .action("pointer", { id: "guide-mouse", parameters: { pointerType: "mouse" } })
          .move({ x: 24, y: 300 })
          .down({ button: 0 })
          .up({ button: 0 })
          .perform();
        await browser.pause(700);
      }
    }

    // 09 — the folder library: a place on disk, a folder dragged to the end
    // of the set becomes a song.
    {
      const original = await invoke<Record<string, unknown>>("get_settings");
      await invoke("save_settings", { settings: { ...original, libraryMode: "folders", libraryPlaces: [PLACE] } });
      await browser.pause(800);
      const { rec, done } = scene("09-biblioteca");
      await rec.click(tour("side-nav-library"), 1200);
      await rec.zoomTo(".lt-folder-library", { margin: 40, maxZoom: 1.6 });
      // The system folder picker is not filmed: point at the button.
      await rec.moveTo(".lt-folder-library-add", 700);
      await rec.hold(1.2);
      if (!(await rectOf(".lt-folder-library-place[aria-expanded=true]"))) {
        await rec.click(".lt-folder-library-place-toggle", 1200);
      }
      await rec.hold(1);
      await rec.zoomOut(600);
      // Put the end of the set at ~55% of the lanes, with empty timeline after it.
      const all = await regions();
      const last = all[all.length - 1];
      const lanes = await rectOf(".lt-track-layers");
      if (lanes && last) {
        const z = 0.25;
        await setTimelineView({ zoomLevel: z, cameraX: Math.max(0, last.endSeconds * z * 18 - lanes.w * 0.55) });
        const lastBand = await runInPage(() =>
          Math.max(...Array.from(document.querySelectorAll(".lt-region-hotspot")).map((el) => el.getBoundingClientRect().right)),
        );
        const folder = await tagByText(".lt-folder-library-row.is-folder", PLACE_SONG, "place-folder");
        await rec.dragTo({ x: Math.min(lanes.x + lanes.w - 40, lastBand + 80), y: lanes.y + 160 }, 1800, { from: folder });
        await rec.hold(2);
        // The new song's tracks land at the bottom of the track list: scroll
        // down to them so its audio is seen.
        await runInPage(() => {
          const rows = Array.from(document.querySelectorAll<HTMLElement>(".lt-track-header-row"));
          const last = rows[rows.length - 1];
          let scroller: HTMLElement | null = last?.parentElement ?? null;
          while (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) scroller = scroller.parentElement;
          scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
        });
        for (let i = 0; i < 24; i++) await rec.frame(1 / 15);
        await rec.hold(3);
      }
      await done();
    }

    // 10 — the classic library and «Organizar por canción».
    {
      const original = await invoke<Record<string, unknown>>("get_settings");
      await invoke("save_settings", { settings: { ...original, libraryMode: "classic" } });
      await browser.pause(1200);
      const { rec, done } = scene("10-organizar");
      if (!(await rectOf(".lt-library-panel"))) await rec.click(tour("side-nav-library"), 1200);
      await runInPage(() => document.querySelector(".lt-library-root-group")?.scrollIntoView({ block: "center" }));
      await rec.hold(0.6);
      if (await rectOf(".lt-library-organize-button")) {
        await rec.zoomTo(".lt-library-root-group", { margin: 120, maxZoom: 1.6 });
        await rec.hold(1.5);
        await rec.click(".lt-library-organize-button", 2500);
      } else {
        console.log("[release-video] 10-organizar: no unfiled audio, button not shown");
      }
      await rec.zoomOut(600);
      await done();
      if (await rectOf(".lt-library-panel")) {
        await (await $(tour("side-nav-library"))).click();
        await browser.pause(800);
      }
    }

    // 11 — console faders and stereo meters, playing: track headers, then
    // the Compact view's mixer.
    {
      const { rec, done } = scene("11-mezcla");
      const song = (await regions())[0];
      await setTimelineView({ zoomLevel: 1, cameraX: 0 });
      await invoke("seek_transport", { positionSeconds: song.startSeconds + (song.endSeconds - song.startSeconds) / 2 });
      await browser.pause(500);
      await rec.click(`button[aria-label="${L("Reproducir")}"]`, 150);
      const header = await rectOf(".lt-track-header");
      if (header) await rec.zoomTo({ x: 0, y: header.y - 20, w: 700, h: 520 }, { margin: 10, maxZoom: 2 });
      await rec.realtimeWithAudio(4500, loopback);
      await rec.zoomOut(500);
      await rec.key("Tab", 600);
      await rec.zoomTo(".lt-compact-mixer", { margin: 30, maxZoom: 1.6 });
      await rec.realtimeWithAudio(4500, loopback);
      await rec.click(`button[aria-label="${L("Detener")}"]`, 500);
      await rec.zoomOut(500);
      await rec.key("Tab", 400);
      await rec.key("Tab", 900);
      await done();
    }

    // 12 — the new marker kinds: instrument solos and tempo cues.
    {
      const { rec, done } = scene("12-marcas");
      await setTimelineView({ zoomLevel: 1, cameraX: 0 });
      const ruler = await rectOf(tour("timeline-ruler"));
      if (!ruler) throw new Error("12-marcas: no ruler");
      await rec.zoomTo({ x: ruler.x, y: ruler.y - 20, w: 1000, h: 560 }, { margin: 10, maxZoom: 1.8 });
      const plainClick = async (selector: string) => {
        await rec.moveTo(selector, 500);
        await runInPage((sel: string) => (document.querySelector(sel) as HTMLElement | null)?.click(), selector);
        await browser.pause(400);
      };
      for (const group of [L("Secciones"), L("Avisos")]) {
        await rec.rightClick({ x: ruler.x + 330, y: ruler.y + 40 });
        await rec.hold(0.6);
        await plainClick(await tagByText(".lt-context-menu button", L("Crear Marca"), "mi-mark"));
        await rec.hold(0.8);
        await plainClick(await tagByText(".lt-context-menu button", group, "mi-group"));
        await rec.hold(2);
        // The new cues are at the end of a long list: bring them into view.
        const newest = group === L("Avisos") ? L("Sube Tempo") : L("Solo Guitarra");
        await runInPage((needle: string) => {
          const item = Array.from(document.querySelectorAll(".lt-context-menu button")).find((b) =>
            (b.textContent ?? "").includes(needle),
          );
          item?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, newest);
        for (let i = 0; i < 12; i++) await rec.frame(1 / 15);
        await rec.hold(2.5);
        await browser.keys(["Escape"]);
        await browser.pause(300);
        if (await rectOf(".lt-context-menu")) await browser.keys(["Escape"]);
        await rec.hold(0.4);
      }
      await rec.zoomOut(600);
      await done();
    }
  });
});
