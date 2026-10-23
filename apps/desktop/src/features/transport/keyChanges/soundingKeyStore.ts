import { create } from "zustand";
import {
  getSongRegionAtPosition,
  getSongTempoRegionAtPosition,
  regionKeySequence,
  regionNextKeyChange,
  type SongView,
  type SoundingKey,
} from "@libretracks/shared/models";

/**
 * La nota que suena bajo el cabezal, para las vistas que la enseñan en vivo
 * (Live, compacta) y para el pad que sigue la nota de la canción.
 *
 * El cabezal se mueve a 60 fps mutando refs (ver
 * docs/REDESIGN_transport_refs_to_stores.md); este store sólo cambia cuando
 * cambia lo que se enseña: otra canción, otra nota, o un cambio de nota que
 * entra en el aviso previo. Así nadie re-renderiza por frame.
 */
export type SoundingKeyState = {
  /** Canción bajo el cabezal ("" fuera de toda canción). */
  regionId: string;
  /** Nota que suena ahí, ya transpuesta; `null` si la canción no tiene. */
  key: string | null;
  /** Dónde empezó a regir esa nota (inicio de la canción o del cambio): una
   * canción que vuelve a una nota anterior la repite, el instante no. */
  keyStartSeconds: number | null;
  /** El próximo cambio de nota cuando falta poco para él (ver
   * `KEY_CHANGE_HEADS_UP_BARS`); `null` si no hay ninguno cerca. */
  upcoming: SoundingKey | null;
};

/** Compases de antelación con los que se avisa de un cambio de nota. */
export const KEY_CHANGE_HEADS_UP_BARS = 4;

const EMPTY: SoundingKeyState = {
  regionId: "",
  key: null,
  keyStartSeconds: null,
  upcoming: null,
};

export const useSoundingKeyStore = create<SoundingKeyState>(() => EMPTY);

/** Lo que debe enseñarse con el cabezal en `positionSeconds`. Puro. */
export function soundingKeyAt(
  song: SongView | null | undefined,
  positionSeconds: number,
): SoundingKeyState {
  const region = getSongRegionAtPosition(song, positionSeconds);
  if (!region) return EMPTY;
  const next = regionNextKeyChange(region, positionSeconds);
  let upcoming: SoundingKey | null = null;
  if (next) {
    const tempo = getSongTempoRegionAtPosition(song, positionSeconds);
    const bpm = tempo?.bpm && tempo.bpm > 0 ? tempo.bpm : 120;
    const beatsPerBar = Number.parseInt(tempo?.timeSignature ?? "4/4", 10) || 4;
    const headsUpSeconds = (KEY_CHANGE_HEADS_UP_BARS * beatsPerBar * 60) / bpm;
    if (next.startSeconds - positionSeconds <= headsUpSeconds) upcoming = next;
  }
  const sequence = regionKeySequence(region);
  const sounding =
    sequence.filter((entry) => entry.startSeconds <= positionSeconds + 1e-6).at(-1) ??
    sequence[0] ??
    null;
  return {
    regionId: region.id,
    key: sounding?.key ?? null,
    keyStartSeconds: sounding?.startSeconds ?? null,
    upcoming,
  };
}

function sameState(left: SoundingKeyState, right: SoundingKeyState): boolean {
  return (
    left.regionId === right.regionId &&
    left.key === right.key &&
    left.keyStartSeconds === right.keyStartSeconds &&
    left.upcoming?.key === right.upcoming?.key &&
    left.upcoming?.startSeconds === right.upcoming?.startSeconds
  );
}

/** Publica la nota bajo el cabezal; no toca el store si nada cambió. */
export function publishSoundingKey(
  song: SongView | null | undefined,
  positionSeconds: number,
): void {
  const next = soundingKeyAt(song, positionSeconds);
  if (!sameState(useSoundingKeyStore.getState(), next)) {
    useSoundingKeyStore.setState(next, true);
  }
}
