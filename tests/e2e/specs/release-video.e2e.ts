import { browser, $ } from "@wdio/globals";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
 * release's feature; git history keeps the previous ones. This one is 1.15.0:
 * lyrics and chords in the Live View, «Analizar canción», key changes, tempo
 * ramps and song tempo, the count-in style and selecting several markers.
 *
 *   LT_RELEASEVIDEO=1 LT_TUTORIAL_DIR=marketing/video-1.15.0 LT_SHOTS_SESSION=<COPY of a real session> \
 *     npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/release-video.e2e.ts --mochaOpts.timeout 1800000
 *
 * The session is copied to a temp folder first (applying the analysis
 * writes to it); it must be TestMultiplesAnalisis, with lyrics on «Eres
 * Todopoderoso». Script: scripts/tutorial-video/novedades-1.15.0.es.json.
 * 1.15.0 has no phone recording (a debug APK with Whisper cannot be built on
 * Windows): the mobile scene is a title card recorded here.
 *
 * Optional LT_TUTORIAL_SCENES=04-montar,06-vamp re-encodes only those scenes
 * (the rest still run, so the app reaches the right state).
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tutorialDir = path.resolve(process.env.LT_TUTORIAL_DIR ?? "marketing/video-1.15.0");
const golden = process.env.LT_SHOTS_SESSION ?? "";
const workDir = path.join(os.tmpdir(), "lt-release-video-session");
const session = golden ? path.join(workDir, path.basename(golden)) : "";
const only = (process.env.LT_TUTORIAL_SCENES ?? "").split(",").filter(Boolean);
const loopback = path.join(repoRoot, "scripts", "tutorial-video", "loopback.py");
const TITLES = {
  intro: ["Novedades de LibreTracks 1.15.0", "Letra y acordes, Analizar canción, cambios de nota y rampas de tempo"],
  mobile: ["También en el móvil", "Android e iOS · Seleccionar por área"],
  end: ["LibreTracks 1.15.0", "Gratis en libretracks.com"],
  fixes: "Y además, correcciones",
};
/** The fixes card: the user-visible fixes of the release, shown, not narrated one by one. */
const FIXES = [
  "Las cues y los clips en la marca de destino de un salto ya no se saltan",
  "El click ya no suena doble donde empieza un tempo nuevo",
  "Partir una canción con warp corta justo en el cursor",
  "Los WAV en un disco duro mecánico ya no petardean",
  "Los audios que faltan se pueden quitar de la sesión",
  "En iPhone y iPad el tono es correcto aunque el iPhone trabaje a otra frecuencia",
  "Ctrl + rueda fuera del timeline ya no hace zoom de toda la app",
];
// The speech recognition model, set aside while recording so the analysis
// scene shows its download notice, and put back afterwards.
const speechModel = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "com.libretracks.desktop",
  "models",
  "ggml-base-q5_1.bin",
);
const speechModelAside = `${speechModel}.release-video`;

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

/** A title over a list (the release's fixes). */
async function listCard(title: string, items: string[]) {
  await runInPage(
    (t: string, list: string[]) => {
      const el = document.createElement("div");
      el.id = "lt-tutorial-title";
      el.style.cssText =
        "position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;" +
        "justify-content:center;background:rgba(8,10,12,.9);font-family:Inter,Segoe UI,sans-serif;color:#fff";
      const rows = list
        .map(
          (item) =>
            `<li style="margin:10px 0;padding-left:34px;position:relative">` +
            `<span style="position:absolute;left:0;color:#57f1db">✓</span>${item}</li>`,
        )
        .join("");
      el.innerHTML =
        `<div style="font-size:52px;font-weight:800;letter-spacing:-1px;margin-bottom:28px">${t}</div>` +
        `<ul style="list-style:none;margin:0;padding:0;font-size:26px;max-width:1300px">${rows}</ul>`;
      document.body.appendChild(el);
    },
    title,
    items,
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
    if (existsSync(speechModel)) renameSync(speechModel, speechModelAside);
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

  after(() => {
    // The scene downloads the model again; if it did not finish, put the
    // original back.
    if (!existsSync(speechModelAside)) return;
    if (existsSync(speechModel)) rmSync(speechModelAside);
    else renameSync(speechModelAside, speechModel);
  });

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
    const regions = async () =>
      [...((await AppPage.songView())?.regions ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
    const all = await regions();
    // The shots session (TestMultiplesAnalisis) has lyrics, a key change and
    // analysed markers on «Eres Todopoderoso».
    const song = all.find((r) => /todopoderoso/i.test(r.name)) ?? all[1];
    const bare = all.find((r) => r.id !== song?.id && !/todopoderoso/i.test(r.name));
    if (!song || !bare) throw new Error("the session needs the lyrics song and another one");
    const length = song.endSeconds - song.startSeconds;
    const zoom = 1400 / (length * 18);
    const fitSong = () => setTimelineView({ zoomLevel: zoom, cameraX: Math.max(0, song.startSeconds * zoom * 18 - 160) });
    /** The song band with most of its width on the page. */
    const songBand = async () => {
      await runInPage(() => {
        document.querySelectorAll('[data-guide="rv-song"]').forEach((el) => el.removeAttribute("data-guide"));
        const best = Array.from(document.querySelectorAll(".lt-region-hotspot"))
          .map((e) => {
            const r = e.getBoundingClientRect();
            return { e, seen: r.height > 0 ? Math.min(r.right, window.innerWidth) - Math.max(r.left, 0) : 0 };
          })
          .filter(({ seen }) => seen > 0)
          .sort((a, b) => b.seen - a.seen)[0];
        best?.e.setAttribute("data-guide", "rv-song");
      });
      const box = await rectOf('[data-guide="rv-song"]');
      if (!box) throw new Error("no song band");
      return box;
    };
    /** Clickable (not under the track headers) matches of `selector`, in ruler order, `gap` px apart. */
    const onRuler = async (selector: string, gap: number) =>
      (await runInPage(
        (sel: string, minGap: number) => {
          const picked: Array<{ x: number; y: number }> = [];
          let lastX = -Infinity;
          Array.from(document.querySelectorAll(sel))
            .map((e) => ({ e, r: e.getBoundingClientRect() }))
            .filter(({ e, r }) => {
              if (!(r.width > 0 && r.left >= 40 && r.right <= window.innerWidth - 40)) return false;
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return top === e || e.contains(top);
            })
            .sort((a, b) => a.r.left - b.r.left)
            .forEach(({ r }) => {
              if (r.left - lastX < minGap) return;
              picked.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
              lastX = r.left;
            });
          return picked;
        },
        selector,
        gap,
      )) as Array<{ x: number; y: number }>;
    const play = `.lt-transport-buttons button[aria-label="${L("Reproducir")}"]`;
    const viewBtn = (n: number) => `${tour("view-mode-switcher")} button:nth-of-type(${n})`;

    await fitSong();
    await invoke("seek_transport", { positionSeconds: song.startSeconds + 60 });
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

    // 02 — Live View, the Lyrics button, and the lyrics following the song.
    {
      const { rec, done } = scene("02-letra");
      await invoke("seek_transport", { positionSeconds: song.startSeconds + 28 });
      await rec.click(viewBtn(3), 1800);
      // Start with the lyrics hidden so the button really opens them.
      if (await rectOf(".lt-live-chart")) {
        await (await $(".lt-live-chart-toggle")).click();
        await browser.pause(600);
      }
      await rec.hold(0.8);
      await rec.click(".lt-live-chart-toggle", 1200);
      await rec.click(play, 150);
      await rec.realtimeWithAudio(9000, loopback);
      // Play again does not stop it, and a moving timeline throws off every
      // click after this scene.
      await rec.click(`.lt-transport-buttons button[aria-label="${L("Detener")}"]`, 400);
      await done();
    }

    // 03 — a song without lyrics: import or paste; then the editor.
    {
      const { rec, done } = scene("03-letra-anadir");
      await invoke("seek_transport", { positionSeconds: bare.startSeconds + 20 });
      await browser.pause(1500);
      if (await rectOf(".lt-live-chart-empty-actions")) {
        await rec.zoomTo(".lt-live-chart", { margin: 30, maxZoom: 1.4 });
        await rec.moveTo(".lt-live-chart-empty-actions .lt-live-chart-action.is-primary", 700);
        await rec.hold(2.2);
        await rec.moveTo(".lt-live-chart-empty-actions .lt-live-chart-action:not(.is-primary)", 600);
        await rec.hold(1.5);
        await rec.zoomOut(500);
      }
      await invoke("seek_transport", { positionSeconds: song.startSeconds + 28 });
      await browser.pause(1500);
      await rec.click(`.lt-live-chart button[aria-label="${L("Editar letra y sincronía")}"]`, 1200);
      await rec.zoomTo(".lt-chart-editor", { margin: 30, maxZoom: 1.3 });
      await rec.hold(3);
      await rec.zoomOut(500);
      await rec.click(await tagByText(".lt-chart-editor button", L("Cancelar"), "rv-cancel", true), 600);
      await rec.click(viewBtn(1), 1200);
      await done();
    }

    // 04 — right-click the song → Analizar canción, the setup.
    const modal = ".lt-song-analysis-modal";
    {
      const { rec, done } = scene("04-analizar");
      await fitSong();
      await invoke("seek_transport", { positionSeconds: song.startSeconds + 60 });
      const band = await songBand();
      await rec.rightClick({ x: band.x + Math.min(band.w, 1400) * 0.25, y: band.y + band.h / 2 });
      await rec.hold(1);
      await rec.click(await tagByText(".lt-context-menu button", L("Analizar canción"), "rv-analyze"), 1200);
      await rec.zoomTo(modal, { margin: 30, maxZoom: 1.4 });
      await rec.hold(1.5);
      await rec.moveTo(`${modal} .lt-settings-field select`, 600);
      await rec.hold(1.2);
      await rec.moveTo(`${modal} .lt-render-section`, 600);
      await rec.hold(1.2);
      await done();
    }

    // 04b — the speech recognition download: what it is for, and the download
    // itself (the wait is cut).
    {
      const { rec, done } = scene("04b-voz");
      const callout = `${modal} .lt-song-analysis-callout`;
      if (await rectOf(callout)) {
        await rec.moveTo(callout, 700);
        await rec.hold(Math.max(2, (durations["04b-voz"] ?? 8) - 5));
        await rec.click(`${callout} .lt-song-analysis-button`, 300);
        await rec.hold(1.5);
        for (let i = 0; i < 300 && (await rectOf(callout)); i++) await browser.pause(1000);
        await rec.hold(2.5);
      } else {
        console.log("[release-video] 04b-voz: no download notice (is the model still on disk?)");
      }
      await done();
    }

    // 05 — Analyze; the wait is cut (no frames), then the review and Apply.
    {
      const { rec, done } = scene("05-revisar");
      await rec.click(`${modal} .lt-export-modal-actions .is-primary`, 300);
      await rec.hold(1.5);
      for (let i = 0; i < 400 && !(await rectOf(`${modal} .lt-song-analysis-part`)); i++) await browser.pause(1000);
      await rec.hold(2.5);
      await runInPage(() => {
        const body = document.querySelector(".lt-song-analysis-modal .lt-settings-modal-body");
        body?.querySelector(".lt-song-analysis-guide")?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      for (let i = 0; i < 15; i++) await rec.frame(1 / 15);
      await rec.hold(2.5);
      await rec.click(`${modal} .lt-export-modal-actions .is-primary`, 1200);
      await rec.hold(1);
      if (await rectOf(modal)) await rec.click(`${modal} .lt-export-modal-actions .is-primary`, 800);
      await rec.zoomOut(500);
      await done();
    }

    // 06 — key change: the notch on the band, and the menu entry.
    {
      const { rec, done } = scene("06-nota");
      await fitSong();
      const band = await songBand();
      await rec.zoomTo({ x: band.x, y: band.y - 20, w: Math.min(band.w, 1400), h: 220 }, { margin: 20, maxZoom: 1.8 });
      await rec.rightClick({ x: band.x + Math.min(band.w, 1400) * 0.25, y: band.y + band.h / 2 });
      await rec.hold(0.6);
      await rec.moveTo(await tagByText(".lt-context-menu button", L("Cambio de nota en el cursor"), "rv-key"), 600);
      await rec.hold(2.5);
      await browser.keys(["Escape"]);
      await browser.pause(300);
      if (await rectOf(".lt-key-change-hotspot")) {
        await rec.moveTo(".lt-key-change-hotspot", 800);
        await rec.hold(3);
      }
      await rec.zoomOut(500);
      await done();
    }

    // 07 — ramp on a tempo marker; song tempo in «Warp y tempo».
    {
      const { rec, done } = scene("07-tempo");
      const [tempo] = await onRuler(".lt-tempo-hotspot:not(.lt-time-signature-hotspot)", 0);
      if (tempo) {
        await rec.zoomTo({ x: Math.max(0, tempo.x - 80), y: tempo.y - 200, w: 900, h: 360 }, { margin: 20, maxZoom: 1.8 });
        await rec.rightClick(tempo);
        await rec.hold(0.6);
        await rec.moveTo(await tagByText(".lt-context-menu button", L("Rampa"), "rv-ramp"), 600);
        await rec.hold(2.5);
        await browser.keys(["Escape"]);
        await browser.pause(300);
        await rec.zoomOut(500);
      }
      const band = await songBand();
      await rec.clickAt({ x: band.x + 200, y: band.y + band.h / 2 }, 600);
      await rec.click(`${tour("toolbar-warp")} .lt-control-popover-trigger`, 900);
      await rec.zoomTo(".lt-control-popover-panel", { margin: 40, maxZoom: 1.6 });
      await rec.hold(1.2);
      const plus = await tagByText(".lt-control-popover-panel button", "+", "rv-plus", true);
      await rec.click(plus, 700);
      await rec.click(plus, 900);
      await rec.hold(1.5);
      await rec.click(await tagByText(".lt-control-popover-panel button", L("Original"), "rv-orig", true), 900);
      await rec.zoomOut(500);
      await rec.click(`${tour("toolbar-warp")} .lt-control-popover-trigger`, 600);
      await done();
    }

    // 08 — count style in the voice guide window.
    {
      const { rec, done } = scene("08-conteo");
      const toggle = `${tour("topbar-voice-guide")} > button:nth-of-type(1)`;
      if (!((await (await $(toggle)).getAttribute("class")) ?? "").includes("is-active")) {
        await (await $(toggle)).click();
        await browser.pause(800);
      }
      await rec.click(`${tour("topbar-voice-guide")} > button:nth-of-type(2)`, 900);
      await rec.zoomTo(".lt-pads-popover", { margin: 40, maxZoom: 1.6 });
      const style = `.lt-pads-popover select[aria-label="${L("Estilo de conteo")}"]`;
      if (await rectOf(style)) {
        await rec.moveTo(style, 700);
        await rec.hold(3);
      }
      await rec.zoomOut(500);
      await browser.keys(["Escape"]);
      await rec.hold(0.6);
      const band = await songBand();
      await rec.rightClick({ x: band.x + 300, y: band.y + band.h / 2 });
      await rec.hold(0.6);
      await rec.moveTo(await tagByText(".lt-context-menu button", L("Conteo de la voz guía"), "rv-count"), 600);
      await rec.hold(2);
      await browser.keys(["Escape"]);
      await rec.hold(0.4);
      await done();
    }

    // 09 — three ruler markers with Ctrl+click.
    {
      const { rec, done } = scene("09-marcas");
      const marks = await onRuler(".lt-marker-hotspot", 150);
      if (marks.length < 4) throw new Error("09-marcas: not enough markers on screen");
      await rec.zoomTo({ x: marks[1].x - 120, y: marks[1].y - 150, w: 1100, h: 300 }, { margin: 20, maxZoom: 1.8 });
      await rec.clickAt(marks[1], 500);
      // Ctrl and the click in ONE action: Recorder.clickAt's perform() releases
      // every key when it ends, so a Ctrl held across two clicks only reached
      // the first one.
      for (const mark of [marks[2], marks[3]]) {
        await rec.moveTo(mark, 600);
        await browser.performActions([
          {
            type: "key",
            id: "rv-kb",
            actions: [
              { type: "keyDown", value: "\uE009" },
              { type: "pause", duration: 0 },
              { type: "pause", duration: 0 },
              { type: "pause", duration: 0 },
              { type: "keyUp", value: "\uE009" },
            ],
          },
          {
            type: "pointer",
            id: "rv-mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pause", duration: 0 },
              { type: "pointerMove", duration: 0, x: Math.round(mark.x), y: Math.round(mark.y), origin: "viewport" },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
              { type: "pause", duration: 0 },
            ],
          },
        ]);
        await browser.releaseActions();
        await rec.hold(0.6);
      }
      const selected = await runInPage(() => document.querySelectorAll(".lt-marker-hotspot.is-selected").length);
      console.log(`[release-video] 09-marcas: ${selected} markers selected`);
      await rec.hold(3);
      await browser.keys(["Escape"]);
      await rec.zoomOut(500);
      await done();
    }

    // 10 — mobile, as a title: no recording of the phone this release.
    {
      const { rec, done } = scene("10-movil");
      await titleCard(TITLES.mobile[0], TITLES.mobile[1]);
      await rec.hold(durations["10-movil"]);
      await done();
    }

    // 11 — the fixes, shown on a card (narrated only as a whole).
    {
      const { rec, done } = scene("11-correcciones");
      await runInPage(() => document.getElementById("lt-tutorial-title")?.remove());
      await listCard(TITLES.fixes, FIXES);
      await rec.hold(Math.max(6, durations["11-correcciones"] ?? 6));
      await done();
    }

    // 12 — end card.
    {
      const { rec, done } = scene("12-final");
      await runInPage(() => document.getElementById("lt-tutorial-title")?.remove());
      await titleCard(TITLES.end[0], TITLES.end[1]);
      await rec.hold(durations["12-final"]);
      await done();
      await removeTitleCard();
    }
  });
});
