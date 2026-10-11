import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";
import type { WaveformSummaryDto } from "../desktopApi";
import { useSongWaveforms } from "./useSongWaveforms";

const requested: string[][] = [];

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    getWaveformSummaries: async (keys: string[]) => {
      requested.push(keys);
      return keys.map(summary);
    },
  };
});

function summary(waveformKey: string): WaveformSummaryDto {
  return { waveformKey, version: 1, durationSeconds: 30, sampleRate: 48_000, lods: [] };
}

/** A song view as the loader sees it: an id, clips and no embedded peaks. */
function songView(id: string, keys: string[], edit = 0): SongView {
  return {
    id,
    title: `edit ${edit}`,
    clips: keys.map((waveformKey, index) => ({ id: `c${index}`, waveformKey })),
    waveforms: [],
  } as unknown as SongView;
}

function mount() {
  let cache: Record<string, WaveformSummaryDto> = {};
  const setWaveformCache = (
    update: (current: Record<string, WaveformSummaryDto>) => Record<string, WaveformSummaryDto>,
  ) => {
    cache = update(cache);
  };
  const hook = renderHook(
    ({ song, projectKey }: { song: SongView | null; projectKey: string }) =>
      useSongWaveforms({ song, projectKey, setWaveformCache }),
    { initialProps: { song: songView("s1", ["a", "b"]), projectKey: "D:/demo" } },
  );
  return { hook, cache: () => cache };
}

describe("useSongWaveforms", () => {
  beforeEach(() => {
    requested.length = 0;
  });

  it("does not request again what an earlier run of the same song delivered", async () => {
    const { hook, cache } = mount();
    await waitFor(() => expect(Object.keys(cache())).toEqual(["a", "b"]));
    expect(requested).toEqual([["a", "b"]]);

    // An edit (warp, key change…) hands the loader a new song object with one
    // new source: only that one is asked for.
    hook.rerender({ song: songView("s1", ["a", "b", "c"], 1), projectKey: "D:/demo" });
    await waitFor(() => expect(Object.keys(cache())).toContain("c"));
    expect(requested).toEqual([["a", "b"], ["c"]]);
  });

  it("requests everything again for another song or session", async () => {
    const { hook, cache } = mount();
    await waitFor(() => expect(Object.keys(cache())).toEqual(["a", "b"]));

    hook.rerender({ song: songView("s2", ["a"]), projectKey: "D:/demo" });
    await waitFor(() => expect(requested).toHaveLength(2));
    expect(requested[1]).toEqual(["a"]);

    hook.rerender({ song: songView("s2", ["a"], 1), projectKey: "D:/other" });
    await waitFor(() => expect(requested).toHaveLength(3));
    expect(requested[2]).toEqual(["a"]);
  });
});
