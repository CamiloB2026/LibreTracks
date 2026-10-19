// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { installPageZoomGuard } from "./pageZoomGuard";

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = "";
});

const wheel = (init: WheelEventInit) =>
  new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, ...init });

describe("Ctrl + rueda fuera del timeline", () => {
  it("no hace zoom de toda la app", () => {
    uninstall = installPageZoomGuard();
    const panel = document.body.appendChild(document.createElement("div"));
    const ctrl = wheel({ ctrlKey: true });
    panel.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    const cmd = wheel({ metaKey: true });
    panel.dispatchEvent(cmd);
    expect(cmd.defaultPrevented).toBe(true);
  });

  it("deja la rueda normal en paz, para que todo siga haciendo scroll", () => {
    uninstall = installPageZoomGuard();
    const plain = wheel({});
    document.body.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  it("quien usa el gesto lo recibe antes, como siempre", () => {
    uninstall = installPageZoomGuard();
    const timeline = document.body.appendChild(document.createElement("div"));
    let seenBeforeGuard: boolean | null = null;
    timeline.addEventListener("wheel", (event) => {
      seenBeforeGuard = !event.defaultPrevented;
    });
    timeline.dispatchEvent(wheel({ ctrlKey: true }));
    expect(seenBeforeGuard).toBe(true);
  });
});
