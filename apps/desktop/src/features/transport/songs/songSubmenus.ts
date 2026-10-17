import type { ContextMenuAction, ContextMenuState } from "../types";
import {
  songCountStyleMenuActions,
  type SongCountStyleMenuDeps,
} from "./songCountStyle";
import { songFadeMenuActions } from "./songFades";

import type { SongRegionSummary } from "@libretracks/shared/models";

export type SongSubmenuDeps = SongCountStyleMenuDeps & {
  setContextMenu: (menu: ContextMenuState) => void;
  /** Where the submenu opens (offset from the parent menu). */
  nextPosition: () => { x: number; y: number };
};

/**
 * The song menu's per-song settings that open a submenu: "Fades ▸" and
 * "Voice guide count-in ▸". Kept out of timelineMenus.ts so the song menu
 * only lists them.
 */
export function songSettingsSubmenus(
  region: SongRegionSummary,
  deps: SongSubmenuDeps,
): ContextMenuAction[] {
  const { t } = deps;
  const submenu = (title: string, actions: () => ContextMenuAction[]) => ({
    label: `${title} ▸`,
    onSelect: () => {
      const { x, y } = deps.nextPosition();
      deps.setContextMenu({ x, y, title, actions: actions() });
    },
  });
  return [
    submenu(t("transport.menu.songFades"), () => songFadeMenuActions(region, deps)),
    submenu(t("transport.menu.songCountStyle"), () =>
      songCountStyleMenuActions(region, deps),
    ),
  ];
}
