// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipSummary } from "../desktopApi";
import { buildTrackRowLayout } from "../tracks/trackLayout";
import {
  AreaSelectionDrag,
  clipsInArea,
  mergeSelection,
  rowsInBand,
  type AreaRow,
} from "./areaSelection";

const rows: AreaRow[] = [
  { id: "gtr1", top: 0, bottom: 50 },
  { id: "bass", top: 50, bottom: 100 },
  { id: "gtr2", top: 100, bottom: 150 },
];

function clip(id: string, start: number, duration: number): ClipSummary {
  return { id, timelineStartSeconds: start, durationSeconds: duration } as ClipSummary;
}

describe("geometria del recuadro", () => {
  it("una fila tocada en parte cuenta: exigirla entera es imposible con el dedo", () => {
    expect(rowsInBand(rows, 40, 110)).toEqual(["gtr1", "bass", "gtr2"]);
    // El sentido del arrastre da igual.
    expect(rowsInBand(rows, 110, 40)).toEqual(["gtr1", "bass", "gtr2"]);
    // Rozar el borde exacto no es tocar.
    expect(rowsInBand(rows, 50, 60)).toEqual(["bass"]);
  });

  it("los clips cuentan si el recuadro los toca, en las filas que cubre", () => {
    const clipsByTrack = {
      gtr1: [clip("a", 0, 2), clip("b", 10, 2)],
      bass: [clip("c", 1, 2)],
      gtr2: [clip("d", 1, 2)],
    };
    // 10 px/s y camara en 0: x 15..25 son 1,5..2,5 s.
    expect(
      clipsInArea(rows, clipsByTrack, { x0: 25, x1: 15, y0: 10, y1: 60 }, 0, 10),
    ).toEqual(["a", "c"]);
    // Con la camara desplazada, lo mismo en pantalla es otro tiempo.
    expect(
      clipsInArea(rows, clipsByTrack, { x0: 0, x1: 10, y0: 10, y1: 20 }, 100, 10),
    ).toEqual(["b"]);
  });

  it("un clip corto se coge por lo que mide en pantalla, como al tocarlo", () => {
    const clipsByTrack = { gtr1: [clip("tiny", 0, 0.1)] };
    // 0,1 s a 10 px/s es 1 px, pero se pinta con 28.
    expect(
      clipsInArea(rows, clipsByTrack, { x0: 20, x1: 25, y0: 0, y1: 10 }, 0, 10),
    ).toEqual(["tiny"]);
  });

  it("suma a lo que habia sin duplicar", () => {
    expect(mergeSelection(["gtr1"], ["gtr1", "gtr2"])).toEqual(["gtr1", "gtr2"]);
  });
});

describe("el recuadro sobre las cabeceras", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mount(selected: string[] = []) {
    const surface = document.createElement("div");
    Object.defineProperties(surface, {
      offsetWidth: { value: 200 },
      offsetHeight: { value: 150 },
    });
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 150, width: 200, height: 150 }) as DOMRect;
    for (const row of rows) {
      const element = document.createElement("div");
      element.className = "row";
      element.dataset.trackId = row.id;
      element.getBoundingClientRect = () =>
        ({ left: 0, right: 200, width: 200, top: row.top, bottom: row.bottom, height: 50 }) as DOMRect;
      surface.append(element);
    }
    // El carril de automatizacion tiene fila, pero no es una pista.
    const automation = document.createElement("div");
    automation.className = "row";
    automation.dataset.trackId = "automation";
    automation.setAttribute("data-area-skip", "");
    automation.getBoundingClientRect = () => ({ top: 0, bottom: 150 }) as DOMRect;
    surface.append(automation);
    document.body.append(surface);

    const state = { selection: selected };
    const drag = new AreaSelectionDrag(
      {
        surface,
        getRows: () => ({
          layout: buildTrackRowLayout(
            [...rows, { id: "automation" }].map((row) => ({ id: row.id })),
            50,
          ),
          rows: [...rows.map((row) => ({ id: row.id })), { id: "automation", skip: true }],
          anchor: surface.querySelector<HTMLElement>(".row"),
        }),
        getViewport: () => null,
        getSelection: () => state.selection,
        setSelection: vi.fn((ids: string[]) => {
          state.selection = ids;
        }),
      },
      100,
      10,
    );
    return { surface, drag, state };
  }

  it("coge las pistas que va tocando y salta las que no son pistas", () => {
    const m = mount();
    m.drag.update(100, 120);
    expect(m.state.selection).toEqual(["gtr1", "bass", "gtr2"]);
    expect(m.surface.querySelector(".lt-area-select-box")).not.toBeNull();
    m.drag.end();
    expect(m.surface.querySelector(".lt-area-select-box")).toBeNull();
    expect(m.state.selection).toEqual(["gtr1", "bass", "gtr2"]);
  });

  it("suma a lo ya cogido, y al recoger el dedo suelta lo que deja de tocar", () => {
    const m = mount(["gtr2"]);
    m.drag.update(100, 60);
    expect(m.state.selection).toEqual(["gtr2", "gtr1", "bass"]);
    m.drag.update(100, 30);
    expect(m.state.selection).toEqual(["gtr2", "gtr1"]);
  });

  it("cancelado vuelve a lo de antes", () => {
    const m = mount(["gtr2"]);
    m.drag.update(100, 60);
    m.drag.cancel();
    expect(m.state.selection).toEqual(["gtr2"]);
  });
});
