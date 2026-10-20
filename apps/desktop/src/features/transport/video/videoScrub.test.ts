import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVideoScrub } from "./videoScrub";

describe("createVideoScrub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first position at once and then at most one per interval, the newest", () => {
    const send = vi.fn(async (_position: number | null) => undefined);
    const scrub = createVideoScrub(send, 33);

    scrub.update(1);
    expect(send).toHaveBeenLastCalledWith(1);

    scrub.update(2);
    scrub.update(3);
    scrub.update(4);
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(33);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(4);
  });

  it("the end cancels a pending position and releases the output once", () => {
    const send = vi.fn(async (_position: number | null) => undefined);
    const scrub = createVideoScrub(send, 33);

    scrub.update(1);
    scrub.update(2);
    scrub.end();
    vi.advanceTimersByTime(100);

    expect(send.mock.calls).toEqual([[1], [null]]);
    scrub.end();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("an end without a drag sends nothing", () => {
    const send = vi.fn(async (_position: number | null) => undefined);
    createVideoScrub(send, 33).end();
    expect(send).not.toHaveBeenCalled();
  });
});
