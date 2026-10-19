import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatBpm } from "../desktopApi";

export const REGION_TEMPO_MIN_BPM = 20;
export const REGION_TEMPO_MAX_BPM = 300;

export function clampRegionTempo(bpm: number) {
  const clamped = Math.max(
    REGION_TEMPO_MIN_BPM,
    Math.min(REGION_TEMPO_MAX_BPM, bpm),
  );
  return Math.round(clamped * 10) / 10;
}

type RegionTempoControlProps = {
  /** Tempo the song plays at now (effective BPM at its start). */
  currentBpm: number;
  /** Tempo the audio was recorded at: warp's source BPM, or the current
      tempo while warp is still off. "Original" goes back to it. */
  originalBpm: number;
  disabled: boolean;
  onChange: (nextBpm: number) => void;
};

/**
 * Speed up / slow down the selected song from the Warp popover. Each change
 * goes through `set_song_region_tempo`, which turns warp on if needed, so the
 * user never has to touch tempo markers or the source BPM by hand.
 *
 * The draft keeps the value the user is heading to, so two quick clicks on
 * "+" add 2 BPM even if the first snapshot has not arrived yet.
 */
export function RegionTempoControl({
  currentBpm,
  originalBpm,
  disabled,
  onChange,
}: RegionTempoControlProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(currentBpm);
  const [inputText, setInputText] = useState(() => formatBpm(currentBpm));

  useEffect(() => {
    setDraft(currentBpm);
    setInputText(formatBpm(currentBpm));
  }, [currentBpm]);

  // `exact` skips the 0.1 rounding: "Original" must land on the source BPM
  // itself (ratio exactly 1), not on its rounded neighbour.
  const commit = (bpm: number, exact = false) => {
    const next = exact ? bpm : clampRegionTempo(bpm);
    setDraft(next);
    setInputText(formatBpm(next));
    if (Math.abs(next - currentBpm) >= 0.005) onChange(next);
  };

  const commitInput = () => {
    const parsed = Number(inputText.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setInputText(formatBpm(draft));
      return;
    }
    commit(parsed);
  };

  const percent =
    originalBpm > 0 ? Math.round((draft / originalBpm - 1) * 1000) / 10 : 0;
  const atOriginal = Math.abs(draft - originalBpm) < 0.005;

  return (
    <div className="lt-region-tempo-control">
      <label className="lt-stepper-control">
        <span>{t("timelineToolbar.regionTempoLabel")}</span>
        <div className="lt-stepper-control-row">
          <button
            type="button"
            aria-label={t("timelineToolbar.regionTempoDownAria")}
            disabled={disabled || draft <= REGION_TEMPO_MIN_BPM}
            onClick={() => commit(draft - 1)}
          >
            -
          </button>
          <input
            aria-label={t("timelineToolbar.regionTempoAria")}
            type="text"
            inputMode="decimal"
            value={inputText}
            disabled={disabled}
            onChange={(event) => setInputText(event.target.value)}
            onBlur={commitInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitInput();
              } else if (event.key === "Escape") {
                setInputText(formatBpm(draft));
              }
            }}
          />
          <button
            type="button"
            aria-label={t("timelineToolbar.regionTempoUpAria")}
            disabled={disabled || draft >= REGION_TEMPO_MAX_BPM}
            onClick={() => commit(draft + 1)}
          >
            +
          </button>
          <button
            type="button"
            aria-label={t("timelineToolbar.regionTempoResetAria")}
            disabled={disabled || atOriginal}
            onClick={() => commit(originalBpm, true)}
          >
            {t("timelineToolbar.regionTempoReset")}
          </button>
        </div>
      </label>
      <small className="lt-warp-semantics-hint">
        {atOriginal
          ? t("timelineToolbar.regionTempoHintOriginal", {
              bpm: formatBpm(originalBpm),
            })
          : t("timelineToolbar.regionTempoHintChanged", {
              bpm: formatBpm(originalBpm),
              percent: `${percent > 0 ? "+" : ""}${percent}`,
            })}
      </small>
    </div>
  );
}
