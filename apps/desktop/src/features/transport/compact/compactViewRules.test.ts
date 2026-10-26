import { describe, expect, it } from "vitest";

import {
  compactSongDurationSeconds,
  computeCompactWaveformDurationSeconds,
  isCompactUtilityToolbarVisible,
  isTimelineToolbarVisible,
  shouldNarrowMixerToActiveSong,
} from "./compactViewRules";

describe("shouldNarrowMixerToActiveSong", () => {
  it("narrows the compact mixer whenever the playhead is inside a song", () => {
    // Playing past the end of song A into song B publishes B as active:
    // the mixer must follow it without any card click.
    expect(shouldNarrowMixerToActiveSong("compact", "song-a")).toBe(true);
    expect(shouldNarrowMixerToActiveSong("compact", "song-b")).toBe(true);
  });

  it("leaves the mixer alone between songs and outside the compact view", () => {
    expect(shouldNarrowMixerToActiveSong("compact", "")).toBe(false);
    expect(shouldNarrowMixerToActiveSong("daw", "song-a")).toBe(false);
    expect(shouldNarrowMixerToActiveSong("live", "song-a")).toBe(false);
  });
});

describe("isCompactUtilityToolbarVisible", () => {
  it("shows the utility toolbar only while Herramientas is on", () => {
    expect(isCompactUtilityToolbarVisible("compact", true)).toBe(true);
    expect(isCompactUtilityToolbarVisible("compact", false)).toBe(false);
  });

  it("only applies to the compact view", () => {
    expect(isCompactUtilityToolbarVisible("daw", true)).toBe(false);
  });
});

describe("isTimelineToolbarVisible", () => {
  it("keeps the toolbar in DAW and hides it in Live", () => {
    expect(isTimelineToolbarVisible("daw", false)).toBe(true);
    expect(isTimelineToolbarVisible("daw", true)).toBe(true);
    expect(isTimelineToolbarVisible("live", false)).toBe(false);
    expect(isTimelineToolbarVisible("live", true)).toBe(false);
  });

  it("follows Herramientas in Compact", () => {
    expect(isTimelineToolbarVisible("compact", false)).toBe(false);
    expect(isTimelineToolbarVisible("compact", true)).toBe(true);
  });
});

describe("compact waveform duration", () => {
  it("uses the real content end instead of the fallback", () => {
    expect(
      computeCompactWaveformDurationSeconds(
        [{ endSeconds: 42 }],
        [{ timelineStartSeconds: 40, durationSeconds: 5 }],
        3600,
      ),
    ).toBe(45);
  });

  it("falls back to the song duration, never the workspace tail", () => {
    expect(
      compactSongDurationSeconds({
        regions: [],
        clips: [],
        durationSeconds: 42,
      }),
    ).toBe(42);
    expect(
      compactSongDurationSeconds({
        regions: [],
        clips: [],
        durationSeconds: 0,
      }),
    ).toBe(0.001);
    expect(compactSongDurationSeconds(null)).toBe(0);
  });
});
