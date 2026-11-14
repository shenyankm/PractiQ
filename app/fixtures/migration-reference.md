# Frozen migration references

These files freeze the dual-implementation reference before retiring Rust/Python
sources. They are test inputs, not generated application types. File copies
retain their original bytes; model definitions were serialized by the original
Pydantic implementation before deletion.

| File | Original source | Source revision | SHA-256 |
| --- | --- | --- | --- |
| `legacy-wire-schemas.json` | `app/src-tauri/contracts.json` | `3d79ce25bbe0520d1299ef729f85aae51d95fd40` | `e4e7d1dd01c173309587e033ada13233c7851d607cccae3b7785b8b827d82bb9` |
| `grading-evidence-v2.json` | `server/evals/badcases/grading-evidence-v2.json` | `3d79ce25bbe0520d1299ef729f85aae51d95fd40` | `31fabffaa3d56d72c0ea4bc7def862fc81e97c5999aa6d66f9139403c5adbd37` |
| `legacy-model-schemas.json` | `UnitParseResult`, `OcrPageParseResult`, `PageParseResult`, `GeneratedAnswer` and their `$defs` from `model_json_schema(mode="serialization")` | `a3bef2da8c818aaa889b1f27c72c4ce4f1617c7b` | `69efc8266e25a390c47efab83fc9ca9290f2ad83af3ec99dc1d8823122383412` |

`desktop/contracts.test.ts` compares every exported AI wire schema with the frozen
reference and all 19 original model definitions, including six output contracts.
`desktop/grading.test.ts` runs the retained grounded-grading corpus.
The references are intentionally not rewritten by the TypeScript exporter.
Any future contract incompatibility requires an explicit compatibility/version
decision, rather than regenerating the reference to hide a failing comparison.

`shared/ai-contracts.json` remains the single editable wire-schema source.
`scripts/export-contracts.ts` derives TypeScript types only. Historical deployment
data, credentials and checkpoints are outside these synthetic/reference fixtures.
