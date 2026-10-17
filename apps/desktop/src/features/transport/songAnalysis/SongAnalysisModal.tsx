import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  analyzeSong,
  applySongAnalysis,
  cancelAnalyzeSong,
  listenToSongAnalysisProgress,
  seekTransport,
  SONG_KEY_OPTIONS,
  transposeKey,
  type AnalyzeSongResult,
  type SongView,
  type TransportSnapshot,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useSongStore } from "../songStore";
import {
  buildApplyPayload,
  clickTrackOptions,
  formatSongPosition,
  keyTrackOptions,
  reviewRows,
  rowIsValid,
  type ReviewRow,
} from "./songAnalysisPlan";
import { useSongAnalysisStore } from "./songAnalysisStore";

type Phase =
  | { kind: "setup"; notice: string | null }
  | { kind: "analyzing"; fraction: number }
  | { kind: "review"; result: AnalyzeSongResult }
  | { kind: "applied" }
  | { kind: "error"; message: string };

type Props = {
  /** Hands the snapshot the apply (or a seek) returns to the transport. */
  onApplied: (snapshot: TransportSnapshot) => void;
};

/** Below this the band counts as tuned to 440 Hz. */
const TUNING_NOTICE_CENTS = 15;

/**
 * "Analizar canción": read the song's click track (tempo and meter markers)
 * and its harmonic tracks (key), let the user review and edit the proposal,
 * apply as one undoable edit. See docs/plans/song-analysis/.
 */
export function SongAnalysisModal({ onApplied }: Props) {
  const target = useSongAnalysisStore((state) => state.target);
  const close = useSongAnalysisStore((state) => state.close);
  const song = useSongStore((state) => state.song);
  if (!target || !song || !song.regions.some((region) => region.id === target.regionId)) {
    return null;
  }
  return (
    <SongAnalysisDialog
      key={target.regionId}
      song={song}
      regionId={target.regionId}
      regionName={target.regionName}
      onClose={close}
      onApplied={onApplied}
    />
  );
}

type DialogProps = {
  song: SongView;
  regionId: string;
  regionName: string;
  onClose: () => void;
  onApplied: (snapshot: TransportSnapshot) => void;
};

/** Backend refusals that have their own message. */
function refusalKey(message: string): string | null {
  if (message.includes("song_analysis_warp")) return "transport.songAnalysis.errorWarp";
  if (message.includes("song_analysis_varispeed")) return "transport.songAnalysis.errorVarispeed";
  return null;
}

function SongAnalysisDialog({ song, regionId, regionName, onClose, onApplied }: DialogProps) {
  const { t } = useTranslation();
  // Captured once: the lists must not reshuffle under the user.
  const [{ options: clickOptions, preselected }] = useState(() =>
    clickTrackOptions(song, regionId),
  );
  const [keyOptions] = useState(() => keyTrackOptions(song, regionId));
  const [clickTrackId, setClickTrackId] = useState<string>(preselected ?? "");
  const [keyTrackIds, setKeyTrackIds] = useState<Set<string>>(
    () => new Set(keyOptions.filter((option) => option.preselected).map((option) => option.id)),
  );
  const [analyzeKeyToo, setAnalyzeKeyToo] = useState(keyOptions.length > 0);
  const [phase, setPhase] = useState<Phase>({ kind: "setup", notice: null });
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [include, setInclude] = useState({ tempo: true, signature: true, key: true });
  const [keyChoice, setKeyChoice] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      unlistenRef.current?.();
    },
    [],
  );

  const analyzing = phase.kind === "analyzing";
  const dismiss = () => {
    if (analyzing) {
      void cancelAnalyzeSong();
      return;
    }
    onClose();
  };
  useDismissOnBack(dismiss);

  const wantsKey = analyzeKeyToo && keyTrackIds.size > 0;
  const canAnalyze = clickTrackId !== "" || wantsKey;

  const analyze = async () => {
    if (!canAnalyze || analyzing) return;
    setPhase({ kind: "analyzing", fraction: 0 });
    unlistenRef.current?.();
    unlistenRef.current = await listenToSongAnalysisProgress((event) => {
      setPhase((current) =>
        current.kind === "analyzing" ? { kind: "analyzing", fraction: event.fraction } : current,
      );
    });
    try {
      const result = await analyzeSong({
        regionId,
        clickTrackIds: clickTrackId ? [clickTrackId] : [],
        // Session order, whatever order they were ticked in.
        keyTrackIds: wantsKey
          ? keyOptions.filter((option) => keyTrackIds.has(option.id)).map((option) => option.id)
          : [],
      });
      if (result.cancelled) {
        setPhase({ kind: "setup", notice: t("transport.songAnalysis.cancelled") });
        return;
      }
      const proposalRows = result.tempo ? reviewRows(result.tempo.proposal) : [];
      const detectedKey = result.key?.analysis.key ?? null;
      setRows(proposalRows);
      setKeyChoice(detectedKey ?? "");
      setInclude({
        tempo: proposalRows.some((row) => row.kind === "tempo"),
        signature: proposalRows.some((row) => row.kind === "signature"),
        key: detectedKey !== null && detectedKey !== result.key?.currentKey,
      });
      setPhase({ kind: "review", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = refusalKey(message);
      setPhase({ kind: "error", message: key ? t(key) : message });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const hasTempoRows = rows.some((row) => row.kind === "tempo");
  const hasSignatureRows = rows.some((row) => row.kind === "signature");
  const touchesTempo =
    (include.tempo && hasTempoRows) || (include.signature && hasSignatureRows);
  const tempoPayload = useMemo(
    () =>
      phase.kind === "review" && touchesTempo
        ? buildApplyPayload(song, regionId, rows, include)
        : null,
    [phase.kind, touchesTempo, song, regionId, rows, include],
  );
  const appliesKey =
    phase.kind === "review" && phase.result.key !== null && include.key && keyChoice !== "";
  const canApply =
    !applying && (touchesTempo ? tempoPayload !== null : appliesKey) && (touchesTempo || appliesKey);

  const apply = async () => {
    if (!canApply) return;
    setApplying(true);
    try {
      const snapshot = await applySongAnalysis(
        regionId,
        touchesTempo ? tempoPayload : null,
        appliesKey ? keyChoice : null,
      );
      onApplied(snapshot);
      setPhase({ kind: "applied" });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setApplying(false);
    }
  };

  const seekTo = async (absoluteSeconds: number) => {
    try {
      onApplied(await seekTransport(absoluteSeconds));
    } catch {
      // A failed seek leaves the playhead where it was; nothing to report.
    }
  };

  const editRow = (changed: ReviewRow, text: string) =>
    setRows((previous) =>
      previous.map((row) =>
        row.kind === changed.kind && row.index === changed.index ? { ...row, text } : row,
      ),
    );

  const toggleKeyTrack = (id: string) =>
    setKeyTrackIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const percent = phase.kind === "analyzing" ? Math.round(phase.fraction * 100) : 0;

  return (
    <div className="lt-modal-backdrop" onClick={analyzing ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-export-modal lt-render-modal lt-song-analysis-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-song-analysis-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{regionName}</span>
            <h2 id="lt-song-analysis-title">{t("transport.songAnalysis.title")}</h2>
            <p>{t("transport.songAnalysis.intro")}</p>
          </div>
        </header>

        {phase.kind === "setup" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            {phase.notice ? <p className="lt-render-notice">{phase.notice}</p> : null}
            {clickOptions.length === 0 ? (
              <p className="lt-render-hint">{t("transport.songAnalysis.noTracks")}</p>
            ) : (
              <>
                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">
                    {t("transport.songAnalysis.clickTrack")}
                  </span>
                  <select
                    aria-label={t("transport.songAnalysis.clickTrack")}
                    value={clickTrackId}
                    onChange={(event) => setClickTrackId(event.target.value)}
                  >
                    <option value="">{t("transport.songAnalysis.noTempo")}</option>
                    {clickOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <span className="lt-render-hint">
                    {preselected
                      ? t("transport.songAnalysis.clickTrackHint")
                      : t("transport.songAnalysis.clickTrackNotFound")}
                  </span>
                </label>

                <fieldset className="lt-render-section">
                  <legend className="lt-settings-field-label">
                    <label>
                      <input
                        type="checkbox"
                        checked={analyzeKeyToo}
                        onChange={(event) => setAnalyzeKeyToo(event.target.checked)}
                      />{" "}
                      {t("transport.songAnalysis.analyzeKey")}
                    </label>
                  </legend>
                  <p className="lt-render-hint">{t("transport.songAnalysis.keyTracksHint")}</p>
                  {analyzeKeyToo ? (
                    <ul className="lt-song-analysis-tracks">
                      {keyOptions.map((option) => (
                        <li key={option.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={keyTrackIds.has(option.id)}
                              onChange={() => toggleKeyTrack(option.id)}
                            />{" "}
                            {option.name}
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </fieldset>
              </>
            )}
          </div>
        ) : null}

        {phase.kind === "analyzing" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status">{t("transport.songAnalysis.analyzing")}</p>
            <div
              className="lt-render-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="lt-render-progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}

        {phase.kind === "review" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            {phase.result.tempoUnavailable ? (
              <p className="lt-render-warning">
                {t(
                  refusalKey(phase.result.tempoUnavailable) ??
                    "transport.songAnalysis.errorWarp",
                )}
              </p>
            ) : null}
            {phase.result.tempo ? (
              <TempoReview
                result={phase.result}
                rows={rows}
                include={include}
                onInclude={(tempo, signature) => setInclude({ ...include, tempo, signature })}
                onEdit={editRow}
                onSeek={(seconds) => void seekTo(seconds)}
              />
            ) : null}
            {phase.result.key ? (
              <KeyReview
                result={phase.result.key}
                choice={keyChoice}
                onChoice={setKeyChoice}
                included={include.key}
                onInclude={(key) => setInclude({ ...include, key })}
              />
            ) : null}
            {phase.result.missingFiles.length > 0 ? (
              <p className="lt-render-warning">
                {t("transport.songAnalysis.missingFiles", {
                  count: phase.result.missingFiles.length,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {phase.kind === "applied" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status">{t("transport.songAnalysis.applied")}</p>
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-warning">
              {t("transport.songAnalysis.failed", { error: phase.message })}
            </p>
          </div>
        ) : null}

        <div className="lt-inline-actions lt-export-modal-actions">
          {phase.kind === "setup" ? (
            <>
              <button type="button" className="lt-secondary-button" onClick={onClose}>
                {t("transport.songAnalysis.cancel")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={!canAnalyze}
                onClick={() => void analyze()}
              >
                {t("transport.songAnalysis.analyze")}
              </button>
            </>
          ) : null}
          {phase.kind === "analyzing" ? (
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => void cancelAnalyzeSong()}
            >
              {t("transport.songAnalysis.stop")}
            </button>
          ) : null}
          {phase.kind === "review" ? (
            <>
              <button
                type="button"
                className="lt-secondary-button"
                onClick={() => setPhase({ kind: "setup", notice: null })}
              >
                {t("transport.songAnalysis.back")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={!canApply}
                onClick={() => void apply()}
              >
                {t("transport.songAnalysis.apply")}
              </button>
            </>
          ) : null}
          {phase.kind === "applied" || phase.kind === "error" ? (
            <>
              {phase.kind === "error" ? (
                <button
                  type="button"
                  className="lt-secondary-button"
                  onClick={() => setPhase({ kind: "setup", notice: null })}
                >
                  {t("transport.songAnalysis.back")}
                </button>
              ) : null}
              <button type="button" className="is-primary" onClick={onClose}>
                {t("transport.songAnalysis.close")}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

type KeyReviewProps = {
  result: NonNullable<AnalyzeSongResult["key"]>;
  choice: string;
  onChoice: (key: string) => void;
  included: boolean;
  onInclude: (included: boolean) => void;
};

function KeyReview({ result, choice, onChoice, included, onInclude }: KeyReviewProps) {
  const { t } = useTranslation();
  const { analysis, currentKey, transposeSemitones } = result;
  if (!analysis.key) {
    return (
      <section className="lt-song-analysis-part">
        <h3>{t("transport.songAnalysis.key")}</h3>
        <p className="lt-render-notice">{t("transport.songAnalysis.noKey")}</p>
      </section>
    );
  }
  const sounding = transposeSemitones !== 0 ? transposeKey(choice, transposeSemitones) : null;
  const tuning = Math.round(analysis.tuningCents);
  return (
    <section className="lt-song-analysis-part">
      <h3>
        <label>
          <input
            type="checkbox"
            checked={included}
            onChange={(event) => onInclude(event.target.checked)}
          />{" "}
          {t("transport.songAnalysis.applyKey")}
        </label>
      </h3>
      <dl className="lt-song-analysis-summary">
        <div>
          <dt>{t("transport.songAnalysis.key")}</dt>
          <dd>
            {currentKey ?? "—"} →{" "}
            <select
              aria-label={t("transport.songAnalysis.key")}
              value={choice}
              disabled={!included}
              onChange={(event) => onChoice(event.target.value)}
            >
              {SONG_KEY_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </dd>
        </div>
      </dl>
      {currentKey === analysis.key ? (
        <p className="lt-render-hint">{t("transport.songAnalysis.keyUnchanged")}</p>
      ) : null}
      {analysis.alternative ? (
        <p className="lt-render-warning">
          {t(
            analysis.relativeDoubt
              ? "transport.songAnalysis.keyRelativeDoubt"
              : "transport.songAnalysis.keyDoubt",
            { key: analysis.alternative },
          )}
        </p>
      ) : null}
      {sounding ? (
        <p className="lt-render-hint">
          {t("transport.songAnalysis.keyTransposed", {
            semitones: transposeSemitones > 0 ? `+${transposeSemitones}` : transposeSemitones,
            key: sounding,
          })}
        </p>
      ) : null}
      {Math.abs(tuning) >= TUNING_NOTICE_CENTS ? (
        <p className="lt-render-hint">
          {t(
            tuning < 0
              ? "transport.songAnalysis.tuningFlat"
              : "transport.songAnalysis.tuningSharp",
            { cents: Math.abs(tuning) },
          )}
        </p>
      ) : null}
    </section>
  );
}

type TempoReviewProps = {
  result: AnalyzeSongResult;
  rows: ReviewRow[];
  include: { tempo: boolean; signature: boolean };
  onInclude: (tempo: boolean, signature: boolean) => void;
  onEdit: (row: ReviewRow, text: string) => void;
  onSeek: (absoluteSeconds: number) => void;
};

function TempoReview({ result, rows, include, onInclude, onEdit, onSeek }: TempoReviewProps) {
  const { t } = useTranslation();
  if (!result.tempo) return null;
  const { analysis, proposal } = result.tempo;
  const { regionStartSeconds } = result;

  const songRows = rows.filter((row) => !row.restoresNextSong);
  const firstTempo = songRows.find((row) => row.kind === "tempo");
  const firstSignature = songRows.find((row) => row.kind === "signature");
  const detected = analysis.segments[0];
  const hasTempoRows = rows.some((row) => row.kind === "tempo");
  const hasSignatureRows = rows.some((row) => row.kind === "signature");

  return (
    <section className="lt-song-analysis-part">
      <h3>{t("transport.songAnalysis.tempoAndMeter")}</h3>
      {analysis.segments.length > 0 && detected ? (
        <dl className="lt-song-analysis-summary">
          <div>
            <dt>{t("transport.songAnalysis.tempo")}</dt>
            <dd>
              {proposal.currentBpm} →{" "}
              <strong>{firstTempo ? firstTempo.text : detected.bpm}</strong>
            </dd>
          </div>
          <div>
            <dt>{t("transport.songAnalysis.signature")}</dt>
            <dd>
              {proposal.currentSignature} →{" "}
              <strong>
                {firstSignature
                  ? firstSignature.text
                  : `${detected.beatsPerBar}/${detected.beatUnit}`}
              </strong>
            </dd>
          </div>
          <div>
            <dt>{t("transport.songAnalysis.changes")}</dt>
            <dd>
              {t("transport.songAnalysis.segmentCount", { count: analysis.segments.length })}
            </dd>
          </div>
        </dl>
      ) : null}

      {proposal.unchanged && analysis.segments.length > 0 ? (
        <p className="lt-render-notice">{t("transport.songAnalysis.unchanged")}</p>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="lt-render-track-tools">
            <label>
              <input
                type="checkbox"
                checked={include.tempo && hasTempoRows}
                disabled={!hasTempoRows}
                onChange={(event) => onInclude(event.target.checked, include.signature)}
              />{" "}
              {t("transport.songAnalysis.applyTempo")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={include.signature && hasSignatureRows}
                disabled={!hasSignatureRows}
                onChange={(event) => onInclude(include.tempo, event.target.checked)}
              />{" "}
              {t("transport.songAnalysis.applySignature")}
            </label>
          </div>
          <div className="lt-level-songs-table-wrap">
            <table className="lt-level-songs-table lt-song-analysis-table">
              <thead>
                <tr>
                  <th>{t("transport.songAnalysis.colPosition")}</th>
                  <th>{t("transport.songAnalysis.colKind")}</th>
                  <th>{t("transport.songAnalysis.colValue")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const enabled = row.kind === "tempo" ? include.tempo : include.signature;
                  const label =
                    row.kind === "tempo"
                      ? t("transport.songAnalysis.kindTempo")
                      : t("transport.songAnalysis.kindSignature");
                  const position = formatSongPosition(row.startSeconds - regionStartSeconds);
                  return (
                    <tr
                      key={`${row.kind}-${row.index}`}
                      className={enabled ? undefined : "is-muted"}
                    >
                      <td>
                        <button
                          type="button"
                          className="lt-link-button"
                          onClick={() => onSeek(row.startSeconds)}
                        >
                          {row.restoresNextSong
                            ? t("transport.songAnalysis.nextSongStart")
                            : position}
                        </button>
                      </td>
                      <td>
                        {label}
                        {row.restoresNextSong ? (
                          <small className="lt-level-songs-note">
                            {t("transport.songAnalysis.restoresNextSong")}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode={row.kind === "tempo" ? "decimal" : "text"}
                          aria-label={`${label} ${position}`}
                          aria-invalid={!rowIsValid(row)}
                          disabled={!enabled || row.restoresNextSong}
                          value={row.text}
                          onChange={(event) => onEdit(row, event.target.value)}
                          size={6}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {analysis.warnings.length > 0 ? (
        <ul className="lt-song-analysis-warnings">
          {analysis.warnings.map((warning, index) => (
            <li key={`${warning.kind}-${index}`} className="lt-render-warning">
              {warning.kind === "noClick" ? null : (
                <button
                  type="button"
                  className="lt-link-button"
                  onClick={() => onSeek(regionStartSeconds + warning.seconds)}
                >
                  {formatSongPosition(warning.seconds)}
                </button>
              )}{" "}
              {t(`transport.songAnalysis.warning.${warning.kind}`)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
