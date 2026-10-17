import type { TrackMeterMode } from "@libretracks/shared/models";
import { TRACK_METER_MODES } from "@libretracks/shared/models";
import { useTranslation } from "react-i18next";

type TrackMeterModeFieldProps = {
  mode: TrackMeterMode;
  disabled?: boolean;
  onModeChange: (mode: TrackMeterMode) => void;
};

const OPTION_KEYS: Record<TrackMeterMode, string> = {
  postFader: "transport.settingsModal.trackMeterModePostFader",
  postPan: "transport.settingsModal.trackMeterModePostPan",
  preFader: "transport.settingsModal.trackMeterModePreFader",
};

/**
 * Where the track (and folder) meters measure. Post-fader by default, like
 * Ableton: a muted track reads silent. The master meter is not affected.
 */
export function TrackMeterModeField({
  mode,
  disabled = false,
  onModeChange,
}: TrackMeterModeFieldProps) {
  const { t } = useTranslation();

  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.settingsModal.trackMeterMode")}
      </span>
      <select
        value={mode}
        disabled={disabled}
        onChange={(event) => onModeChange(event.target.value as TrackMeterMode)}
      >
        {TRACK_METER_MODES.map((option) => (
          <option key={option} value={option}>
            {t(OPTION_KEYS[option])}
          </option>
        ))}
      </select>
      <small>{t("transport.settingsModal.trackMeterModeHint")}</small>
    </label>
  );
}
