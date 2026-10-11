// Builds the graphics kit handed to the volunteers who record video tutorials:
// logo, palette, title cards, lower thirds, watermark, end screens and YouTube
// thumbnails, in both 16:9 (YouTube) and 9:16 (reels), plus the demo stems so
// every tutorial is recorded over the same music.
//
//   node scripts/tutorial-kit/make-kit.mjs [--spec scripts/tutorial-kit/kit.json]
//
// Volunteers edit in CapCut, DaVinci, Canva or their phone, not in code, so
// every piece is a flat PNG: a textless version they write over in their editor,
// and a filled-in example that shows the font, size and position to match.
// Pieces meant to sit on top of the screen recording are transparent.
//
// Rendering reuses the release-poster approach (scripts/poster): one
// self-contained HTML per piece, captured by headless Chrome/Edge. The fonts
// are the site's own woff2, inlined, so the cards match libretracks.com.
//
// The editable TTFs in 03-fuentes are NOT produced here: the repo only has
// woff2 subsets. They come from the upstream releases (OFL): Inter 4.1 from
// github.com/rsms/inter and Space Grotesk from github.com/google/fonts, the
// latter instanced to static weights with fontTools. Re-running this script
// leaves that folder alone.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const CHROME_CANDIDATES = [
  process.env.LT_POSTER_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

// The site's palette (apps/website/src/styles/global.css), so a tutorial looks
// like it belongs next to the guide it links to.
const C = {
  bg: '#0a0f12',
  surface: '#131313',
  surfaceLow: '#0e0e0e',
  surfaceHigh: '#2a2a2a',
  primary: '#57f1db',
  primaryStrong: '#2dd4bf',
  primaryDeep: '#003731',
  secondary: '#ffe2ab',
  heading: '#f3f0ef',
  text: '#e5e2e1',
  muted: '#bacac5',
  outline: '#859490',
  rec: '#ef4444',
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const br = (s) => esc(s).replace(/\n/g, '<br>');

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found. Set LT_POSTER_CHROME to its path.');
  return found;
}

function dataUri(file, mime) {
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

function fontCss() {
  const dir = path.join(REPO, 'apps/desktop/public/fonts');
  const faces = [];
  for (const w of [400, 500, 600, 700, 800, 900]) {
    for (const sub of ['latin', 'latin-ext']) {
      faces.push(
        `@font-face{font-family:'Inter';font-weight:${w};src:url(${dataUri(path.join(dir, `inter-${w}-${sub}.woff2`), 'font/woff2')}) format('woff2');}`,
      );
    }
  }
  for (const w of [400, 500, 600, 700]) {
    for (const sub of ['latin', 'latin-ext']) {
      faces.push(
        `@font-face{font-family:'Space Grotesk';font-weight:${w};src:url(${dataUri(path.join(dir, `space-grotesk-${w}-${sub}.woff2`), 'font/woff2')}) format('woff2');}`,
      );
    }
  }
  return faces.join('\n');
}

const ICON_SVG = path.join(REPO, 'apps/desktop/src-tauri/icons/icon.svg');
const ICON = dataUri(ICON_SVG, 'image/svg+xml');

// ---------------------------------------------------------------------------
// Rendering

let chrome;
let fonts;
let tmp;

function render(outFile, { w, h, css = '', body, transparent = false }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{width:${w}px;height:${h}px;overflow:hidden;}
body{font-family:'Inter',sans-serif;color:${C.heading};
  background:${transparent ? 'transparent' : C.bg};-webkit-font-smoothing:antialiased;}
${BASE_CSS}
${css}
</style></head><body>${body}</body></html>`;
  const htmlPath = path.join(tmp, `${path.basename(outFile, '.png')}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(htmlPath, html);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${w},${h}`,
    `--screenshot=${outFile}`,
  ];
  if (transparent) args.push('--default-background-color=00000000');
  args.push(`file:///${htmlPath.replace(/\\/g, '/')}`);
  execFileSync(chrome, args, { stdio: 'ignore' });
  console.log(`  ${path.relative(OUT, outFile)}`);
}

// Shared building blocks. Sizes are in px of the final frame; the vertical
// pieces scale a few of them up because a phone screen is held further away
// relative to its width.
const BASE_CSS = `
.bg{position:absolute;inset:0;background:${C.bg};overflow:hidden;}
.bg::before{content:"";position:absolute;inset:0;
  background:radial-gradient(70% 70% at 8% 0%, #12302f 0%, transparent 70%),
             radial-gradient(60% 60% at 100% 100%, #0d2422 0%, transparent 70%);}
.bg::after{content:"";position:absolute;inset:0;
  background-image:linear-gradient(${C.primaryStrong}10 1px, transparent 1px),
                   linear-gradient(90deg, ${C.primaryStrong}10 1px, transparent 1px);
  background-size:64px 64px;
  -webkit-mask-image:radial-gradient(90% 90% at 50% 40%, #000 30%, transparent 100%);}
.bars{position:absolute;display:flex;align-items:flex-end;gap:var(--gap);opacity:.10;}
.bars i{display:block;width:var(--bw);border-radius:999px;background:${C.primary};}
.wm{display:inline-flex;align-items:center;gap:.38em;font-weight:800;letter-spacing:-0.01em;}
.wm img{width:1.35em;height:1.35em;}
.chip{display:inline-flex;align-items:center;gap:.6em;font-family:'Space Grotesk';font-weight:700;
  letter-spacing:.18em;text-transform:uppercase;color:${C.primary};}
.chip.box{border:2px solid ${C.primary}66;background:${C.primaryDeep}aa;border-radius:999px;padding:.55em 1.1em;}
.dot{width:.62em;height:.62em;border-radius:50%;background:${C.rec};box-shadow:0 0 .6em ${C.rec};}
.title{font-weight:800;letter-spacing:-0.025em;line-height:1.04;color:#fff;}
.sub{font-weight:500;color:${C.primary};line-height:1.25;}
.url{font-family:'Space Grotesk';font-weight:600;color:${C.muted};letter-spacing:.02em;}
`;

// The motif behind the cards: the app icon's own fader bars, blown up and
// faded, so the background says "mixer" without competing with the title.
function bars(style, { bw = 64, gap = 40, heights = [62, 42, 78, 55, 90, 36, 70] } = {}) {
  const max = Math.max(...heights);
  return `<div class="bars" style="--bw:${bw}px;--gap:${gap}px;${style}">${heights
    .map((h) => `<i style="height:${(h / max) * 100}%"></i>`)
    .join('')}</div>`;
}

const wordmark = (size, color = C.primary) =>
  `<div class="wm" style="font-size:${size}px;color:${color}"><img src="${ICON}">LibreTracks</div>`;

// ---------------------------------------------------------------------------
// Pieces

function logos(dir) {
  copyFileSync(ICON_SVG, path.join(dir, 'icono.svg'));
  for (const n of [512, 1024, 2048]) {
    render(path.join(dir, `icono-${n}.png`), {
      w: n,
      h: n,
      transparent: true,
      body: `<img src="${ICON}" style="width:${n}px;height:${n}px;display:block">`,
    });
  }
  const variants = [
    ['logotipo-turquesa', C.primary, 'para fondos oscuros'],
    ['logotipo-blanco', '#ffffff', 'para fondos oscuros'],
    ['logotipo-oscuro', '#0e0e0e', 'para fondos claros'],
  ];
  for (const [name, color] of variants) {
    render(path.join(dir, `${name}.png`), {
      w: 2400,
      h: 600,
      transparent: true,
      css: `body{display:flex;align-items:center;justify-content:center;}`,
      body: wordmark(300, color),
    });
  }
}

function palette(dir) {
  const swatches = [
    ['Turquesa (principal)', C.primary, 'Subtítulos, acentos, flechas, resaltes'],
    ['Turquesa intenso', C.primaryStrong, 'Botones, barras, círculos de paso'],
    ['Fondo', C.bg, 'Fondo de portadas y cierres'],
    ['Superficie', C.surface, 'Cajas y rótulos'],
    ['Blanco títulos', C.heading, 'Títulos'],
    ['Gris texto', C.muted, 'Texto secundario, URL'],
    ['Crema (aviso)', C.secondary, 'Solo para avisos o "ojo con esto"'],
    ['Rojo REC', C.rec, 'Solo el punto de grabación'],
  ];
  const css = `
.wrap{position:absolute;inset:0;padding:90px 110px;display:flex;flex-direction:column;gap:56px;}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:36px;}
.sw{border-radius:28px;overflow:hidden;background:${C.surface};border:1px solid #ffffff14;}
.sw .c{height:230px;border-bottom:1px solid #ffffff14;}
.sw .t{padding:22px 26px;}
.sw b{display:block;font-size:30px;font-weight:700;color:#fff;}
.sw code{display:block;font-family:'Space Grotesk';font-size:34px;font-weight:700;color:${C.primary};margin:6px 0;}
.sw p{font-size:21px;color:${C.muted};line-height:1.3;}
`;
  const cells = swatches
    .map(
      ([name, hex, use]) =>
        `<div class="sw"><div class="c" style="background:${hex}"></div><div class="t"><b>${esc(name)}</b><code>${hex.toUpperCase()}</code><p>${esc(use)}</p></div></div>`,
    )
    .join('');
  render(path.join(dir, 'paleta.png'), {
    w: 1920,
    h: 1080,
    css,
    body: `<div class="bg"></div><div class="wrap">${wordmark(56)}<div class="grid">${cells}</div></div>`,
  });
  writeFileSync(
    path.join(dir, 'paleta.txt'),
    [
      'Colores de LibreTracks (los mismos que la web y la app)',
      '',
      ...swatches.map(([name, hex, use]) => `${hex.toUpperCase()}  ${name.padEnd(22)} ${use}`),
      '',
      'Regla rápida: fondo oscuro, títulos en blanco, todo lo que quieras resaltar en turquesa.',
      'No uses otros colores llamativos (amarillo, naranja, morado) para resaltar.',
      '',
    ].join('\r\n'),
  );
}

// --- 16:9 --------------------------------------------------------------------

function coverH(file, { title, subtitle, platform, number } = {}) {
  const css = `
.top{position:absolute;left:120px;top:96px;}
.mid{position:absolute;left:120px;width:1240px;top:50%;transform:translateY(-46%);}
.mid .chip{font-size:30px;margin-bottom:34px;}
.mid .title{font-size:124px;}
.mid .sub{font-size:48px;margin-top:30px;}
.foot{position:absolute;left:120px;right:120px;bottom:88px;display:flex;justify-content:space-between;align-items:center;}
.foot .url{font-size:30px;}
.foot .chip{font-size:24px;}
`;
  const chip = number ? `<span class="dot"></span>Tutorial ${String(number).padStart(2, '0')}` : '<span class="dot"></span>Tutorial';
  render(file, {
    w: 1920,
    h: 1080,
    css,
    body: `<div class="bg"></div>
${bars('right:110px;bottom:150px;height:640px;')}
<div class="top">${wordmark(46)}</div>
${title ? `<div class="mid"><div class="chip">${chip}</div><div class="title">${br(title)}</div>${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}</div>` : ''}
<div class="foot"><span class="url">${esc(SPEC.site)}</span>${platform ? `<span class="chip box">${esc(platform)}</span>` : ''}</div>`,
  });
}

// The dim layer the official tutorials put over the app while the title is on
// screen: lay it over the recording, write the title on top.
function scrimH(file, w = 1920, h = 1080) {
  render(file, {
    w,
    h,
    transparent: true,
    body: `<div style="position:absolute;inset:0;background:radial-gradient(80% 80% at 50% 50%, ${C.bg}c7 0%, ${C.bg}eb 100%)"></div>`,
  });
}

function lowerThirdCss(scale = 1) {
  const s = (px) => `${Math.round(px * scale)}px`;
  return `
.lt{position:absolute;display:flex;align-items:stretch;border-radius:${s(20)};overflow:hidden;
  background:${C.surfaceLow}e6;border:1px solid #ffffff1f;box-shadow:0 ${s(18)} ${s(50)} #000000a0;}
.lt .n{display:flex;align-items:center;justify-content:center;min-width:${s(104)};
  background:${C.primaryStrong};color:${C.bg};font-weight:800;font-size:${s(50)};}
.lt .t{display:flex;flex-direction:column;justify-content:center;padding:0 ${s(40)};gap:${s(4)};}
.lt .k{font-family:'Space Grotesk';font-weight:700;font-size:${s(22)};letter-spacing:.2em;color:${C.primary};text-transform:uppercase;}
.lt .v{font-weight:700;font-size:${s(42)};color:#fff;white-space:nowrap;}
`;
}

function lowerThirdH(file, { number, step } = {}) {
  render(file, {
    w: 1920,
    h: 1080,
    transparent: true,
    css: `${lowerThirdCss(1)} .lt{left:96px;bottom:110px;height:116px;width:${step ? 'auto' : '860px'};}`,
    body: `<div class="lt"><div class="n">${number ?? ''}</div><div class="t">${
      step ? `<span class="k">Paso ${number}</span><span class="v">${esc(step)}</span>` : ''
    }</div></div>`,
  });
}

function watermark(file, w, h, { right, bottom, size }) {
  render(file, {
    w,
    h,
    transparent: true,
    css: `.m{position:absolute;right:${right}px;bottom:${bottom}px;opacity:.72;filter:drop-shadow(0 2px 8px #000c);}`,
    body: `<div class="m">${wordmark(size, '#ffffff')}</div>`,
  });
}

function endH(file, { youtube }) {
  // The YouTube version leaves the right half empty: that is where YouTube's
  // own end-screen elements (next video, subscribe) get placed on upload.
  const css = youtube
    ? `
.l{position:absolute;left:120px;top:0;bottom:0;width:760px;display:flex;flex-direction:column;justify-content:center;gap:28px;}
.l .title{font-size:96px;}
.l .sub{font-size:40px;}
.l .url{font-size:32px;margin-top:30px;line-height:1.6;}
.r{position:absolute;right:120px;top:260px;width:880px;font-family:'Space Grotesk';font-weight:700;font-size:30px;letter-spacing:.18em;color:${C.primary};text-transform:uppercase;text-align:center;}
`
    : `
.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;text-align:center;}
.c .title{font-size:118px;}
.c .sub{font-size:46px;}
.c .url{font-size:30px;margin-top:40px;}
`;
  const body = youtube
    ? `<div class="bg"></div>
<div class="l">${wordmark(52)}<div class="title">¡Gracias<br>por ver!</div><div class="sub">La guía completa, botón a botón,<br>en ${esc(SPEC.site)}</div><div class="url">${esc(SPEC.youtube)}</div></div>
<div class="r">Sigue aprendiendo →</div>`
    : `<div class="bg"></div>${bars('left:50%;bottom:-40px;height:360px;transform:translateX(-50%);')}
<div class="c">${wordmark(52)}<div class="title">${esc(SPEC.site)}</div><div class="sub">La guía completa, botón a botón</div><div class="url">${esc(SPEC.youtube)}</div></div>`;
  render(file, { w: 1920, h: 1080, css, body });
}

function stepBadge(file, n) {
  render(file, {
    w: 240,
    h: 240,
    transparent: true,
    css: `.b{position:absolute;inset:16px;border-radius:50%;background:${C.primaryStrong};
      display:flex;align-items:center;justify-content:center;color:${C.bg};
      font-weight:800;font-size:120px;letter-spacing:-0.03em;
      box-shadow:0 0 0 8px ${C.bg}, 0 0 0 11px ${C.primary}88;}`,
    body: `<div class="b">${n}</div>`,
  });
}

// An arrow and a ring to point at a button. Most editors have shapes, but a
// matching colour and stroke is what keeps them from looking pasted in.
function pointers(dir) {
  const stroke = C.primary;
  render(path.join(dir, 'circulo-resaltar.png'), {
    w: 520,
    h: 520,
    transparent: true,
    body: `<svg width="520" height="520" viewBox="0 0 520 520"><circle cx="260" cy="260" r="220" fill="none" stroke="${stroke}" stroke-width="16" style="filter:drop-shadow(0 0 14px ${stroke}aa)"/></svg>`,
  });
  render(path.join(dir, 'recuadro-resaltar.png'), {
    w: 900,
    h: 420,
    transparent: true,
    body: `<svg width="900" height="420" viewBox="0 0 900 420"><rect x="30" y="30" width="840" height="360" rx="34" fill="none" stroke="${stroke}" stroke-width="14" style="filter:drop-shadow(0 0 14px ${stroke}aa)"/></svg>`,
  });
  render(path.join(dir, 'flecha.png'), {
    w: 520,
    h: 300,
    transparent: true,
    body: `<svg width="520" height="300" viewBox="0 0 520 300"><g style="filter:drop-shadow(0 6px 14px #000c)">
<path d="M40 150 H400" stroke="${stroke}" stroke-width="34" stroke-linecap="round"/>
<path d="M330 60 L470 150 L330 240" fill="none" stroke="${stroke}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`,
  });
  render(path.join(dir, 'clic-raton.png'), {
    w: 300,
    h: 300,
    transparent: true,
    body: `<svg width="300" height="300" viewBox="0 0 300 300">
<circle cx="150" cy="150" r="60" fill="${stroke}55" stroke="${stroke}" stroke-width="10"/>
<circle cx="150" cy="150" r="118" fill="none" stroke="${stroke}" stroke-width="8" opacity=".55"/></svg>`,
  });
}

function thumb(file, { title, number, platform } = {}) {
  const css = `
.l{position:absolute;left:72px;top:64px;bottom:64px;width:820px;display:flex;flex-direction:column;}
.l .title{font-size:120px;line-height:.98;margin-top:auto;margin-bottom:auto;}
.l .chip{font-size:24px;}
.num{position:absolute;right:70px;top:40px;font-weight:800;font-size:230px;line-height:1;letter-spacing:-0.04em;
  color:transparent;-webkit-text-stroke:5px ${C.primary};opacity:.85;}
.pl{position:absolute;right:72px;bottom:64px;font-size:26px;}
`;
  render(file, {
    w: 1280,
    h: 720,
    css,
    body: `<div class="bg"></div>
${bars('right:80px;bottom:140px;height:330px;', { bw: 46, gap: 28 })}
<div class="l">${wordmark(40)}${title ? `<div class="title">${br(title)}</div>` : ''}<span class="chip"><span class="dot"></span>Tutorial</span></div>
${number ? `<div class="num">${String(number).padStart(2, '0')}</div>` : ''}
${platform ? `<span class="chip box pl">${esc(platform)}</span>` : ''}`,
  });
}

// --- 9:16 --------------------------------------------------------------------

// Instagram/Facebook reels cover roughly the top 250 px and bottom 440 px with
// their own UI, plus the action column on the right. Everything important stays
// inside that box (measured on 1080x1920; the platforms move it a few px from
// one release to the next, so it is a margin, not an exact line).
const SAFE = { top: 250, bottom: 440, side: 70, right: 170 };

function coverV(file, { title, subtitle, platform, number } = {}) {
  const css = `
.top{position:absolute;left:${SAFE.side}px;top:${SAFE.top}px;}
.mid{position:absolute;left:${SAFE.side}px;right:${SAFE.right}px;top:50%;transform:translateY(-50%);}
.mid .chip{font-size:30px;margin-bottom:34px;}
.mid .title{font-size:112px;}
.mid .sub{font-size:46px;margin-top:30px;}
.foot{position:absolute;left:${SAFE.side}px;right:${SAFE.right}px;bottom:${SAFE.bottom}px;display:flex;flex-direction:column;gap:22px;align-items:flex-start;}
.foot .url{font-size:32px;}
.foot .chip{font-size:24px;}
`;
  const chip = number ? `<span class="dot"></span>Tutorial ${String(number).padStart(2, '0')}` : '<span class="dot"></span>Tutorial';
  render(file, {
    w: 1080,
    h: 1920,
    css,
    body: `<div class="bg"></div>
${bars('left:50%;bottom:-60px;height:420px;transform:translateX(-50%);')}
<div class="top">${wordmark(50)}</div>
${title ? `<div class="mid"><div class="chip">${chip}</div><div class="title">${br(title)}</div>${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}</div>` : ''}
<div class="foot">${platform ? `<span class="chip box">${esc(platform)}</span>` : ''}<span class="url">${esc(SPEC.site)}</span></div>`,
  });
}

function lowerThirdV(file, { number, step } = {}) {
  render(file, {
    w: 1080,
    h: 1920,
    transparent: true,
    css: `${lowerThirdCss(1.05)} .lt{left:${SAFE.side}px;bottom:${SAFE.bottom + 40}px;height:124px;width:${step ? 'auto' : `${1080 - SAFE.side - SAFE.right}px`};}
      .lt .v{white-space:normal;font-size:40px;}`,
    body: `<div class="lt"><div class="n">${number ?? ''}</div><div class="t">${
      step ? `<span class="k">Paso ${number}</span><span class="v">${esc(step)}</span>` : ''
    }</div></div>`,
  });
}

function endV(file) {
  const css = `
.c{position:absolute;left:${SAFE.side}px;right:${SAFE.right - 60}px;top:${SAFE.top}px;bottom:${SAFE.bottom}px;
  display:flex;flex-direction:column;justify-content:center;gap:30px;}
.c .title{font-size:104px;}
.c .sub{font-size:46px;}
.c .url{font-size:34px;margin-top:30px;line-height:1.6;}
`;
  render(file, {
    w: 1080,
    h: 1920,
    css,
    body: `<div class="bg"></div>${bars('left:50%;bottom:-60px;height:420px;transform:translateX(-50%);')}
<div class="c">${wordmark(52)}<div class="title">¡Gracias<br>por ver!</div><div class="sub">La guía completa en<br>${esc(SPEC.site)}</div><div class="url">${esc(SPEC.youtube)}</div></div>`,
  });
}

function safeZoneV(file) {
  const z = `background:repeating-linear-gradient(135deg, ${C.rec}55 0 18px, ${C.rec}30 18px 36px);`;
  const label = `font-family:'Space Grotesk';font-weight:700;font-size:30px;letter-spacing:.12em;color:#fff;text-transform:uppercase;`;
  render(file, {
    w: 1080,
    h: 1920,
    transparent: true,
    css: `.z{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;${z}${label}}
      .ok{position:absolute;left:${SAFE.side}px;right:${SAFE.right}px;top:${SAFE.top}px;bottom:${SAFE.bottom}px;
        border:4px dashed ${C.primary};display:flex;align-items:flex-start;justify-content:center;padding-top:20px;${label}color:${C.primary};}`,
    body: `<div class="z" style="left:0;right:0;top:0;height:${SAFE.top}px">Lo tapa la app</div>
<div class="z" style="left:0;right:0;bottom:0;height:${SAFE.bottom}px">Lo tapan el texto y los botones</div>
<div class="z" style="right:0;top:${SAFE.top}px;bottom:${SAFE.bottom}px;width:${SAFE.right}px;font-size:22px;writing-mode:vertical-rl">Botones</div>
<div class="ok">Zona segura</div>`,
  });
}

function safeZoneH(file) {
  // Title-safe at 5% plus the bottom band where YouTube draws its progress
  // bar and captions.
  const label = `font-family:'Space Grotesk';font-weight:700;font-size:28px;letter-spacing:.12em;text-transform:uppercase;`;
  render(file, {
    w: 1920,
    h: 1080,
    transparent: true,
    css: `.ok{position:absolute;left:96px;right:96px;top:54px;bottom:54px;border:4px dashed ${C.primary};
        display:flex;justify-content:center;padding-top:16px;${label}color:${C.primary};}
      .cc{position:absolute;left:96px;right:96px;bottom:54px;height:190px;
        background:repeating-linear-gradient(135deg, ${C.rec}44 0 18px, ${C.rec}22 18px 36px);
        display:flex;align-items:center;justify-content:center;${label}color:#fff;}`,
    body: `<div class="ok">Zona segura</div><div class="cc">Subtítulos y barra de YouTube: evita poner texto aquí</div>`,
  });
}

// ---------------------------------------------------------------------------

function demoSongs(dir) {
  const src = path.join(REPO, 'apps/desktop/src-tauri/resources/demo/audio');
  const songs = [
    ['costa-norte', 'Costa Norte - 110 BPM - Re mayor - 4-4'],
    ['callejon-blues', 'Callejon Blues - 90 BPM - La mayor - 4-4'],
  ];
  for (const [slug, name] of songs) {
    const to = path.join(dir, name);
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(path.join(src, slug))) {
      copyFileSync(path.join(src, slug, f), path.join(to, f));
    }
  }
}

let SPEC;
let OUT;

function main() {
  const specArg = process.argv.indexOf('--spec');
  const specPath = path.resolve(
    REPO,
    specArg > 0 ? process.argv[specArg + 1] : 'scripts/tutorial-kit/kit.json',
  );
  SPEC = JSON.parse(readFileSync(specPath, 'utf8'));
  OUT = path.resolve(REPO, SPEC.out);
  chrome = findChrome();
  fonts = fontCss();
  tmp = path.join(os.tmpdir(), `lt-tutorial-kit-${process.pid}`);
  mkdirSync(tmp, { recursive: true });

  const d = (...p) => {
    const dir = path.join(OUT, ...p);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  // Regenerated folders are wiped so a renamed piece doesn't leave its old
  // file behind. 03-fuentes is not touched (see header).
  for (const f of ['01-logo', '02-colores', '04-horizontal-youtube', '05-vertical-reels', '06-miniaturas-youtube', '07-cancion-demo']) {
    rmSync(path.join(OUT, f), { recursive: true, force: true });
  }

  const ex = SPEC.example;
  const DESK = 'Escritorio';
  const MOB = 'Móvil y tablet';

  console.log('logo');
  logos(d('01-logo'));

  console.log('colores');
  palette(d('02-colores'));

  console.log('horizontal');
  const H = '04-horizontal-youtube';
  coverH(path.join(d(H, '1-portadas'), 'portada-fondo-vacio.png'), {});
  coverH(path.join(d(H, '1-portadas'), 'portada-ejemplo.png'), ex);
  for (const t of SPEC.tutorials) {
    for (const [pl, suffix] of [[DESK, 'escritorio'], [MOB, 'movil']]) {
      coverH(path.join(d(H, '1-portadas', 'por-tutorial'), `${t.slug}-${suffix}.png`), { ...t, platform: pl });
    }
  }
  scrimH(path.join(d(H, '2-superposiciones'), 'velo-oscuro-para-titulos.png'));
  watermark(path.join(d(H, '2-superposiciones'), 'marca-de-agua.png'), 1920, 1080, { right: 56, bottom: 44, size: 34 });
  lowerThirdH(path.join(d(H, '3-rotulos'), 'rotulo-paso-vacio.png'), {});
  lowerThirdH(path.join(d(H, '3-rotulos'), 'rotulo-paso-ejemplo.png'), { number: 1, step: ex.step });
  for (let n = 1; n <= 12; n += 1) stepBadge(path.join(d(H, '3-rotulos', 'numeros-de-paso'), `paso-${String(n).padStart(2, '0')}.png`), n);
  pointers(d(H, '4-flechas-y-resaltes'));
  endH(path.join(d(H, '5-cierre'), 'cierre.png'), { youtube: false });
  endH(path.join(d(H, '5-cierre'), 'cierre-pantalla-final-youtube.png'), { youtube: true });
  safeZoneH(path.join(d(H, '0-guia-no-exportar'), 'zona-segura-horizontal.png'));

  console.log('vertical');
  const V = '05-vertical-reels';
  coverV(path.join(d(V, '1-portadas'), 'portada-fondo-vacio.png'), {});
  coverV(path.join(d(V, '1-portadas'), 'portada-ejemplo.png'), { ...ex, platform: MOB });
  for (const t of SPEC.tutorials) {
    for (const [pl, suffix] of [[DESK, 'escritorio'], [MOB, 'movil']]) {
      coverV(path.join(d(V, '1-portadas', 'por-tutorial'), `${t.slug}-${suffix}.png`), { ...t, platform: pl });
    }
  }
  scrimH(path.join(d(V, '2-superposiciones'), 'velo-oscuro-para-titulos.png'), 1080, 1920);
  watermark(path.join(d(V, '2-superposiciones'), 'marca-de-agua.png'), 1080, 1920, { right: SAFE.right, bottom: SAFE.bottom + 10, size: 34 });
  lowerThirdV(path.join(d(V, '3-rotulos'), 'rotulo-paso-vacio.png'), {});
  lowerThirdV(path.join(d(V, '3-rotulos'), 'rotulo-paso-ejemplo.png'), { number: 1, step: ex.step });
  endV(path.join(d(V, '5-cierre'), 'cierre.png'));
  safeZoneV(path.join(d(V, '0-guia-no-exportar'), 'zona-segura-reels.png'));

  console.log('miniaturas');
  const T = '06-miniaturas-youtube';
  thumb(path.join(d(T), 'miniatura-fondo-vacio.png'), {});
  thumb(path.join(d(T), 'miniatura-ejemplo.png'), { title: 'Tu primera\ncanción', number: 1, platform: DESK });
  for (const t of SPEC.tutorials) {
    for (const [pl, suffix] of [[DESK, 'escritorio'], [MOB, 'movil']]) {
      thumb(path.join(d(T, 'por-tutorial'), `${t.slug}-${suffix}.png`), { title: t.thumb, number: t.number, platform: pl });
    }
  }

  copyFileSync(path.join(HERE, 'LEEME.txt'), path.join(OUT, 'LEEME.txt'));

  console.log('cancion demo');
  demoSongs(d('07-cancion-demo'));

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nKit en ${OUT}`);
}

main();
