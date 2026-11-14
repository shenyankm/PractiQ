# Frozen migration references

These files were copied byte-for-byte from the last dual-implementation source
at commit `3d79ce25bbe0520d1299ef729f85aae51d95fd40` before removing active
Rust/Python dependencies. They are test inputs, not generated application types.

| File | Original path | SHA-256 |
| --- | --- | --- |
| `legacy-wire-schemas.json` | `app/src-tauri/contracts.json` | `e4e7d1dd01c173309587e033ada13233c7851d607cccae3b7785b8b827d82bb9` |
| `grading-evidence-v2.json` | `server/evals/badcases/grading-evidence-v2.json` | `31fabffaa3d56d72c0ea4bc7def862fc81e97c5999aa6d66f9139403c5adbd37` |

`desktop/contracts.test.ts` compares every exported AI wire schema with the frozen
reference. `desktop/grading.test.ts` runs the retained grounded-grading corpus.
The references are intentionally not rewritten by the TypeScript exporter.
Any future contract incompatibility requires an explicit compatibility/version
decision, rather than regenerating the reference to hide a failing comparison.

`shared/ai-contracts.json` remains the single editable wire-schema source.
`scripts/export-contracts.ts` derives TypeScript types only. Historical deployment
data, credentials and checkpoints are outside these synthetic/reference fixtures.
