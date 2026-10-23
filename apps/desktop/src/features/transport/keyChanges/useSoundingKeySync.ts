import { useEffect, type RefObject } from "react";
import { parseSongKey, type SongView } from "@libretracks/shared/models";
import { publishSoundingKey, useSoundingKeyStore } from "./soundingKeyStore";

type Options = {
  song: SongView | null;
  /** Posición del cabezal (segundos de vista), la misma ref que mueve el
   * bucle de 60 fps. */
  positionRef: RefObject<number>;
  /** "El pad sigue la nota de la canción" está activo (y el pad encendido). */
  padFollowsKey: boolean;
  padKey: number;
  onPadKeyChange: (padKey: number) => void;
};

/**
 * Mantiene al día la nota que suena cuando cambia la canción sin moverse el
 * cabezal (editar la nota, un cambio de nota, deshacer) y hace que el pad la
 * siga. Mientras el cabezal se mueve, quien publica es `syncLivePosition`.
 *
 * El pad es un bordón: sólo importa la tónica, así que Re y Rem lo dejan en
 * Re. Sólo se empuja cuando la tónica cambia, para no decodificar de más, y
 * una canción sin nota deja la del pad como esté.
 */
export function useSoundingKeySync({
  song,
  positionRef,
  padFollowsKey,
  padKey,
  onPadKeyChange,
}: Options): void {
  useEffect(() => {
    publishSoundingKey(song, positionRef.current ?? 0);
  }, [song, positionRef]);

  const key = useSoundingKeyStore((state) => state.key);
  useEffect(() => {
    if (!padFollowsKey) return;
    const tonic = parseSongKey(key)?.semitone;
    if (tonic === undefined || tonic === padKey) return;
    onPadKeyChange(tonic);
  }, [padFollowsKey, key, padKey, onPadKeyChange]);
}
