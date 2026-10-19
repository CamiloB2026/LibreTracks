import { useEffect, useState } from "react";

import { listSessionTemplates } from "../desktopApi";

export type SongTemplateSummary = { name: string; path: string };

/**
 * The `.lttemplate` files in the templates folder, for the places that let the
 * user pick a song template (Settings, «Nueva canción desde plantilla»).
 *
 * Loaded when `enabled` turns true and again every time it does, so a
 * template saved a moment ago shows up the next time the picker opens. A
 * failed scan is an empty list: the built-in template is always offered
 * separately, so the picker is never empty.
 */
export function useSongTemplateList(enabled: boolean): {
  templates: SongTemplateSummary[];
  loading: boolean;
} {
  const [templates, setTemplates] = useState<SongTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listSessionTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { templates, loading };
}
