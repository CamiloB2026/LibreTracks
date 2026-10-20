// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobileTimelineNavigation,
  type AreaSelectGesture,
  type MobileNavigationOptions,
} from "./MobileTimelineNavigation";

function pointer(target: EventTarget, type: string, id: number, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" } });
  target.dispatchEvent(event);
}

const managers: MobileTimelineNavigation[] = [];
afterEach(() => {
  managers.splice(0).forEach((manager) => manager.destroy());
  document.body.innerHTML = "";
});

function setup(active = true, extra: Partial<MobileNavigationOptions> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  Object.defineProperties(container, { offsetWidth: { value: 400 }, offsetHeight: { value: 800 } });
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 }) as DOMRect;
  const state = { cameraX: 100, zoomLevel: 1, canZoom: true };
  const vertical = vi.fn();
  const area = {
    active: vi.fn(() => active),
    begin: vi.fn(),
    update: vi.fn(),
    end: vi.fn(),
    cancel: vi.fn(),
  } satisfies AreaSelectGesture;
  const manager = new MobileTimelineNavigation({
    container,
    enabled: () => true,
    subscribe: () => () => {},
    getState: () => state,
    onPreviewCameraX: (camera) => (state.cameraX = Math.max(0, camera)),
    onCommitCameraX: vi.fn(),
    onPreviewZoom: (zoom) => ({ cameraX: state.cameraX, zoomLevel: (state.zoomLevel = zoom) }),
    onCommitZoom: vi.fn(),
    onScrollVertical: vertical,
    areaSelect: area,
    ...extra,
  });
  managers.push(manager);
  return { container, state, vertical, area };
}

describe("seleccion por area en los carriles", () => {
  it("un dedo dibuja desde donde se APOYO, sin desplazar la vista", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 140, 160);
    pointer(window, "pointermove", 1, 180, 200);
    expect(s.area.begin).toHaveBeenCalledWith(100, 100);
    expect(s.area.update).toHaveBeenLastCalledWith(180, 200);
    expect(s.state.cameraX).toBe(100);
    expect(s.vertical).not.toHaveBeenCalled();
    pointer(window, "pointerup", 1, 180, 200);
    expect(s.area.end).toHaveBeenCalledOnce();
    expect(s.area.cancel).not.toHaveBeenCalled();
  });

  it("un toque sigue siendo un toque: suma o quita el clip de debajo", () => {
    const onTap = vi.fn();
    const s = setup(true, { onTap });
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointerup", 1, 100, 100);
    expect(onTap).toHaveBeenCalledOnce();
    expect(s.area.begin).not.toHaveBeenCalled();
  });

  it("un segundo dedo a medio recuadro lo deshace", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 160, 160);
    pointer(s.container, "pointerdown", 2, 300, 160);
    expect(s.area.cancel).toHaveBeenCalledOnce();
    pointer(window, "pointerup", 2, 300, 160);
    pointer(window, "pointerup", 1, 160, 160);
    expect(s.area.end).not.toHaveBeenCalled();
  });

  it("dos dedos que se mueven juntos desplazan: es la unica forma de moverse en el modo", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(s.container, "pointerdown", 2, 200, 100);
    // Como llegan de verdad: un evento por dedo, alternando, a pasos cortos.
    for (let step = 1; step <= 10; step += 1) {
      pointer(window, "pointermove", 1, 100 - step * 5, 100 - step * 4);
      pointer(window, "pointermove", 2, 200 - step * 5, 100 - step * 4);
    }
    expect(s.state.zoomLevel).toBe(1);
    // Contenido anclado al punto medio inicial (150): se ha movido 50 px.
    expect(s.state.cameraX).toBe(150);
    expect(s.vertical).toHaveBeenCalled();
    expect(s.area.begin).not.toHaveBeenCalled();
  });

  it("dos dedos que se separan siguen haciendo zoom", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(s.container, "pointerdown", 2, 200, 100);
    pointer(window, "pointermove", 2, 300, 100);
    expect(s.state.zoomLevel).toBe(2);
  });

  it("el dedo que queda al soltar una pinza desplaza, no empieza un recuadro", () => {
    const s = setup();
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(s.container, "pointerdown", 2, 200, 100);
    pointer(window, "pointermove", 2, 300, 100);
    pointer(window, "pointerup", 2, 300, 100);
    pointer(window, "pointermove", 1, 60, 100);
    expect(s.area.begin).not.toHaveBeenCalled();
  });

  it("fuera del modo un dedo desplaza como siempre", () => {
    const s = setup(false);
    pointer(s.container, "pointerdown", 1, 100, 100);
    pointer(window, "pointermove", 1, 70, 96);
    expect(s.state.cameraX).toBe(130);
    expect(s.area.begin).not.toHaveBeenCalled();
  });
});
