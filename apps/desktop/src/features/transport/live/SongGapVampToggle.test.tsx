import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TransportSnapshot } from "@libretracks/shared/models";

import { useTransportStore } from "../store";
import { SongGapVampToggle } from "./SongGapVampToggle";

function playback(patch: Partial<TransportSnapshot>) {
  useTransportStore.setState({
    playback: { playbackState: "paused", projectRevision: 1, ...patch } as TransportSnapshot,
  });
}

describe("SongGapVampToggle", () => {
  it("flips the setting", () => {
    playback({});
    const onChange = vi.fn();
    render(<SongGapVampToggle enabled={false} onChange={onChange} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  // Holding looks like a plain pause on the transport: the toggle is what
  // tells the player why the next song did not start.
  it("pulses while the engine holds between songs", () => {
    playback({ songGapVamp: true });
    render(<SongGapVampToggle enabled onChange={() => {}} />);
    const button = screen.getByRole("button");
    expect(button.classList.contains("is-active")).toBe(true);
    expect(button.classList.contains("is-holding")).toBe(true);
    expect(button.title).toBe("songGapVamp.holding");
  });

  it("stays calm when nothing is holding", () => {
    playback({ songGapVamp: false });
    render(<SongGapVampToggle enabled onChange={() => {}} />);
    expect(screen.getByRole("button").classList.contains("is-holding")).toBe(false);
  });
});
