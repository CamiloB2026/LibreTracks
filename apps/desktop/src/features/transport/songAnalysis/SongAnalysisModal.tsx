import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  analyzeSongTempo,
  applySongTempoAnalysis,
  cancelAnalyzeSongTempo,
  listenToSongAnalysisProgress,
  seekTransport,
  type AnalyzeSongTempoResult,
  type SongView,
  type TransportSnapshot,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useSongStore } from "../songStore";
import {
  buildApplyPayload,
  clickTrackOptions,
  formatSongPosition,
  reviewRows,
  rowIsValid,
  type ReviewRow,
} from "./songAnalysisPlan";
import { useSongAnalysisStore } from "./songAnalysisStore";

type Phase =
  | { kind: "setup"; notice: string | null }
  | { kind: "analyzing"; fraction: number }
  | { kind: "review"; result: AnalyzeSongTempoResult }
  | { kind: "applied" }
  | { kind: "error"; message: string };

type Props = {
  /** Hands the snapshot the apply (or a seek) returns to the transport. */
  onApplied: (snapshot: TransportSnapshot) => void;
};

/**
 * "Analizar canción": read the song's click track, propose its tempo and time
 * signature markers, let the user review and edit them, apply as one undoable
 * edit. See docs/plans/song-analysis/.
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
function errorKey(message: string): string | null {
  if (message.includes("song_analysis_warp")) return "transport.songAnalysis.errorWarp";
  if (message.includes("song_analysis_varispeed")) return "transport.songAnalysis.errorVarispeed";
  return null;
}

function SongAnalysisDialog({ song, regionId, regionName, onClose, onApplied }: DialogProps) {
  const { t } = useTranslation();
  // Captured once: the list must not reshuffle under the user.
  const [{ options, preselected }] = useState(() => clickTrackOptions(song, regionId));
  const [trackId, setTrackId] = useState<string>(preselected ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "setup", notice: null });
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [include, setInclude] = useState({ tempo: true, signature: true });
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
      void cancelAnalyzeSongTempo();
      return;
    }
    onClose();
  };
  useDismissOnBack(dismiss);

  const analyze = async () => {
    if (!trackId || analyzing) return;
    setPhase({ kind: "analyzing", fraction: 0 });
    unlistenRef.current?.();
    unlistenRef.current = await listenToSongAnalysisProgress((event) => {
      setPhase((current) =>
        current.kind === "analyzing" ? { kind: "analyzing", fraction: event.fraction } : current,
      );
    });
    try {
      const result = await analyzeSongTempo({ regionId, trackIds: [trackId] });
      if (result.cancelled) {
        setPhase({ kind: "setup", notice: t("transport.songAnalysis.cancelled") });
        return;
      }
      const proposalRows = result.proposal ? reviewRows(result.proposal) : [];
      setRows(proposalRows);
      setInclude({
        tempo: proposalRows.some((row) => row.kind === "tempo"),
        signature: proposalRows.some((row) => row.kind === "signature"),
      });
      setPhase({ kind: "review", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = errorKey(message);
      setPhase({ kind: "error", message: key ? t(key) : message });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const payload = useMemo(
    () => (phase.kind === "review" ? buildApplyPayload(song, regionId, rows, include) : null),
    [phase.kind, song, regionId, rows, include],
  );
  const hasTempoRows = rows.some((row) => row.kind === "tempo");
  const hasSignatureRows = rows.some((row) => row.kind === "signature");
  const canApply =
    payload !== null &&
    !applying &&
    ((include.tempo && hasTempoRows) || (include.signature && hasSignatureRows));

  const apply = async () => {
    if (!payload || !canApply) return;
    setApplying(true);
    try {
      const snapshot = await applySongTempoAnalysis(
        regionId,
        payload.tempoMarkers,
        payload.signatureMarkers,
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
            {options.length === 0 ? (
              <p className="lt-render-hint">{t("transport.songAnalysis.noTracks")}</p>
            ) : (
              <label className="lt-settings-field">
                <span className="lt-settings-field-label">
                  {t("transport.songAnalysis.clickTrack")}
                </span>
                <select
                  value={trackId}
                  onChange={(event) => setTrackId(event.target.value)}
                >
                  {preselected ? null : (
                    <option value="" disabled>
                      {t("transport.songAnalysis.chooseClick")}
                    </option>
                  )}
                  {options.map((option) => (
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
          <SongAnalysisReview
            result={phase.result}
            rows={rows}
            include={include}
            onInclude={setInclude}
            onEdit={editRow}
            onSeek={(seconds) => void seekTo(seconds)}
          />
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
                disabled={!trackId}
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
              onClick={() => void cancelAnalyzeSongTempo()}
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

type ReviewProps = {
  result: AnalyzeSongTempoResult;
  rows: ReviewRow[];
  include: { tempo: boolean; signature: boolean };
  onInclude: (include: { tempo: boolean; signature: boolean }) => void;
  onEdit: (row: ReviewRow, text: string) => void;
  onSeek: (absoluteSeconds: number) => void;
};

function SongAnalysisReview({ result, rows, include, onInclude, onEdit, onSeek }: ReviewProps) {
  const { t } = useTranslation();
  const { analysis, proposal, regionStartSeconds } = result;
  if (!analysis || !proposal) return null;

  const songRows = rows.filter((row) => !row.restoresNextSong);
  const firstTempo = songRows.find((row) => row.kind === "tempo");
  const firstSignature = songRows.find((row) => row.kind === "signature");
  const detected = analysis.segments[0];
  const hasTempoRows = rows.some((row) => row.kind === "tempo");
  const hasSignatureRows = rows.some((row) => row.kind === "signature");

  return (
    <div className="lt-settings-modal-body lt-render-modal-body">
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
                onChange={(event) => onInclude({ ...include, tempo: event.target.checked })}
              />{" "}
              {t("transport.songAnalysis.applyTempo")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={include.signature && hasSignatureRows}
                disabled={!hasSignatureRows}
                onChange={(event) =>
                  onInclude({ ...include, signature: event.target.checked })
                }
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
                            : formatSongPosition(row.startSeconds - regionStartSeconds)}
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
                          aria-label={`${label} ${formatSongPosition(row.startSeconds - regionStartSeconds)}`}
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

      {result.missingFiles.length > 0 ? (
        <p className="lt-render-warning">
          {t("transport.songAnalysis.missingFiles", { count: result.missingFiles.length })}
        </p>
      ) : null}
    </div>
  );
}
