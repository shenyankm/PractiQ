import { expect, it } from "vitest";
import { parseWindowState, serializeWindowState } from "./window-state.js";

const display = { x: 0, y: 0, width: 1728, height: 1117 };

it("restores a supported frame that is still visible on a connected display", () => {
  expect(parseWindowState({ bounds: { x: 40, y: 24, width: 1440, height: 960 }, maximized: true }, [display]))
    .toEqual({ x: 40, y: 24, width: 1440, height: 960, maximized: true });
  expect(parseWindowState({ bounds: { x: -100, y: 0, width: 1440, height: 960 } }, [{ x: -1920, y: 0, width: 1920, height: 1080 }]))
    .toEqual({ x: -100, y: 0, width: 1440, height: 960, maximized: false });
});

it("drops only the position when the saved display is gone and keeps the supported size", () => {
  expect(parseWindowState({ bounds: { x: 4000, y: 300, width: 1200, height: 800 }, maximized: false }, [display])).toEqual({ width: 1200, height: 800, maximized: false });
  expect(parseWindowState({ bounds: { x: 0, y: 0, width: 1200, height: 800 } }, [])).toEqual({ width: 1200, height: 800, maximized: false });
});

it("refuses unknown, malformed, tiny or oversized saved states", () => {
  for (const value of [null, undefined, 1, "state", [], {}, { bounds: null }, { bounds: [] }, { bounds: { x: 0, y: 0, width: "1440", height: 960 } }, { bounds: { x: 0.5, y: 0, width: 1440, height: 960 } }, { bounds: { x: 0, y: 0, width: 900, height: 960 } }, { bounds: { x: 0, y: 0, width: 1440, height: 600 } }, { bounds: { x: 0, y: 0, width: 20000, height: 960 } }])
    expect(parseWindowState(value, [display])).toBeNull();
  expect(parseWindowState({ bounds: { x: 0, y: 0, width: 1024, height: 700 } }, [display])).toEqual({ x: 0, y: 0, width: 1024, height: 700, maximized: false });
});

it("writes only the frame and maximized flag", () => {
  expect(serializeWindowState({ x: 1, y: 2, width: 1440, height: 960 }, true)).toEqual({ bounds: { x: 1, y: 2, width: 1440, height: 960 }, maximized: true });
  expect(serializeWindowState({ x: 1, y: 2, width: 1440, height: 960 }, false).maximized).toBe(false);
});
