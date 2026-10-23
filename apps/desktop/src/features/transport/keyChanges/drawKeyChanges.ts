import {
  regionEffectiveKeyAt,
  regionKeySequence,
  type SongRegionSummary,
} from "../desktopApi";
import { screenXToSeconds, secondsToScreenX } from "../timeline/timelineMath";

/**
 * Los cambios de nota se pintan DENTRO de la banda de la canción del ruler,
 * sin carril propio: un carril más haría el ruler más alto, y en móvil cada
 * píxel de alto es timeline que se pierde.
 *
 * - Cada cambio es una muesca vertical en su instante exacto, con la nota
 *   nueva en una pastilla a su derecha si cabe antes de la siguiente.
 * - La pastilla de nota que va pegada al nombre (que se queda fija al borde
 *   izquierdo mientras la canción ocupa la pantalla) enseña la nota que rige
 *   en ESE borde, no la inicial: con el seguimiento del cabezal activo la
 *   muesca se va por la izquierda, pero la nota que suena no se pierde nunca.
 *   El nombre se recorta al llegar a la primera muesca, que le "entrega" la
 *   nota como una cabecera pegajosa de lista.
 */

export const KEY_CHANGE_STROKE = "rgba(201, 167, 255, 0.95)";
const KEY_CHANGE_BADGE_STROKE = "rgba(201, 167, 255, 0.7)";
const KEY_CHANGE_BADGE_TEXT = "rgb(236, 224, 255)";
const BADGE_FONT = '700 9px "Space Grotesk", sans-serif';
const BADGE_HEIGHT = 12;
const BADGE_PADDING_X = 5;

export type KeyChangeNotch = { x: number; key: string };

/** Las muescas de la región en coordenadas de pantalla, ya transpuestas. */
export function keyChangeNotches(
  region: SongRegionSummary,
  cameraX: number,
  pixelsPerSecond: number,
): KeyChangeNotch[] {
  return regionKeySequence(region)
    .slice(1)
    .map((entry) => ({
      x: secondsToScreenX(entry.startSeconds, cameraX, pixelsPerSecond),
      key: entry.key,
    }));
}

/** La nota que rige en la x de pantalla `x` de la banda. */
export function keyAtScreenX(
  region: SongRegionSummary,
  x: number,
  cameraX: number,
  pixelsPerSecond: number,
): string | null {
  return regionEffectiveKeyAt(
    region,
    screenXToSeconds(x, cameraX, pixelsPerSecond),
  );
}

/** Pastilla de nota de un cambio, con el borde lila de las muescas. */
function drawKeyBadge(
  context: CanvasRenderingContext2D,
  text: string,
  left: number,
  centerY: number,
) {
  context.font = BADGE_FONT;
  const width = Math.ceil(context.measureText(text).width + BADGE_PADDING_X * 2);
  const top = Math.round(centerY - BADGE_HEIGHT / 2);
  context.fillStyle = "rgb(16, 16, 22)";
  context.strokeStyle = KEY_CHANGE_BADGE_STROKE;
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(left, top, width, BADGE_HEIGHT, 999);
  context.fill();
  context.stroke();
  context.fillStyle = KEY_CHANGE_BADGE_TEXT;
  context.textBaseline = "middle";
  context.fillText(text, left + BADGE_PADDING_X, centerY + 0.1);
}

export function keyBadgeWidth(context: CanvasRenderingContext2D, text: string) {
  context.font = BADGE_FONT;
  return Math.ceil(context.measureText(text).width + BADGE_PADDING_X * 2);
}

/**
 * Pinta las muescas de `notches` entre `left` y `right` (los bordes visibles
 * de la banda). La pastilla sólo sale si cabe antes de la muesca siguiente o
 * del final de la canción; si no, queda la muesca sola, que sigue marcando el
 * instante exacto.
 */
export function drawKeyChangeNotches(
  context: CanvasRenderingContext2D,
  notches: KeyChangeNotch[],
  left: number,
  right: number,
  top: number,
  height: number,
) {
  const centerY = top + height / 2 + 0.5;
  context.save();
  notches.forEach((notch, index) => {
    if (notch.x < left || notch.x > right) return;
    const x = Math.round(notch.x) + 0.5;
    context.strokeStyle = KEY_CHANGE_STROKE;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, top + 1);
    context.lineTo(x, top + height - 1);
    context.stroke();

    const badgeLeft = x + 4;
    const limit = Math.min(notches[index + 1]?.x ?? Infinity, right) - 4;
    if (badgeLeft + keyBadgeWidth(context, notch.key) <= limit) {
      drawKeyBadge(context, notch.key, badgeLeft, centerY);
    }
  });
  context.restore();
}
