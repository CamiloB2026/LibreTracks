import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Expanded lyrics take the whole Live view (header + lyrics, one column).
 *
 * `.lt-live-view.has-chart` and `.lt-live-view.is-chart-expanded` have the same
 * specificity and both apply when the lyrics are expanded, so whichever comes
 * LAST in the file wins. A phone media query restated the two-column
 * `has-chart` grid after the expanded rule and the lyrics (and the header) only
 * got half the screen. Read from the CSS on purpose: jsdom does no layout.
 */
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "LivePerformanceView.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Start offsets of every rule whose selector list includes `selector`. */
function ruleOffsets(selector: string): number[] {
  const offsets: number[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) offsets.push(match.index);
  }
  return offsets;
}

function bodyAt(offset: number): string {
  const open = css.indexOf("{", offset);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("expanded lyrics in the Live view", () => {
  it("no two-column rule comes after the last expanded rule", () => {
    const expanded = ruleOffsets(".lt-live-view.is-chart-expanded")
      .filter((offset) => /grid-template-areas/.test(bodyAt(offset)));
    const twoColumn = ruleOffsets(".lt-live-view.has-chart")
      .filter((offset) => /grid-template-(columns|areas)/.test(bodyAt(offset)));
    expect(expanded.length).toBeGreaterThan(0);
    expect(Math.max(...expanded)).toBeGreaterThan(Math.max(...twoColumn));
  });
});
