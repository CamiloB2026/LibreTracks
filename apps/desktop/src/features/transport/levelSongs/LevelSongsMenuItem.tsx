import { useTranslation } from "react-i18next";

import { openLevelSongs } from "./levelSongsStore";

/**
 * "Nivelar canciones" in the mobile file-actions sheet: a list item there
 * costs no space on the phone's screen, unlike another rail or toolbar icon.
 */
export function LevelSongsMenuItem({
  disabled,
  onSelected,
}: {
  disabled: boolean;
  onSelected: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onSelected();
        openLevelSongs();
      }}
    >
      <span className="material-symbols-outlined">equalizer</span>
      {t("transport.menu.levelSongs")}
    </button>
  );
}
