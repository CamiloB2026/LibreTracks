import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoAssetSummary } from "../desktopApi";
import { VideoLibrarySection } from "./VideoLibrarySection";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

const asset = {
  fileName: "intro.mp4",
  filePath: "D:/intro.mp4",
  isMissing: false,
  folderPath: null,
  hasSlowSeeks: false,
  info: {
    durationSeconds: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    rotationDegrees: 0,
    codec: "h264",
    hardwareDecode: true,
    hasAudio: false,
    keyframeIntervalSeconds: 2,
  },
} as VideoAssetSummary;

beforeEach(() => {
  useVideoStore.setState({ ...INITIAL_VIDEO_STATE, assets: [asset] });
});

describe("VideoLibrarySection", () => {
  it("takes a video out of the library with the Delete key", () => {
    const deleteAssets = vi.fn();
    useVideoStore.setState({ deleteAssets });
    render(<VideoLibrarySection />);

    fireEvent.keyDown(screen.getByRole("button", { name: "intro.mp4" }), { key: "Delete" });

    expect(deleteAssets).toHaveBeenCalledWith([asset]);
  });

  it("hands the right click to the library panel's context menu", () => {
    const onAssetContextMenu = vi.fn();
    render(<VideoLibrarySection onAssetContextMenu={onAssetContextMenu} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "intro.mp4" }));

    expect(onAssetContextMenu).toHaveBeenCalledWith(expect.anything(), asset);
  });
});
