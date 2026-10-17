import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, type AppSettings } from "@libretracks/shared/models";
import { VoiceGuidePopover } from "./VoiceGuidePopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("./PopoverShell", () => ({
  PopoverShell: ({ children }: { children: React.ReactNode }) => children,
}));

function renderPopover(settings: Partial<AppSettings>, onChange = vi.fn()) {
  render(
    <VoiceGuidePopover
      open
      anchorRef={createRef<HTMLButtonElement>()}
      settings={{ ...DEFAULT_APP_SETTINGS, voiceGuideEnabled: true, ...settings }}
      routeOptions={[]}
      onClose={vi.fn()}
      onChange={onChange}
      onVolumeDraftChange={vi.fn()}
      onCommitVolume={vi.fn()}
    />,
  );
  return onChange;
}

const styleSelect = () =>
  screen.getByRole("combobox", {
    name: "transport.settingsModal.voiceGuideCountStyle",
  }) as HTMLSelectElement;

describe("VoiceGuidePopover count style", () => {
  it("defaults to the plain 1-2-3-4 count", () => {
    renderPopover({});
    expect(styleSelect().value).toBe("full");
    expect(
      Array.from(styleSelect().options).map((option) => option.value),
    ).toEqual(["full", "halfThenFull", "halfTime"]);
  });

  it("sends the chosen style as a settings patch", () => {
    const onChange = renderPopover({});
    fireEvent.change(styleSelect(), { target: { value: "halfThenFull" } });
    expect(onChange).toHaveBeenCalledWith({ voiceGuideCountStyle: "halfThenFull" });
  });

  it("is disabled while the count-in is off (the style would change nothing)", () => {
    renderPopover({ voiceGuideCountInEnabled: false });
    expect(styleSelect().disabled).toBe(true);
  });
});
