import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  listenToTemplateDropSummary,
  undoAction,
  type TemplateDropSummary,
  type TransportSnapshot,
} from "../desktopApi";

/** How long the toast stays up; long enough to read it and reach «Deshacer». */
const TOAST_MS = 8000;

/**
 * «12 audios organizados con la plantilla · 2 sin regla — Deshacer».
 *
 * The backend fires the summary only for drops a song template organised, so
 * this stays silent for everyone who does not use templates. Undo is the
 * ordinary undo: the whole drop, template tracks included, is one step.
 *
 * Mounted always; renders nothing until a summary arrives.
 */
export function TemplateDropToast({
  onUndone,
}: {
  onUndone: (snapshot: TransportSnapshot) => void;
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<TemplateDropSummary | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenToTemplateDropSummary((next) => {
      setSummary(next);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setSummary(null), TOAST_MS);
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      // Without the Tauri event bridge (jsdom, a plain browser) there is
      // nothing to listen to; that is not an error worth surfacing.
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, []);

  if (!summary || summary.matched === 0) {
    return null;
  }

  const close = () => setSummary(null);
  return (
    <div className="lt-template-drop-toast" role="status">
      <span className="material-symbols-outlined" aria-hidden="true">
        auto_awesome_mosaic
      </span>
      <span className="lt-template-drop-toast-text">
        {t("songTemplates.dropSummary", { count: summary.matched })}
        {summary.unmatched > 0
          ? ` · ${t("songTemplates.dropUnmatched", { count: summary.unmatched })}`
          : ""}
      </span>
      <button
        type="button"
        className="lt-link-button"
        onClick={() => {
          close();
          // A failed undo leaves the session as it was; the toast is already
          // gone and Ctrl+Z is still there, so nothing to report here.
          void undoAction().then(onUndone, () => {});
        }}
      >
        {t("songTemplates.undo")}
      </button>
      <button
        type="button"
        className="lt-icon-button lt-template-drop-toast-close"
        aria-label={t("songTemplates.dismiss")}
        onClick={close}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          close
        </span>
      </button>
    </div>
  );
}
