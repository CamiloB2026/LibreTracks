// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimelineUIStore } from "../uiStore";
import { useHeaderAreaSelection } from "./useAreaSelection";

vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  isMobileApp: true,
}));

function Pane() {
  const ref = useRef<HTMLDivElement | null>(null);
  useHeaderAreaSelection(ref, () => {});
  return (
    <div ref={ref} data-testid="pane">
      <div className="lt-track-header-row" data-track-id="a">
        <strong>a</strong>
      </div>
    </div>
  );
}

function pointer(type: string, target: EventTarget, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  Object.assign(event, { pointerId, pointerType: "touch", isPrimary: pointerId === 1 });
  target.dispatchEvent(event);
}

/** `touchmove` con N dedos; devuelve si se le quito el desplazamiento nativo. */
function touchMove(target: EventTarget, fingers = 1) {
  const event = new Event("touchmove", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: { length: fingers } });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("useHeaderAreaSelection: scroll nativo", () => {
  beforeEach(() => useTimelineUIStore.setState({ areaSelectMode: true }));
  afterEach(cleanup);

  // En el movil el visor se llevaba el gesto pese a `touch-action: none`: el
  // recuadro no llegaba a dibujarse y la columna desplazaba como siempre.
  it("bloquea el desplazamiento mientras un dedo dibuja", () => {
    const { getByText } = render(<Pane />);
    const name = getByText("a");
    pointer("pointerdown", name);
    expect(touchMove(name)).toBe(true);
  });

  it("sin el modo, la columna desplaza como siempre", () => {
    useTimelineUIStore.setState({ areaSelectMode: false });
    const { getByText } = render(<Pane />);
    const name = getByText("a");
    pointer("pointerdown", name);
    expect(touchMove(name)).toBe(false);
  });

  it("con dos dedos no se bloquea nada", () => {
    const { getByText } = render(<Pane />);
    const name = getByText("a");
    pointer("pointerdown", name, 1);
    pointer("pointerdown", name, 2);
    expect(touchMove(name, 2)).toBe(false);
  });
});
