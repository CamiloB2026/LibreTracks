import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongRegionSummary } from "@libretracks/shared/models";

import { songCountStyleMenuActions } from "./songCountStyle";

const updateSongRegionVoiceGuideCountStyle = vi.fn();

vi.mock("../desktopApi", () => ({
  updateSongRegionVoiceGuideCountStyle: (...args: unknown[]) =>
    updateSongRegionVoiceGuideCountStyle(...args),
}));

function region(
  voiceGuideCountStyle?: SongRegionSummary["voiceGuideCountStyle"],
): SongRegionSummary {
  return {
    id: "r1",
    name: "Way Maker",
    startSeconds: 0,
    endSeconds: 200,
    voiceGuideCountStyle,
  } as unknown as SongRegionSummary;
}

function deps() {
  return {
    t: (key: string, options?: Record<string, unknown>) =>
      options?.style ? `${key}(${String(options.style)})` : key,
    globalCountStyle: "full" as const,
    runAction: async (action: () => Promise<void>) => action(),
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
  };
}

describe("songCountStyleMenuActions", () => {
  beforeEach(() => {
    updateSongRegionVoiceGuideCountStyle.mockReset().mockResolvedValue({ revision: 2 });
  });

  it("offers the global default plus the three styles, naming the global one", () => {
    const actions = songCountStyleMenuActions(region(), deps());
    expect(actions.map((action) => action.label)).toEqual([
      "transport.menu.songCountStyleDefault(transport.settingsModal.voiceGuideCountStyleFull)",
      "transport.settingsModal.voiceGuideCountStyleFull",
      "transport.settingsModal.voiceGuideCountStyleHalfThenFull",
      "transport.settingsModal.voiceGuideCountStyleHalfTime",
    ]);
  });

  it("ticks the global entry for a song without its own style (old sessions)", () => {
    const actions = songCountStyleMenuActions(region(undefined), deps());
    expect(actions.map((action) => Boolean(action.swatch))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("ticks the song's own style", () => {
    const actions = songCountStyleMenuActions(region("halfThenFull"), deps());
    expect(actions.map((action) => Boolean(action.swatch))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("stores the chosen style for the song and applies the snapshot", async () => {
    const d = deps();
    const actions = songCountStyleMenuActions(region(), d);
    await actions[2].onSelect();
    expect(updateSongRegionVoiceGuideCountStyle).toHaveBeenCalledWith(
      "r1",
      "halfThenFull",
    );
    expect(d.applyPlaybackSnapshot).toHaveBeenCalledWith({ revision: 2 });
    expect(d.setStatus).toHaveBeenCalledTimes(1);
  });

  it("puts the song back on the global setting with null", async () => {
    const actions = songCountStyleMenuActions(region("halfTime"), deps());
    await actions[0].onSelect();
    expect(updateSongRegionVoiceGuideCountStyle).toHaveBeenCalledWith("r1", null);
  });

  it("does nothing when the current choice is picked again", async () => {
    const actions = songCountStyleMenuActions(region("halfTime"), deps());
    await actions[3].onSelect();
    expect(updateSongRegionVoiceGuideCountStyle).not.toHaveBeenCalled();
  });
});
