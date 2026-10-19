import { useLayoutEffect, useState, type RefObject } from "react";

import { getUiZoom } from "../../../shared/uiZoom";

export type ClampedMenuPosition = {
  left: number;
  top: number;
  maxHeight?: number;
};

/**
 * Keep a context menu anchored at (anchorX, anchorY) fully on-screen: opening
 * near the bottom/right edge would clip the lower actions so they can't be
 * clicked. Measures after mount, flips the menu above/left of the anchor when
 * there is more room there, and caps its height to the available space (the
 * CSS makes the body scroll) so it never spills off the viewport.
 *
 * `trigger` is whatever identifies the open menu (the menu state object): a
 * new one re-measures even if the anchor didn't move (e.g. a submenu with more
 * entries replacing its parent in place).
 */
export function useViewportClampedMenu(
  menuRef: RefObject<HTMLElement | null>,
  trigger: unknown,
  anchorX: number,
  anchorY: number,
): ClampedMenuPosition {
  const [position, setPosition] = useState<ClampedMenuPosition>({
    left: anchorX,
    top: anchorY,
  });

  useLayoutEffect(() => {
    if (!trigger) {
      return;
    }
    setPosition({ left: anchorX, top: anchorY });
    const element = menuRef.current;
    if (!element || typeof window === "undefined") {
      return;
    }
    // anchorX/Y are in the zoomed element space; rect/innerWidth are real
    // viewport pixels. Convert the anchor to viewport space to reason about
    // available room, then convert the final position back by dividing by zoom.
    const zoom = getUiZoom() || 1;
    const margin = 8;
    const rect = element.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const anchorViewportX = anchorX * zoom;
    const anchorViewportY = anchorY * zoom;

    // Horizontal: flip left of the anchor when it would overflow the right.
    let leftViewport = anchorViewportX;
    if (leftViewport + rect.width + margin > viewportW) {
      leftViewport = Math.max(margin, anchorViewportX - rect.width);
    }
    leftViewport = Math.max(
      margin,
      Math.min(leftViewport, viewportW - rect.width - margin),
    );

    // Vertical: choose whichever side of the anchor has more room, then cap the
    // height to that side so a very tall menu scrolls instead of overflowing.
    const roomBelow = viewportH - anchorViewportY - margin;
    const roomAbove = anchorViewportY - margin;
    let topViewport: number;
    let maxHeight: number;
    if (rect.height <= roomBelow || roomBelow >= roomAbove) {
      topViewport = anchorViewportY;
      maxHeight = roomBelow;
    } else {
      maxHeight = roomAbove;
      topViewport = Math.max(margin, anchorViewportY - Math.min(rect.height, roomAbove));
    }

    setPosition({
      left: leftViewport / zoom,
      top: topViewport / zoom,
      maxHeight: maxHeight / zoom,
    });
  }, [menuRef, trigger, anchorX, anchorY]);

  return position;
}
