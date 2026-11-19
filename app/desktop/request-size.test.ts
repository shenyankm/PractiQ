import { expect, it } from "vitest";
import { REQUEST_BYTE_LIMIT, requestBytes, withinRequestLimit } from "./request-size.js";

it("bounds text and keys while leaving binary payloads to the handler that accepts them", () => {
  expect(requestBytes({ type: "banks" })).toBeGreaterThan(0);
  expect(requestBytes({ type: "banks" })).toBeLessThan(1000);
  expect(withinRequestLimit({ text: "a".repeat(1000) })).toBe(true);
  expect(withinRequestLimit({ text: "a".repeat(REQUEST_BYTE_LIMIT) })).toBe(false);
  expect(withinRequestLimit({ first: "a".repeat(1_000_000), second: "b".repeat(1_000_000) })).toBe(true);
  expect(withinRequestLimit({ view: new Uint8Array(64), nested: [[{ value: 1 }]] })).toBe(true);
  // A 17 MiB document download is legal: save_document_bytes enforces its own 150 MiB cap.
  expect(withinRequestLimit({ type: "save_document_bytes", bytes: new Uint8Array(17 * 1024 * 1024).fill(127).buffer, name: "source.pdf" })).toBe(true);
  expect(withinRequestLimit({ bytes: new ArrayBuffer(150 * 1024 * 1024), name: "source.pdf" })).toBe(true);
});

it("refuses an oversized request early without copying the remaining payload", () => {
  const wide = { items: Array.from({ length: 400_000 }, (_value, index) => ({ index, label: `row-${index}` })) };
  expect(withinRequestLimit(wide)).toBe(false);
  expect(withinRequestLimit({ items: new Array(4096).fill("x".repeat(4096)) })).toBe(false);
});


it("survives cycles, repeated references and unsupported values", () => {
  const cyclic: Record<string, unknown> = { type: "banks" }; cyclic.self = cyclic;
  expect(withinRequestLimit(cyclic)).toBe(true);
  const shared = { a: 1 };
  expect(withinRequestLimit({ first: shared, second: shared, third: [shared] })).toBe(true);
  expect(withinRequestLimit({ value: undefined, other: null, flag: true, count: 2 })).toBe(true);
  expect(requestBytes(1n as unknown)).toBeGreaterThan(0);
});
