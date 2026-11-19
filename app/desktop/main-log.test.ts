import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainLog, describeError, redactPath } from "./main-log.js";

const profile = () => mkdtempSync(join(tmpdir(), "practiq-main-log-"));

it("records bounded single-line diagnostics without the local profile path", () => {
  const file = join(profile(), "logs", "main.log"), log = new MainLog(file);
  const error = new Error(`failed under ${join("/Users", "someone", "Library", "PractiQ")}`); error.stack = `Error: x\n    at frame one\n    at frame two`;
  const line = log.record("render-process-gone", error);
  expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z render-process-gone failed under/);
  expect(line).toContain("@@ at frame one | at frame two");
  expect(line.endsWith("\n")).toBe(true); expect(line.trim()).not.toContain("\n");
  expect(readFileSync(file, "utf8")).toBe(line);
});

it("redacts the home directory and describes values that are not errors", () => {
  expect(redactPath("/home/reader/v4/practiq.sqlite", "/home/reader")).toBe("~/v4/practiq.sqlite");
  expect(redactPath("/home/reader/v4", "/")).toBe("/home/reader/v4");
  expect(describeError("plain text")).toBe("plain text");
  expect(describeError({ reason: "gone" })).toBe('{"reason":"gone"}');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(describeError(cyclic)).toBe("Unserializable value");
  expect(describeError(new Error("boom"))).toMatch(/^boom( @@ |$)/);
  const coded = Object.assign(new Error("unavailable"), { code: "LOCAL_DATABASE_UNAVAILABLE" });
  expect(describeError(coded)).toMatch(/^\[LOCAL_DATABASE_UNAVAILABLE\] unavailable( @@ |$)/);
});

it("rotates one older file at the limit and never throws while recording", () => {
  const file = join(profile(), "main.log"), log = new MainLog(file, 120);
  log.record("first", "retained"); expect(statSync(file).size).toBeGreaterThan(0);
  writeFileSync(file, "x".repeat(200));
  log.record("second", "after rotation");
  expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(200));
  expect(readFileSync(file, "utf8")).toContain("after rotation");
  expect(new MainLog(join(profile(), "\u0000invalid")).record("broken", "value")).toContain("broken");
});
