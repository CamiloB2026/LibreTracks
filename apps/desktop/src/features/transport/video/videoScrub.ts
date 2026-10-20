import { setVideoScrub } from "../desktopApi";

/**
 * The video output follows the playhead while it is dragged, before the seek
 * is committed on release (without this the picture only moved on release).
 *
 * At most one position per `intervalMs`, always the newest: mpv shows about
 * 28 exact frames a second when sought this fast (measured), so sending every
 * pointer move would only queue seeks it drops anyway. The last position of a
 * burst is always sent (trailing), so the picture lands where the pointer
 * stopped.
 */
export function createVideoScrub(
  send: (positionSeconds: number | null) => Promise<void> = setVideoScrub,
  intervalMs = 33,
) {
  let active = false;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;

  const flush = () => {
    timer = null;
    if (pending === null) return;
    const position = pending;
    pending = null;
    lastSentAt = Date.now();
    void send(position).catch(() => undefined);
  };

  return {
    /** The playhead is at `positionSeconds` (view seconds) mid-drag. */
    update(positionSeconds: number) {
      active = true;
      pending = positionSeconds;
      if (timer !== null) return;
      const wait = Math.max(0, intervalMs - (Date.now() - lastSentAt));
      if (wait === 0) {
        flush();
      } else {
        timer = setTimeout(flush, wait);
      }
    },
    /** The drag is over: the output goes back to the transport. Call it AFTER
     * the committing seek, or the picture blinks back to where the transport
     * was before landing on the new position. */
    end() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      if (!active) return;
      active = false;
      void send(null).catch(() => undefined);
    },
  };
}

/** The one the playhead uses: there is one playhead drag at a time. */
export const playheadVideoScrub = createVideoScrub((positionSeconds) =>
  setVideoScrub(positionSeconds),
);
