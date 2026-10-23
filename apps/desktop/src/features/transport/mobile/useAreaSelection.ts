import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import type { ClipSummary } from "../desktopApi";
import { isMobileApp } from "../desktopApi";
import type { TimelineTrackSummary } from "../library/pendingAudioImports";
import type { TrackRowLayout } from "../tracks/trackLayout";
import { useTimelineUIStore } from "../uiStore";
import { AreaSelectionDrag, type AreaRowSource } from "./areaSelection";
import type { AreaSelectGesture } from "./MobileTimelineNavigation";

/** El visor que desplaza en vertical cabeceras y carriles a la vez. */
const SCROLL_VIEWPORT_SELECTOR = ".lt-timeline-scroll-viewport";

function isAreaSelectActive() {
  return isMobileApp && useTimelineUIStore.getState().areaSelectMode;
}

/** Filas del recuadro: las pistas visibles con su layout. */
export type AreaTrackRows = {
  layout: TrackRowLayout;
  tracks: readonly TimelineTrackSummary[];
};

/**
 * `AreaRowSource` desde las pistas: el ancla es la primera fila montada que
 * encuentre `anchorSelector` dentro de `surface` (una busqueda, no N).
 */
function rowSourceFor(
  surface: HTMLElement,
  anchorSelector: string,
  rows: AreaTrackRows | null,
  skip: (track: TimelineTrackSummary) => boolean,
): AreaRowSource | null {
  if (!rows) return null;
  return {
    layout: rows.layout,
    rows: rows.tracks.map((track) => ({ id: track.id, skip: skip(track) })),
    anchor: surface.querySelector<HTMLElement>(anchorSelector),
  };
}

/**
 * Recuadro sobre los carriles: selecciona CLIPS.
 *
 * El gesto lo arbitra la navegacion tactil (ella decide si un dedo dibuja,
 * desplaza o hace zoom); esto solo pone el recuadro y la seleccion. Se
 * memoiza contra refs, porque de este objeto cuelga un gesto vivo.
 */
export function useLaneAreaSelection(deps: {
  surfaceRef: RefObject<HTMLElement | null>;
  rows: AreaTrackRows;
  clipsByTrack: Record<string, ClipSummary[]>;
  cameraXRef: MutableRefObject<number>;
  pixelsPerSecondRef: MutableRefObject<number>;
  previewCameraX: (cameraX: number) => number;
  commitCameraX: (cameraX: number) => void;
  /** Al empezar: lo que haya que soltar aparte (la region, que no vive en el
   * store de seleccion). */
  onBegin?: () => void;
}): AreaSelectGesture {
  const live = useRef(deps);
  live.current = deps;
  return useMemo(() => {
    let drag: AreaSelectionDrag | null = null;
    return {
      active: isAreaSelectActive,
      begin: (clientX, clientY) => {
        const surface = live.current.surfaceRef.current;
        if (!surface) return;
        live.current.onBegin?.();
        drag = new AreaSelectionDrag(
          {
            surface,
            // En los carriles no se salta ninguna fila: las que no son pistas
            // no tienen clips que coger.
            getRows: () =>
              rowSourceFor(
                surface,
                ".lt-track-lane-row[data-track-id]",
                live.current.rows,
                () => false,
              ),
            getViewport: () => surface.closest<HTMLElement>(SCROLL_VIEWPORT_SELECTOR),
            getSelection: () => useTimelineUIStore.getState().selectedClipIds,
            setSelection: (ids) =>
              useTimelineUIStore.getState().setSelectedClipIds(ids),
            clips: {
              getClipsByTrack: () => live.current.clipsByTrack,
              getCameraX: () => live.current.cameraXRef.current,
              getPixelsPerSecond: () => live.current.pixelsPerSecondRef.current,
              previewCameraX: (cameraX) => live.current.previewCameraX(cameraX),
              commitCameraX: (cameraX) => live.current.commitCameraX(cameraX),
            },
          },
          clientX,
          clientY,
        );
      },
      update: (clientX, clientY) => drag?.update(clientX, clientY),
      end: () => {
        drag?.end();
        drag = null;
      },
      cancel: () => {
        drag?.cancel();
        drag = null;
      },
    };
  }, []);
}

/** Recorrido minimo para que el dedo sobre las cabeceras empiece un recuadro. */
const HEADER_DRAG_THRESHOLD_PX = 8;
/** Botones e interruptores de la cabecera: ahi el dedo pulsa, no dibuja. */
const HEADER_CONTROL_SELECTOR =
  "button, input, label, textarea, select, .lt-track-volume, .lt-track-pan, .lt-ruler-header";

/**
 * Recuadro sobre la columna de cabeceras: selecciona PISTAS.
 *
 * Aqui no hay navegacion tactil que arbitre: la columna desplaza con el
 * scroll nativo (`touch-action: pan-y`). En el modo, el CSS le quita ese
 * gesto (`.is-area-select`) y lo recogemos nosotros. Un toque sin arrastre
 * sigue siendo un `click`, que la cabecera ya convierte en sumar o quitar.
 */
export function useHeaderAreaSelection(
  paneRef: RefObject<HTMLElement | null>,
  /** Al empezar a dibujar: cancela la pulsacion larga, que ya no lo es. */
  onBegin: () => void,
  rows: AreaTrackRows | null = null,
) {
  const onBeginRef = useRef(onBegin);
  onBeginRef.current = onBegin;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !isMobileApp) return;

    let start: { pointerId: number; x: number; y: number } | null = null;
    let drag: AreaSelectionDrag | null = null;
    let suppressClickUntil = 0;

    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.pointerId) return;
      if (!drag) {
        if (
          Math.hypot(event.clientX - start.x, event.clientY - start.y) <
          HEADER_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        onBeginRef.current();
        drag = new AreaSelectionDrag(
          {
            surface: pane,
            getRows: () =>
              rowSourceFor(
                pane,
                ".lt-track-header-row[data-track-id]",
                rowsRef.current,
                // Filas que no son pistas de verdad (automatizacion, importando).
                (track) => Boolean(track.isAutomation || track.isPending),
              ),
            getViewport: () => pane.closest<HTMLElement>(SCROLL_VIEWPORT_SELECTOR),
            getSelection: () => useTimelineUIStore.getState().selectedTrackIds,
            setSelection: (ids) => useTimelineUIStore.getState().selectTrack(ids),
          },
          start.x,
          start.y,
        );
      }
      event.preventDefault();
      drag.update(event.clientX, event.clientY);
    };

    const finish = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.pointerId) return;
      if (drag) {
        if (event.type === "pointercancel") drag.cancel();
        else drag.end();
        // El dedo se levanta sobre una cabecera: su `click` la sumaria o
        // quitaria encima de lo que acaba de coger el recuadro.
        suppressClickUntil = Date.now() + 400;
      }
      drag = null;
      start = null;
      detach();
    };

    const detach = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
    };

    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !isAreaSelectActive()) return;
      if (start) {
        // Segundo dedo: no es un recuadro.
        drag?.cancel();
        drag = null;
        start = null;
        detach();
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest(HEADER_CONTROL_SELECTOR)
      ) {
        return;
      }
      start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      window.addEventListener("pointermove", move, { capture: true, passive: false });
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", finish, true);
    };

    // `touch-action: none` no basta: con el dedo sobre la columna los WebView
    // de iOS y Android seguian desplazando el visor, y el `pointercancel` se
    // llevaba el recuadro antes de dibujarlo. Los carriles lo resuelven igual,
    // con `preventDefault` sobre el evento tactil (ver InputManager). Aqui va
    // sobre `touchmove` y no `touchstart`, que mataria el `click` del toque
    // suelto que suma o quita una pista.
    const blockNativeScroll = (event: TouchEvent) => {
      if (start && event.touches.length === 1 && event.cancelable) {
        event.preventDefault();
      }
    };

    const swallowClick = (event: MouseEvent) => {
      if (Date.now() < suppressClickUntil) {
        suppressClickUntil = 0;
        event.preventDefault();
        event.stopPropagation();
      }
    };

    pane.addEventListener("pointerdown", down, true);
    pane.addEventListener("click", swallowClick, true);
    // Sobre el propio panel y no `window`: WebKit trata como pasivas las
    // escuchas tactiles del documento, y ahi `preventDefault` no hace nada.
    pane.addEventListener("touchmove", blockNativeScroll, { passive: false });
    return () => {
      drag?.cancel();
      detach();
      pane.removeEventListener("touchmove", blockNativeScroll);
      pane.removeEventListener("pointerdown", down, true);
      pane.removeEventListener("click", swallowClick, true);
    };
  }, [paneRef]);
}
