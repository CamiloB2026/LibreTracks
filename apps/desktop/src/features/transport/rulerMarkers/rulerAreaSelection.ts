import type { RulerMarkerRef, SongView } from "../desktopApi";
import { isMobileApp } from "../desktopApi";
import { mergeSelection } from "../mobile/areaSelection";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";
import { markersInSpan, sameRulerMarker } from "./rulerMarkerSelection";

const keyOf = (marker: RulerMarkerRef) => `${marker.kind}:${marker.id}`;

/**
 * Seleccion por area sobre la regla (movil): con el modo activo, arrastrar el
 * dedo por la regla coge todas las marcas del tramo —secciones, avisos, tempo
 * y compas— y las SUMA a lo que ya hubiera, igual que un recuadro sobre las
 * pistas. Lo que deja de tocar el tramo mientras se arrastra se suelta.
 *
 * El gesto en si (umbral, auto-scroll, pintar el tramo) lo lleva
 * `useTimelineRangeSelection`; esto solo traduce el tramo a marcas.
 */
export function createRulerAreaSelection(getSong: () => SongView | null | undefined) {
  /** Lo que habia seleccionado al empezar el gesto. */
  let base: RulerMarkerRef[] | null = null;

  const apply = (markers: RulerMarkerRef[]) => {
    const anchor = markers.at(-1);
    useTimelineUIStore.getState().setSelectedMarkers(markers, anchor);
  };

  return {
    active: () => isMobileApp && useTimelineUIStore.getState().areaSelectMode,
    update(startSeconds: number, endSeconds: number) {
      base ??= selectedRulerMarkers(useTimelineUIStore.getState());
      const hits = markersInSpan(getSong(), startSeconds, endSeconds);
      const merged = mergeSelection(base.map(keyOf), hits.map(keyOf));
      const all = [...base, ...hits];
      apply(
        merged.map((key) => all.find((marker) => keyOf(marker) === key)!),
      );
    },
    end() {
      base = null;
    },
    cancel() {
      if (base) {
        const previous = base;
        base = null;
        const current = selectedRulerMarkers(useTimelineUIStore.getState());
        const changed =
          current.length !== previous.length ||
          current.some((marker, index) => !sameRulerMarker(marker, previous[index]));
        if (changed) apply(previous);
      }
    },
  };
}
