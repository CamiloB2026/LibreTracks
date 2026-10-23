import type { TransportSnapshot } from "@libretracks/shared/models";

/**
 * How long each polled transport snapshot took to arrive.
 *
 * The visual clock compares a snapshot's position with where the playhead is
 * drawn NOW, but the engine sampled that position somewhere inside the poll's
 * round trip. When the UI is busy that trip runs to hundreds of ms, and without
 * knowing it the clock read the late position as the engine falling behind:
 * the playhead snapped back, then forward on the next prompt poll. See
 * resolveVisualClockResync's `snapshotAgeSeconds`.
 *
 * Keyed by the snapshot object itself, which flows unchanged from the poll to
 * the store and the anchor logic. Snapshots from anywhere else (seek results,
 * lifecycle events) are simply unknown and count as fresh.
 */
const roundTripMsBySnapshot = new WeakMap<TransportSnapshot, number>();

export function rememberSnapshotRoundTrip(
  snapshot: TransportSnapshot | null,
  roundTripMs: number,
) {
  if (snapshot) {
    roundTripMsBySnapshot.set(snapshot, roundTripMs);
  }
}

export function snapshotAgeSeconds(snapshot: TransportSnapshot): number {
  return (roundTripMsBySnapshot.get(snapshot) ?? 0) / 1000;
}
