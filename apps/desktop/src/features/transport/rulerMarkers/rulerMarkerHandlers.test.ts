import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "../desktopApi";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";

const moveRulerMarkers = vi.fn();
const duplicateRulerMarkers = vi.fn();
const deleteRulerMarkers = vi.fn();
const platform = { mobile: false };

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  get isMobileApp() {
    return platform.mobile;
  },
  moveRulerMarkers: (...args: unknown[]) => moveRulerMarkers(...args),
  duplicateRulerMarkers: (...args: unknown[]) => duplicateRulerMarkers(...args),
  deleteRulerMarkers: (...args: unknown[]) => deleteRulerMarkers(...args),
}));

const { createRulerMarkerHandlers } = await import("./rulerMarkerHandlers");

/** 120 BPM 4/4: un compás son 2 s. */
const SONG = {
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 60,
  regions: [],
  sectionMarkers: [
    { id: "s1", name: "Intro", startSeconds: 2 },
    { id: "s2", name: "Verse", startSeconds: 6 },
  ],
  tempoMarkers: [{ id: "t1", startSeconds: 4, bpm: 100 }],
  timeSignatureMarkers: [],
} as unknown as SongView;

/** La canción tras duplicar s1 (2 s) y t1 (4 s): el grupo mide un compás
 * justo, así que las copias van dos compases (4 s) más allá. */
const SONG_AFTER_DUPLICATE = {
  ...SONG,
  sectionMarkers: [
    ...SONG.sectionMarkers,
    { id: "s1-copy", name: "Intro", startSeconds: 6 },
  ],
  tempoMarkers: [...SONG.tempoMarkers, { id: "t1-copy", startSeconds: 8, bpm: 100 }],
} as unknown as SongView;

function handlers() {
  const deps = {
    getSong: () => SONG,
    runAction: async (work: () => Promise<void>) => work(),
    applyPlaybackSnapshot: vi.fn(),
    refreshSongView: vi.fn(async () => SONG_AFTER_DUPLICATE),
    setStatus: vi.fn(),
    t: (key: string) => key,
  };
  return { deps, handlers: createRulerMarkerHandlers(deps) };
}

const s = (id: string) => ({ kind: "section" as const, id });
const tempo = (id: string) => ({ kind: "tempo" as const, id });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  platform.mobile = false;
  useTimelineUIStore.getState().clearSelection();
});

describe("acciones sobre un grupo de marcas", () => {
  it("mover manda TODAS en una llamada, con sus posiciones nuevas", async () => {
    const { handlers: h } = handlers();
    h.moveGroup([s("s1"), tempo("t1")], 1);
    await flush();
    expect(moveRulerMarkers).toHaveBeenCalledTimes(1);
    expect(moveRulerMarkers).toHaveBeenCalledWith([
      { ...s("s1"), startSeconds: 3 },
      { ...tempo("t1"), startSeconds: 5 },
    ]);
  });

  it("duplicar deja seleccionadas las copias, para que Ctrl+D encadene", async () => {
    const { handlers: h } = handlers();
    useTimelineUIStore.getState().setSelectedMarkers([s("s1"), tempo("t1")]);
    expect(h.duplicateSelected()).toBe(true);
    await flush();
    expect(duplicateRulerMarkers).toHaveBeenCalledWith([
      { ...s("s1"), startSeconds: 6 },
      { ...tempo("t1"), startSeconds: 8 },
    ]);
    expect(selectedRulerMarkers(useTimelineUIStore.getState())).toEqual([
      s("s1-copy"),
      tempo("t1-copy"),
    ]);
  });

  it("Supr borra lo seleccionado, una o varias, en una llamada", async () => {
    const { handlers: h } = handlers();
    useTimelineUIStore.getState().selectSection("s2");
    expect(h.deleteSelected()).toBe(true);
    await flush();
    expect(deleteRulerMarkers).toHaveBeenCalledWith([s("s2")]);
    expect(selectedRulerMarkers(useTimelineUIStore.getState())).toEqual([]);
  });

  it("sin marcas seleccionadas el teclado sigue a lo suyo", () => {
    const { handlers: h } = handlers();
    expect(h.deleteSelected()).toBe(false);
    expect(h.duplicateSelected()).toBe(false);
    expect(deleteRulerMarkers).not.toHaveBeenCalled();
  });

  it("el menu del grupo duplica y borra el grupo entero", async () => {
    const { handlers: h } = handlers();
    const [duplicate, remove] = h.groupMenu([s("s1"), s("s2")]);
    await remove.onSelect();
    await flush();
    expect(deleteRulerMarkers).toHaveBeenCalledWith([s("s1"), s("s2")]);
    // El atajo es el configurado, no uno escrito a mano.
    expect(duplicate.shortcut).toMatch(/D$/);
  });
});

describe("arrastrar por la regla en el modo area del movil", () => {
  it("suma las marcas del tramo a lo que ya habia", () => {
    platform.mobile = true;
    const { handlers: h } = handlers();
    useTimelineUIStore.setState({ areaSelectMode: true });
    useTimelineUIStore.getState().selectSection("s2");
    expect(h.area.active()).toBe(true);

    h.area.update(1, 3);
    expect(selectedRulerMarkers(useTimelineUIStore.getState())).toEqual([s("s2"), s("s1")]);
    // Mientras se arrastra, lo que deja de tocar el tramo se suelta...
    h.area.update(1, 5);
    h.area.update(3.5, 5);
    expect(selectedRulerMarkers(useTimelineUIStore.getState())).toEqual([s("s2"), tempo("t1")]);
    h.area.end();
  });

  it("cancelado vuelve a lo de antes", () => {
    platform.mobile = true;
    const { handlers: h } = handlers();
    useTimelineUIStore.getState().selectSection("s2");
    h.area.update(1, 5);
    h.area.cancel();
    expect(selectedRulerMarkers(useTimelineUIStore.getState())).toEqual([s("s2")]);
  });

  it("fuera del modo, o en escritorio, no hace nada", () => {
    const { handlers: h } = handlers();
    useTimelineUIStore.setState({ areaSelectMode: true });
    expect(h.area.active()).toBe(false);
    platform.mobile = true;
    useTimelineUIStore.setState({ areaSelectMode: false });
    expect(h.area.active()).toBe(false);
  });
});
