// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "./RenderFailure";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("isolates a rendering failure and does not replay business actions", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const action = vi.fn();
  function Broken(): never { throw new Error("Bad chunk"); }
  render(<><button onClick={action}>Preserved action</button><ErrorBoundary fallback={<RenderFailure />}><Broken /></ErrorBoundary></>);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Preserved action" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
});
