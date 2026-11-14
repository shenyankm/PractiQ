import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hash } from "./assets.js";
import { validateParsedTree } from "./question-contract.js";
import { sourceCasefold } from "./source-casefold.js";
import { validateUnitResult } from "./unit-results.js";
import corpus from "../fixtures/tencent/source-models.json" with { type: "json" };

it.each(corpus)("matches historical Unicode/source model validation: $name", input => {
  const check = () => input.tree ? { questions: validateParsedTree(input.input.questions) } : validateUnitResult(input.input);
  if (input.rejected) expect(check).toThrow(); else expect(check()).toEqual(input.expected);
});
it("uses frozen source case folding without context-dependent lowercasing", () => {
  expect(sourceCasefold("ΟΣ ς ß SS ﬀ ı İ K 🦑")).toBe("οσ σ ss ss ff ı i\u0307 k 🦑");
  expect(hash(readFileSync(new URL("./source-casefold.json", import.meta.url)))).toBe("e20a1c5a238d4169dc1b50cfcac4392c11267b352b5b61ae87f2f54e0ea54f7f");
});
