import { describe, expect, it, vi } from "vitest";

import type { SongView, TempoMarkerSummary } from "@libretracks/shared/models";

const setSongTempoMarkerRamp = vi.fn(async () => ({ projectRevision: 2 }) as never);
vi.mock("../desktopApi", () => ({ setSongTempoMarkerRamp }));

const { tempoRampAction } = await import("./tempoRampAction");

const marker = (id: string, startSeconds: number, bpm: number, ramp = false) =>
  ({ id, startSeconds, bpm, ramp }) as TempoMarkerSummary;

function deps(markers: TempoMarkerSummary[]) {
  return {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
    song: { tempoMarkers: markers } as SongView,
    runAction: async (work: () => Promise<void>) => work(),
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
  };
}

describe("tempoRampAction", () => {
  it("offers a ramp to the next marker and turns it on", async () => {
    const first = marker("a", 10, 60);
    const d = deps([marker("b", 20, 120), first]);
    const action = tempoRampAction(first, d);
    expect(action.label).toContain('"from":"60","to":"120"');
    expect(action.disabled).toBe(false);
    expect(action.swatch).toBeUndefined();
    await action.onSelect();
    expect(setSongTempoMarkerRamp).toHaveBeenCalledWith("a", true);
    expect(d.applyPlaybackSnapshot).toHaveBeenCalled();
  });

  it("is ticked when on, and turns it off", async () => {
    const on = marker("a", 10, 60, true);
    const action = tempoRampAction(on, deps([on, marker("b", 20, 120)]));
    expect(action.swatch).toBeDefined();
    await action.onSelect();
    expect(setSongTempoMarkerRamp).toHaveBeenLastCalledWith("a", false);
  });

  it("has nothing to ramp to from the last marker", () => {
    const last = marker("b", 20, 120);
    const action = tempoRampAction(last, deps([marker("a", 10, 60), last]));
    expect(action.label).toBe("transport.menu.tempoRampNoNext");
    expect(action.disabled).toBe(true);
  });
});
