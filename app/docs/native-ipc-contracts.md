# Native IPC contract fixtures

`app/fixtures/native-ipc.json` is a frozen output of the historical Rust test
`native_ipc_payloads_match_frontend_fixture` from a temporary native Store. It
covers passive settings reads in all three connection states, bank/question/session
pagination, complete unknown/AI/manual grading sessions, a historical error receipt,
and a real backup/restore result. It uses the handwritten sample bank and a fake
grading response; no Keychain entries, personal data, network or models are used.
Only random identifiers, session cache keys and the temporary recovery path are
normalized. Payload field names, nulls and values remain native output.

`app/src/NativeIpcContracts.test.ts` checks its TypeScript compatibility and reads
the same payloads through the frontend API. It runs through `make app-check` and
desktop CI. `app/desktop/native-ipc-parity.test.ts` reconstructs the original
bank/session workflow in a real temporary Node SQLite store and compares bank,
question and session pagination, unknown/graded/manual session payloads and
backup/restore responses exactly. Only generated identities and the recovery
path are normalized. Historical receipt values are seeded as retained state,
never accepted as new grading responses exempt from current evidence checks.
Legacy direct/service sidecars round-trip unchanged and a historical target
cannot silently authorize current grading. Current AI settings have their own
explicitly approved embedded-provider UI and do not expose the old settings API.

The frozen fixture is not regenerated to conceal a compatibility change.
Historical error fields remain opaque and are preserved.

After an intentional contract change, update the typed bridge and affected
worker/renderer consumers, preserve nulls and historical error fields, and add
an observable regression. Review any deliberate change to the frozen fixture
against its original source in Git history. From `app/`:

```sh
npx vitest run src/NativeIpcContracts.test.ts
npm run test:desktop
npm run test:electron
```

AI wire schemas are owned by `shared/ai-contracts.json`; its exporter derives
`app/src/contracts.generated.ts`. The separate frozen wire/grading baselines
retain their [provenance](../fixtures/migration-reference.md).
