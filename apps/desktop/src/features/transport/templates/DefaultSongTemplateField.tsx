import { useTranslation } from "react-i18next";

import { BUILTIN_BAND_TEMPLATE } from "../desktopApi";
import { useSongTemplateList } from "../hooks/useSongTemplateList";

/** "C:/x/Mi banda.lttemplate" → "Mi banda", for a saved path that is no
 * longer in the templates folder. */
function templateNameFromPath(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.lttemplate$/i, "");
}

/**
 * Settings › Project › «Plantilla para canciones nuevas».
 *
 * The options are «Ninguna», the built-in band and the `.lttemplate` files in
 * the templates folder. A saved path that is not among them anymore (the file
 * was deleted or moved) stays selected as «… (no encontrada)» with a hint:
 * the backend treats it as no template, and silently switching to another
 * one would surprise whoever picked it.
 */
export function DefaultSongTemplateField({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  const { templates, loading } = useSongTemplateList(true);
  // A saved path the scan did not list. While the scan runs it is still an
  // option (so the select shows it), just not called missing yet.
  const unlisted =
    value !== null &&
    value !== BUILTIN_BAND_TEMPLATE &&
    !templates.some((template) => template.path === value)
      ? value
      : null;
  const isMissing = unlisted !== null && !loading;

  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("songTemplates.defaultTemplate")}
      </span>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{t("songTemplates.none")}</option>
        <option value={BUILTIN_BAND_TEMPLATE}>{t("songTemplates.builtinBand")}</option>
        {templates.map((template) => (
          <option key={template.path} value={template.path}>
            {template.name}
          </option>
        ))}
        {unlisted !== null ? (
          <option value={unlisted}>
            {isMissing
              ? t("songTemplates.missing", { name: templateNameFromPath(unlisted) })
              : templateNameFromPath(unlisted)}
          </option>
        ) : null}
      </select>
      <small>
        {t(
          isMissing
            ? "songTemplates.defaultTemplateMissingHint"
            : "songTemplates.defaultTemplateHint",
        )}
      </small>
    </label>
  );
}
