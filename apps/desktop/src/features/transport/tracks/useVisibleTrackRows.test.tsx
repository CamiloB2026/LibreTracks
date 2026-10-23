import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTrackRowLayout } from "./trackLayout";
import { useVisibleTrackRows } from "./useVisibleTrackRows";

type FrameCallback = (now: number) => void;

function installManualFrames() {
  let queue: FrameCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameCallback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    flush() {
      const pending = queue;
      queue = [];
      pending.forEach((callback) => callback(0));
    },
  };
}

/** A scroll viewport with the dimensions jsdom never gives. */
function fakeViewport(clientHeight: number) {
  const element = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  document.body.appendChild(element);
  return {
    element,
    ref: { current: element },
    scrollTo(value: number) {
      scrollTop = value;
      element.dispatchEvent(new Event("scroll"));
    },
  };
}

const layoutOf = (count: number, height = 40) =>
  buildTrackRowLayout(
    Array.from({ length: count }, (_, index) => ({ id: `t${index}` })),
    height,
  );

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useVisibleTrackRows", () => {
  it("mounts every row when the viewport has no height (jsdom, hidden view)", () => {
    installManualFrames();
    const viewport = fakeViewport(0);
    const { result } = renderHook(() =>
      useVisibleTrackRows({ viewportRef: viewport.ref, layout: layoutOf(138) }),
    );
    expect(result.current).toMatchObject({ startIndex: 0, endIndex: 138, isWindowed: false });
  });

  it("mounts every row with no viewport element at all", () => {
    const { result } = renderHook(() =>
      useVisibleTrackRows({ viewportRef: { current: null }, layout: layoutOf(138) }),
    );
    expect(result.current).toMatchObject({ startIndex: 0, endIndex: 138, isWindowed: false });
  });

  it("mounts every row at or below the threshold, and when disabled", () => {
    installManualFrames();
    const viewport = fakeViewport(600);
    const small = renderHook(() =>
      useVisibleTrackRows({ viewportRef: viewport.ref, layout: layoutOf(30), minRows: 48 }),
    );
    expect(small.result.current).toMatchObject({ startIndex: 0, endIndex: 30, isWindowed: false });

    const disabled = renderHook(() =>
      useVisibleTrackRows({ viewportRef: viewport.ref, layout: layoutOf(138), enabled: false }),
    );
    expect(disabled.result.current).toMatchObject({ startIndex: 0, endIndex: 138, isWindowed: false });
  });

  it("windows a large session around the viewport, snapped to blocks", () => {
    installManualFrames();
    const viewport = fakeViewport(600);
    const { result } = renderHook(() =>
      useVisibleTrackRows({
        viewportRef: viewport.ref,
        layout: layoutOf(138),
        headerOffsetPx: 100,
        blockRows: 8,
      }),
    );
    // 500 px of rows visible + 500 px overscan below, nothing above at the top.
    expect(result.current.isWindowed).toBe(true);
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex % 8).toBe(0);
    expect(result.current.endIndex).toBeGreaterThanOrEqual(Math.ceil(1000 / 40));
    expect(result.current.endIndex).toBeLessThan(138);
  });

  it("does not re-render for scroll events inside the same block", () => {
    const frames = installManualFrames();
    const viewport = fakeViewport(600);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useVisibleTrackRows({ viewportRef: viewport.ref, layout: layoutOf(138), blockRows: 8 });
    });
    act(() => {
      viewport.scrollTo(2000);
      frames.flush();
    });
    const windowAtStart = { ...result.current };
    const rendersAtStart = renders;

    // 20 events, 6 px apart: they cross three row boundaries, never a block.
    for (let step = 1; step <= 20; step += 1) {
      act(() => {
        viewport.scrollTo(2000 + step * 6);
        frames.flush();
      });
    }

    expect(renders - rendersAtStart).toBe(0);
    expect(result.current.startIndex).toBe(windowAtStart.startIndex);

    // Crossing a block does re-render, once.
    act(() => {
      viewport.scrollTo(2600);
      frames.flush();
    });
    expect(renders - rendersAtStart).toBe(1);
    expect(result.current.startIndex).not.toBe(windowAtStart.startIndex);
  });

  it("reads the scroll offset in a frame, not in the scroll event", () => {
    const frames = installManualFrames();
    const viewport = fakeViewport(600);
    const { result } = renderHook(() =>
      useVisibleTrackRows({ viewportRef: viewport.ref, layout: layoutOf(138) }),
    );
    act(() => viewport.scrollTo(4000));
    expect(result.current.startIndex).toBe(0);
    act(() => frames.flush());
    expect(result.current.startIndex).toBeGreaterThan(0);
  });

  it("returns pinned rows that fall outside the window", () => {
    installManualFrames();
    const viewport = fakeViewport(600);
    const { result } = renderHook(() =>
      useVisibleTrackRows({
        viewportRef: viewport.ref,
        layout: layoutOf(138),
        pinnedIndices: [130, 2, 130, 500],
      }),
    );
    expect(result.current.isWindowed).toBe(true);
    // 2 is inside the window already; 500 does not exist.
    expect(result.current.pinnedIndices).toEqual([130]);
  });

  it("recomputes when the layout changes, without any scroll", () => {
    installManualFrames();
    const viewport = fakeViewport(600);
    const { result, rerender } = renderHook(
      ({ layout }) => useVisibleTrackRows({ viewportRef: viewport.ref, layout }),
      { initialProps: { layout: layoutOf(40) } },
    );
    expect(result.current).toMatchObject({ endIndex: 40, isWindowed: false });

    // 10 more rows than the threshold: windowed on the first render.
    rerender({ layout: layoutOf(58) });
    expect(result.current.isWindowed).toBe(true);
    const tallRowsEnd = result.current.endIndex;

    // Smaller base height: more rows fit in the same viewport.
    rerender({ layout: layoutOf(58, 18) });
    expect(result.current.endIndex).toBeGreaterThan(tallRowsEnd);
  });
});
