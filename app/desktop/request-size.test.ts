import { expect, it } from "vitest";
import { REQUEST_BYTE_LIMIT, requestBytes, withinRequestLimit } from "./request-size.js";

it("counts text, binary payloads and keys against the same bounded budget", () => {
  expect(requestBytes({ type: "banks" })).toBeGreaterThan(0);
  expect(requestBytes({ type: "banks" })).toBeLessThan(1000);
  expect(withinRequestLimit({ type: "save_document_bytes", bytes: new ArrayBuffer(1024) })).toBe(true);
  expect(withinRequestLimit({ type: "save_document_bytes", bytes: new ArrayBuffer(REQUEST_BYTE_LIMIT + 1) })).toBe(false);
  expect(withinRequestLimit({ text: "a".repeat(1000) })).toBe(true);
  expect(withinRequestLimit({ text: "a".repeat(REQUEST_BYTE_LIMIT) })).toBe(false);
  expect(withinRequestLimit({ view: new Uint8Array(64), nested: [[{ value: 1 }]] })).toBe(true);
});

it("refuses an oversized request early without copying the remaining payload", () => {
  // A 150 MiB document download is a legal IPC shape for save_document_bytes and must be bounded.
  expect(withinRequestLimit({ bytes: new ArrayBuffer(150 * 1024 * 1024), name: "source.pdf" })).toBe(false);
  const wide = { items: Array.from({ length: 400_000 }, (_value, index) => ({ index, label: `row-${index}` })) };
  expect(withinRequestLimit(wide)).toBe(false);
});

it("survives cycles, repeated references and unsupported values", () => {
  const cyclic: Record<string, unknown> = { type: "banks" }; cyclic.self = cyclic;
  expect(withinRequestLimit(cyclic)).toBe(true);
  const shared = { a: 1 };
  expect(withinRequestLimit({ first: shared, second: shared, third: [shared] })).toBe(true);
  expect(withinRequestLimit({ value: undefined, other: null, flag: true, count: 2 })).toBe(true);
  expect(requestBytes(1n as unknown)).toBeGreaterThan(0);
});
