import { useTranslation } from "react-i18next";

import {
  regionEffectiveKeyAt,
  regionKeySequence,
  type SongRegionSummary,
} from "../desktopApi";
import { formatClock } from "../helpers";
import { useSoundingKeyStore } from "./soundingKeyStore";
import "./keyChanges.css";

type Props = {
  /** La canción de la que se habla (la que suena, en la vista Live). */
  region: SongRegionSummary | null | undefined;
  /** Lo que se enseña si la canción no tiene nota. */
  empty?: string;
};

/**
 * La nota que suena en `region` bajo el cabezal y, cuando falta poco para un
 * cambio de nota, la siguiente ("D → E"). Sólo re-renderiza cuando cambia la
 * nota o entra el aviso (ver soundingKeyStore), nunca por frame.
 *
 * Si el cabezal no está en esta canción (está parado en otra), enseña la nota
 * con la que empieza.
 */
export function SoundingKeyLabel({ region, empty = "—" }: Props) {
  const { t } = useTranslation();
  const sounding = useSoundingKeyStore();
  if (!region) return <span>{empty}</span>;
  const here = sounding.regionId === region.id;
  const key = here
    ? sounding.key
    : regionEffectiveKeyAt(region, region.startSeconds);
  const upcoming = here ? sounding.upcoming : null;
  const modulates = regionKeySequence(region).length > 1;
  return (
    <span
      className={`lt-sounding-key${upcoming ? " has-upcoming" : ""}`}
      data-modulates={modulates ? "true" : undefined}
      title={
        upcoming
          ? t("transport.keyChanges.upcomingTitle", {
              key: upcoming.key,
              time: formatClock(upcoming.startSeconds),
            })
          : undefined
      }
    >
      {key ?? empty}
      {upcoming ? (
        <span className="lt-sounding-key-next">
          {" "}
          {t("transport.keyChanges.upcoming", { key: upcoming.key })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Todas las notas de la canción en orden ("D → E"), para donde no hay eje de
 * tiempo (la columna de la vista compacta, el remote). Con el cabezal en esta
 * canción, la que suena va resaltada y la siguiente parpadea cuando se acerca.
 * Una canción que no modula enseña sólo su nota, como siempre.
 */
export function KeySequenceLabel({ region }: { region: SongRegionSummary }) {
  const { t } = useTranslation();
  const sounding = useSoundingKeyStore();
  const sequence = regionKeySequence(region);
  if (sequence.length === 0) return null;
  const here = sounding.regionId === region.id;
  const currentIndex = here
    ? sequence.findIndex((entry) => entry.startSeconds === sounding.keyStartSeconds)
    : -1;
  const nextIndex =
    here && sounding.upcoming
      ? sequence.findIndex(
          (entry) => entry.startSeconds === sounding.upcoming?.startSeconds,
        )
      : -1;
  return (
    <span
      className="lt-key-sequence"
      title={
        sequence.length > 1
          ? `${t("transport.keyChanges.summaryTitle")}: ${sequence
              .map((entry) => `${entry.key} · ${formatClock(entry.startSeconds)}`)
              .join(" → ")}`
          : undefined
      }
    >
      {sequence.map((entry, index) => (
        <span
          key={`${entry.startSeconds}:${entry.key}`}
          className={[
            "lt-key-sequence-key",
            sequence.length > 1 && index === currentIndex ? "is-current" : "",
            index === nextIndex ? "is-next" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {index > 0 ? " → " : ""}
          {entry.key}
        </span>
      ))}
    </span>
  );
}
