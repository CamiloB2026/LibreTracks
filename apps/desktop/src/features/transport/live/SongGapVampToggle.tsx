import { useTranslation } from "react-i18next";

import { useTransportStore } from "../store";
import "./SongGapVampToggle.css";

type SongGapVampToggleProps = {
  enabled: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * «Vamp entre canciones»: at the end of each song the transport waits, but the
 * click keeps going at that song's tempo and the pad keeps sounding, for as
 * long as needed, until Play starts the next song. The engine does the
 * holding; this toggles the setting and, from the store, pulses while a hold
 * is sounding so the player knows why the song did not move on.
 */
export function SongGapVampToggle({
  enabled,
  onChange,
  disabled = false,
  className = "",
}: SongGapVampToggleProps) {
  const { t } = useTranslation();
  const holding = useTransportStore((state) => state.playback?.songGapVamp === true);

  return (
    <button
      type="button"
      className={`lt-song-gap-vamp${enabled ? " is-active" : ""}${holding ? " is-holding" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={enabled}
      title={holding ? t("songGapVamp.holding") : t("songGapVamp.title")}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        onChange(!enabled);
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true">all_inclusive</span>
      <span className="lt-song-gap-vamp-label">{t("songGapVamp.label")}</span>
      {/* Phones: the short label, so the live settings row keeps its room. */}
      <span className="lt-song-gap-vamp-short">{t("songGapVamp.shortLabel")}</span>
    </button>
  );
}
