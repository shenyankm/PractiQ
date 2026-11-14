import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { contractSource, schemaFor, validateContract } from "./contracts.js";
import scores from "../fixtures/tencent/source-scores.json" with { type: "json" };

it("preserves every legacy exported wire schema exactly", () => {
  const legacy = JSON.parse(readFileSync(new URL("../fixtures/legacy-wire-schemas.json", import.meta.url), "utf8"));
  for (const [key, name] of Object.entries(contractSource.exports)) expect(schemaFor(name)).toEqual(legacy[key]);
});

it("compiles every contract and rejects additional fields without coercing input", () => {
  for (const name of Object.keys(contractSource.definitions)) {
    try { validateContract(name, {}); }
    catch (error) { expect(error).toHaveProperty("code", "LOCAL_SCHEMA_INVALID"); }
  }
  const reference = { objectKey: "images/one", sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: 1 };
  expect(() => validateContract("ArtifactReference", reference)).not.toThrow();
  expect(() => validateContract("ArtifactReference", { ...reference, path: "/private" })).toThrow("Content does not satisfy");
  expect(() => validateContract("ArtifactReference", { ...reference, sizeBytes: "1" })).toThrow("Content does not satisfy");
  expect(() => validateContract("ArtifactReference", { ...reference, sha256: "invalid" })).toThrow("Content does not satisfy");
  expect(reference).toEqual({ objectKey: "images/one", sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: 1 });
});

it("matches historical source-score validation at decimal and floating-point boundaries", () => {
  for (const { score, accepted } of scores) {
    const check = () => validateContract("ParsedQuestion", { sourceScore: score });
    if (accepted) expect(check, String(score)).not.toThrow();
    else expect(check, String(score)).toThrow();
  }
  for (let cents = 1; cents <= 10000; cents++) validateContract("ParsedQuestion", { sourceScore: cents / 100 });
  for (const score of ["0.29", true, NaN, Infinity, -Infinity]) expect(() => validateContract("ParsedQuestion", { sourceScore: score })).toThrow();
});
