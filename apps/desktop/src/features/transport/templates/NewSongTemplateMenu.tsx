import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { BUILTIN_BAND_TEMPLATE, NO_SONG_TEMPLATE } from "../desktopApi";
import { useSongTemplateList } from "../hooks/useSongTemplateList";

/**
 * The arrow next to «+ Nueva canción»: create the next song from a template
 * picked here instead of the default one in Settings — or, with «Sin
 * plantilla», empty even when there is a default.
 */
export function NewSongTemplateMenu({
  onCreate,
}: {
  onCreate: (templateReference: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { templates } = useSongTemplateList(open);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (reference: string) => {
    setOpen(false);
    onCreate(reference);
  };

  return (
    <div className="lt-new-song-template" ref={rootRef}>
      <button
        type="button"
        className="lt-compact-view-add-song lt-new-song-template-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("songTemplates.newSongFromTemplate")}
        title={t("songTemplates.newSongFromTemplate")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          arrow_drop_down
        </span>
      </button>
      {open ? (
        <div className="lt-new-song-template-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => choose(NO_SONG_TEMPLATE)}>
            {t("songTemplates.noTemplate")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(BUILTIN_BAND_TEMPLATE)}
          >
            {t("songTemplates.builtinBand")}
          </button>
          {templates.map((template) => (
            <button
              key={template.path}
              type="button"
              role="menuitem"
              title={template.path}
              onClick={() => choose(template.path)}
            >
              {template.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
