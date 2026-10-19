import { cleanup } from "@testing-library/react";
import { fireEvent, render, screen } from "../../../test/testUtils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegionTempoControl } from "./RegionTempoControl";

afterEach(cleanup);

describe("RegionTempoControl", () => {
  it("adds up quick clicks before the snapshot comes back", () => {
    const onChange = vi.fn();
    render(
      <RegionTempoControl
        currentBpm={120}
        originalBpm={120}
        disabled={false}
        onChange={onChange}
      />,
    );

    const up = screen.getByRole("button", { name: "Raise the song by 1 BPM" });
    fireEvent.click(up);
    fireEvent.click(up);

    expect(onChange.mock.calls.map(([bpm]) => bpm)).toEqual([121, 122]);
  });

  it("goes back to the exact original BPM, not its rounded neighbour", () => {
    const onChange = vi.fn();
    render(
      <RegionTempoControl
        currentBpm={130}
        originalBpm={118.27}
        disabled={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Back to the song's original tempo" }),
    );

    expect(onChange).toHaveBeenCalledWith(118.27);
  });

  it("commits a typed tempo on Enter and clamps it to the engine range", () => {
    const onChange = vi.fn();
    render(
      <RegionTempoControl
        currentBpm={120}
        originalBpm={120}
        disabled={false}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Song tempo in BPM" });
    fireEvent.change(input, { target: { value: "96,5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange.mock.calls.map(([bpm]) => bpm)).toEqual([96.5, 300]);
  });
});
