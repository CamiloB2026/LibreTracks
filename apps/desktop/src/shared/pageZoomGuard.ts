/**
 * Ctrl (or Cmd) + wheel, and a trackpad pinch, which reaches the page as the
 * same wheel event, zoom the timeline when they happen over it. Anywhere else
 * nobody claims them, and the WebView's own page zoom (`zoomHotkeysEnabled`
 * in tauri.conf.json) scaled the whole app instead: menus, panels, the lot.
 *
 * This cancels that native zoom for every Ctrl + wheel the app did not handle.
 * It listens on `window` in the bubble phase, so the timeline and anything else
 * that uses the gesture get the event first, exactly as before. The app's own
 * interface zoom (Ctrl +/−/0, see uiZoom.ts) is not a wheel and is untouched.
 *
 * Returns the uninstaller.
 */
export function installPageZoomGuard(target: Window = window): () => void {
  const onWheel = (event: WheelEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.cancelable) {
      event.preventDefault();
    }
  };
  // Not passive: a passive listener may not cancel the event.
  target.addEventListener("wheel", onWheel, { passive: false });
  return () => target.removeEventListener("wheel", onWheel);
}
