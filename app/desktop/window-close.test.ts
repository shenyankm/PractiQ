import { expect, it } from "vitest";
import { needsRendererApproval } from "./window-close.js";

it("waits for a live renderer to confirm the draft-save request", () => {
  expect(needsRendererApproval({ approved: false, crashed: false, fallback: false })).toBe(true);
});

it("allows a close that the renderer already approved", () => {
  expect(needsRendererApproval({ approved: true, crashed: false, fallback: false })).toBe(false);
});

it("never blocks a crashed renderer or the script-free failure page", () => {
  expect(needsRendererApproval({ approved: false, crashed: true, fallback: false })).toBe(false);
  expect(needsRendererApproval({ approved: false, crashed: false, fallback: true })).toBe(false);
  expect(needsRendererApproval({ approved: false, crashed: true, fallback: true })).toBe(false);
});
