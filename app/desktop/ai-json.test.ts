import { expect, it } from "vitest";
import { parseAiJson, parseModelJson } from "./ai-json.js";
it.each([
  { source: '{', expected: {} },
  { source: '{"value":1,}', expected: { value: 1 } },
  { source: '[1,2,]', expected: [1, 2] },
  { source: '{"values":[1,2]', expected: { values: [1, 2] } },
  { source: '{"value":"complete"', expected: { value: "complete" } },
  { source: '{"value":true', expected: { value: true } },
  { source: '{"value":null', expected: { value: null } },
  { source: '{"value":{}}}', expected: { value: {} } },
  { source: '[1]]', expected: [1] },
  { source: '{"text":"brackets }, ] and commas, stay literal",}', expected: { text: "brackets }, ] and commas, stay literal" } },
  { source: '```json\n{"value":1,}\n```', expected: { value: 1 } },
  { source: '```\n[1,]\n```', expected: [1] },
  { source: '\u0085{"value":1,}\u0085', expected: { value: 1 } },
])("repairs only unambiguous punctuation without inventing values: $source", ({ source, expected }) => expect(parseModelJson(source)).toEqual(expected));
it.each(['', '[,]', '{,}', '{"value":', '{"value":tru', '{"value":1e', '{"value":"cut off', '{"value":"escape\\', '{"value":1 "other":2}', '{"value":1,"value":2}', '[1}', '{"value":1]','prefix {"value":1}', '{"value":1} suffix', '\ufeff{"value":1}', '```JSON\n{"value":1}\n```']) ("refuses uncertain, duplicate or non-JSON model content: %s", source => expect(() => parseModelJson(source)).toThrow());
it("keeps HTTP envelopes and saved payloads strict while model arguments permit only punctuation repair", () => {
  const source = '{"value":1,}'; expect(() => parseAiJson(source)).toThrow(); expect(parseModelJson(source)).toEqual({ value: 1 });
  for (const source of ['{"value":9007199254740993}', '{"value":9007199254740991.1}', '{"value":9007199254740993,}', '{"value":9007199254740991.1,}', '['.repeat(129) + '0' + ']'.repeat(129)]) expect(() => parseModelJson(source)).toThrow();
});
it("rejects lone surrogate values and field names without changing valid supplementary characters", () => {
  for (const source of ['{"text":"\\ud800"}', '{"text":"\\udc00"}', '{"\\ud800":1}', '{"text":"\ud800"}', '{"text":"\\ud800",}']) expect(() => parseModelJson(source)).toThrow();
  expect(parseModelJson('{"text":"\\ud83e\\udd91"}')).toEqual({ text: "🦑" });
});

import { schemaFor } from "./contract-source.js";
it.each(["1.0", "1e0", "1E+0", "-0.0"])("retains strict integer token checks after punctuation repair: %s", token => {
  for (const source of [`{"questions":[],"groups":[],"figures":[{"elementIndex":${token},"description":"source"}]}`, `{"questions":[],"groups":[],"figures":[{"elementIndex":${token},"description":"source",}],}`]) expect(() => parseModelJson(source, schemaFor("OcrPageParseResult"))).toThrow(/integer/);
  expect(() => parseModelJson(`{"questions":[],"groups":[{"title":"group","questionIndexes":[${token}]}]}`, schemaFor("UnitParseResult"))).toThrow(/integer/);
  expect(() => parseModelJson(`{"questions":[{"items":[{"id":${token}}]}]}`, schemaFor("UnitParseResult"))).toThrow(/integer/);
});
it("keeps float scores, bounds and arbitrary JSON values while checking typed nested integers", () => {
  const source = '{"questions":[{"confidence":1.0,"sourceScore":1e0,"answerPayload":{"score":1.0},"contentBlocks":[{"jsonValue":{"order":[1.0],"nested":{"value":1e0}}}]}],"figures":[{"bbox":[0.0,0e0,1.0,1.0]}]}';
  expect(parseModelJson(source, schemaFor("PageParseResult"))).toEqual(JSON.parse(source));
  expect(() => parseModelJson('{"scoreCents":1.0}', schemaFor("GradeResult"))).toThrow(/integer/);
  expect(parseModelJson('{"scoreCents":"100"}', schemaFor("GradeResult"))).toEqual({ scoreCents: "100" });
  expect(parseModelJson('{"questions":[],"figures":[{"elementIndex":1,"questionIndexes":[0]}]}', schemaFor("OcrPageParseResult"))).toMatchObject({ figures: [{ elementIndex: 1, questionIndexes: [0] }] });
});
it("retains strict source ordering and matching answer indexes even when payloads precede their mode", () => {
  for (const [mode, answer] of [["ordering", '{"order":[1.0]}'], ["matching", '{"matches":[{"left":0,"right":1e0}]}']]) expect(() => parseModelJson(`{"questions":[{"answerPayload":${answer},"answerMode":"${mode}"}]}`, schemaFor("UnitParseResult"))).toThrow(/integer/);
  expect(parseModelJson('{"questions":[{"answerPayload":{"order":[0,1]},"answerMode":"ordering"}]}', schemaFor("UnitParseResult"))).toMatchObject({ questions: [{ answerPayload: { order: [0, 1] } }] });
});
it("retains historical non-strict AudioReference byte counts before model audio is discarded", () => {
  const source = '{"questions":[{"audioRef":{"sizeBytes":1.0}}]}';
  expect(parseModelJson(source, schemaFor("UnitParseResult"))).toEqual(JSON.parse(source));
});
it("preserves Python numeric Literal equality instead of treating it as StrictInt", () => {
  expect(parseModelJson('{"schemaVersion":3.0}', schemaFor("DocumentParseResult"))).toEqual({ schemaVersion: 3 });
});
