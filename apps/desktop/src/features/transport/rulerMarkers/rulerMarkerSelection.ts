import {
  getSongTempoRegionAtPosition,
  type RulerMarkerPlacement,
  type RulerMarkerRef,
  type SongView,
} from "../desktopApi";
import { getBeatDurationSeconds, parseTimeSignature } from "../timeline/timelineMath";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";

/**
 * Seleccion multiple de las marcas de la regla: secciones y avisos (las dos
 * son `Marker`), tempo y compas. Logica pura sobre la cancion; lo que toca el
 * store y el motor esta en `rulerMarkerHandlers`.
 */

export type RulerMarkerEntry = RulerMarkerRef & { startSeconds: number };

/** A igual posicion, en el orden en que se leen en la regla: secciones arriba,
 * tempo y compas abajo. Solo importa para que un rango sea estable. */
const KIND_ORDER: Record<RulerMarkerRef["kind"], number> = {
  section: 0,
  tempo: 1,
  timeSignature: 2,
};

export function sameRulerMarker(a: RulerMarkerRef, b: RulerMarkerRef) {
  return a.kind === b.kind && a.id === b.id;
}

export function includesRulerMarker(list: RulerMarkerRef[], marker: RulerMarkerRef) {
  return list.some((entry) => sameRulerMarker(entry, marker));
}

/** Todas las marcas de la regla, ordenadas por posicion. */
export function listRulerMarkers(song: SongView | null | undefined): RulerMarkerEntry[] {
  if (!song) return [];
  const entries: RulerMarkerEntry[] = [
    ...song.sectionMarkers.map((marker) => ({
      kind: "section" as const,
      id: marker.id,
      startSeconds: marker.startSeconds,
    })),
    ...song.tempoMarkers.map((marker) => ({
      kind: "tempo" as const,
      id: marker.id,
      startSeconds: marker.startSeconds,
    })),
    ...song.timeSignatureMarkers.map((marker) => ({
      kind: "timeSignature" as const,
      id: marker.id,
      startSeconds: marker.startSeconds,
    })),
  ];
  return entries.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind],
  );
}

function toRef({ kind, id }: RulerMarkerEntry): RulerMarkerRef {
  return { kind, id };
}

/**
 * Shift+clic: todas las marcas entre el ancla y la pulsada, las dos incluidas
 * y de cualquier tipo. Sin ancla valida (borrada, o no la hay) es solo la
 * pulsada.
 */
export function markersBetween(
  song: SongView | null | undefined,
  anchor: RulerMarkerRef | null,
  target: RulerMarkerRef,
): RulerMarkerRef[] {
  const all = listRulerMarkers(song);
  const from = anchor ? all.findIndex((entry) => sameRulerMarker(entry, anchor)) : -1;
  const to = all.findIndex((entry) => sameRulerMarker(entry, target));
  if (to < 0) return [];
  if (from < 0) return [target];
  return all.slice(Math.min(from, to), Math.max(from, to) + 1).map(toRef);
}

/** Las marcas cuyo inicio cae en el tramo `[s0, s1]` (en cualquier orden). */
export function markersInSpan(
  song: SongView | null | undefined,
  s0: number,
  s1: number,
): RulerMarkerRef[] {
  const from = Math.min(s0, s1);
  const to = Math.max(s0, s1);
  return listRulerMarkers(song)
    .filter((entry) => entry.startSeconds >= from && entry.startSeconds <= to)
    .map(toRef);
}

/** Posicion actual de cada marca de la lista; las que ya no existen se caen. */
export function resolveRulerMarkers(
  song: SongView | null | undefined,
  markers: RulerMarkerRef[],
): RulerMarkerEntry[] {
  const all = listRulerMarkers(song);
  return markers
    .map((marker) => all.find((entry) => sameRulerMarker(entry, marker)))
    .filter((entry): entry is RulerMarkerEntry => Boolean(entry));
}

/** Ningun miembro del grupo puede quedar antes del cero. */
export function clampGroupDelta(entries: RulerMarkerEntry[], deltaSeconds: number) {
  if (entries.length === 0) return deltaSeconds;
  const earliest = Math.min(...entries.map((entry) => entry.startSeconds));
  return Math.max(deltaSeconds, -earliest);
}

/** Donde queda cada marca al mover el grupo `deltaSeconds`. */
export function groupMovePlacements(
  song: SongView | null | undefined,
  markers: RulerMarkerRef[],
  deltaSeconds: number,
): RulerMarkerPlacement[] {
  const entries = resolveRulerMarkers(song, markers);
  const delta = clampGroupDelta(entries, deltaSeconds);
  return entries.map((entry) => ({
    ...toRef(entry),
    startSeconds: entry.startSeconds + delta,
  }));
}

/** Duracion de un compas en `seconds`, con el tempo y el compas que rigen ahi. */
function barSecondsAt(song: SongView, seconds: number) {
  const region = getSongTempoRegionAtPosition(song, seconds);
  const bpm = region?.bpm ?? song.bpm;
  const timeSignature = region?.timeSignature ?? song.timeSignature;
  return (
    getBeatDurationSeconds(bpm, timeSignature) *
    parseTimeSignature(timeSignature).beatsPerBar
  );
}

/**
 * Cuanto se desplazan las copias al duplicar: lo que mide el grupo (de la
 * primera a la ultima marca) redondeado a compases ENTEROS hacia arriba, y
 * siempre al menos un compas por delante de la ultima. Asi la copia de la
 * primera nunca cae encima de la ultima, y una sola marca se copia al compas
 * siguiente. Como Ctrl+D en Ableton, pero con marcas, que no tienen largo.
 */
export function duplicateOffsetSeconds(
  song: SongView | null | undefined,
  entries: RulerMarkerEntry[],
): number {
  if (!song || entries.length === 0) return 0;
  const starts = entries.map((entry) => entry.startSeconds);
  const first = Math.min(...starts);
  const span = Math.max(...starts) - first;
  const bar = barSecondsAt(song, first);
  if (!(bar > 0)) return 0;
  const bars = Math.floor(span / bar + 1e-6) + 1;
  return bars * bar;
}

export function duplicatePlacements(
  song: SongView | null | undefined,
  markers: RulerMarkerRef[],
): RulerMarkerPlacement[] {
  const entries = resolveRulerMarkers(song, markers);
  const offset = duplicateOffsetSeconds(song, entries);
  if (offset <= 0) return [];
  return entries.map((entry) => ({
    ...toRef(entry),
    startSeconds: entry.startSeconds + offset,
  }));
}

/**
 * Clic en una marca con modificadores. Devuelve `true` si lo ha resuelto la
 * seleccion multiple; `false` deja paso a lo de siempre (seleccionar y, en
 * secciones, programar el salto).
 *
 * - Ctrl/Cmd (o el modo area en movil): pone o quita la marca, sin saltar.
 * - Shift: todas las marcas entre el ancla y esta.
 */
export function handleRulerMarkerClick(
  song: SongView | null | undefined,
  marker: RulerMarkerRef,
  modifiers: { additive: boolean; range: boolean },
): boolean {
  const store = useTimelineUIStore.getState();
  if (modifiers.range) {
    store.setSelectedMarkers(
      markersBetween(song, store.markerSelectionAnchor, marker),
    );
    return true;
  }
  if (modifiers.additive) {
    store.toggleMarkerSelection(marker);
    return true;
  }
  return false;
}

/** Hay mas de una marca seleccionada y esta es una de ellas: lo que se haga
 * sobre ella (arrastrar, menu) es sobre el grupo. */
export function groupContaining(marker: RulerMarkerRef): RulerMarkerRef[] | null {
  const selected = selectedRulerMarkers(useTimelineUIStore.getState());
  return selected.length > 1 && includesRulerMarker(selected, marker) ? selected : null;
}
