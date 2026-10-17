import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from "@libretracks/shared/models";
import en from "../../../shared/i18n/en";
import es from "../../../shared/i18n/es";
import { TrackMeterModeField } from "./TrackMeterModeField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("offers the three metering points and reports the chosen one", () => {
  const onModeChange = vi.fn();
  render(<TrackMeterModeField mode="postFader" onModeChange={onModeChange} />);

  const select = screen.getByRole("combobox", {
    name: /transport\.settingsModal\.trackMeterMode/,
  }) as HTMLSelectElement;
  expect(select.value).toBe("postFader");
  expect(Array.from(select.options).map((option) => option.value)).toEqual([
    "postFader",
    "postPan",
    "preFader",
  ]);

  fireEvent.change(select, { target: { value: "preFader" } });
  expect(onModeChange).toHaveBeenCalledWith("preFader");
});

it("defaults to post-fader, also for settings saved before it existed", () => {
  expect(DEFAULT_APP_SETTINGS.trackMeterMode).toBe("postFader");
  const { trackMeterMode: _omitted, ...legacy } = DEFAULT_APP_SETTINGS;
  expect(normalizeAppSettings(legacy as typeof DEFAULT_APP_SETTINGS).trackMeterMode).toBe(
    "postFader",
  );
  expect(
    normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      trackMeterMode: "bogus" as never,
    }).trackMeterMode,
  ).toBe("postFader");
  expect(
    normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, trackMeterMode: "postPan" })
      .trackMeterMode,
  ).toBe("postPan");
});

it("is translated in Spanish and English", () => {
  for (const dictionary of [en, es]) {
    const modal = dictionary.transport.settingsModal;
    expect(modal.trackMeterMode).toBeTruthy();
    expect(modal.trackMeterModeHint).toBeTruthy();
    expect(modal.trackMeterModePostFader).toBeTruthy();
    expect(modal.trackMeterModePostPan).toBeTruthy();
    expect(modal.trackMeterModePreFader).toBeTruthy();
    expect(dictionary.transport.status.trackMeterModeUpdated).toBeTruthy();
  }
});
