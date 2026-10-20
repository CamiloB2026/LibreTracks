import { useCallback } from "react";

import { isMobileApp } from "@libretracks/shared/desktopApi";

import type { ShortcutActionId } from "./actions";
import { formatBindingForDisplay, isMacPlatform } from "./keybinding";
import { resolveBindings, useKeybindingStore } from "./keybindingStore";

// Small hook that returns a formatter mapping an action id to its current,
// display-ready shortcut string (respecting the user's overrides). Used to show
// the key next to context-menu items, Reaper-style, so shortcuts are
// discoverable without opening Settings. Returns "" for unbound actions —
// and for everything on Android, where there is no physical keyboard to hint.
/** Lo mismo leido en el momento, para quien no es un componente (las
 * factories de handlers que montan su menu al abrirlo). */
export function shortcutHintNow(actionId: ShortcutActionId): string {
  if (isMobileApp) {
    return "";
  }
  const binding =
    resolveBindings(useKeybindingStore.getState().overrides)[actionId] ?? null;
  return formatBindingForDisplay(binding, isMacPlatform());
}

export function useShortcutHint(): (actionId: ShortcutActionId) => string {
  const overrides = useKeybindingStore((state) => state.overrides);
  return useCallback(
    (actionId: ShortcutActionId) => {
      if (isMobileApp) {
        return "";
      }
      const binding = resolveBindings(overrides)[actionId] ?? null;
      return formatBindingForDisplay(binding, isMacPlatform());
    },
    [overrides],
  );
}
