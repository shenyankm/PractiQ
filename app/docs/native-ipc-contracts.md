# Native IPC contract fixtures

`app/fixtures/native-ipc.json` is produced by the Rust test
`native_ipc_payloads_match_frontend_fixture` from a temporary native Store. It
covers passive settings reads in all three connection states, bank/question/session
pagination, complete unknown/AI/manual grading sessions, a historical error receipt,
and a real backup/restore result. It uses the handwritten sample bank and a fake
grading response; no Keychain entries, personal data, network or models are used.
Only random identifiers, session cache keys and the temporary recovery path are
normalized. Payload field names, nulls and values remain native output.

Normal `cargo test` compares those responses with the committed fixture.
`app/src/NativeIpcContracts.test.ts` checks its TypeScript compatibility and reads
the same payloads through the frontend API. Both checks already run in
`make app-check` and desktop CI; there is no separate schema or validation library.
Historical error fields remain opaque and are preserved.

After an intentional native contract change, regenerate explicitly from the
repository root, review the JSON diff and update both affected consumers and
their tests:

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' PRACTIQ_UPDATE_NATIVE_IPC_FIXTURE=1 cargo test --locked --manifest-path app/src-tauri/Cargo.toml native_ipc_payloads_match_frontend_fixture
cd app
npx tsc -b
npx vitest run src/NativeIpcContracts.test.ts
```

Run the Rust test again without the update variable to verify reproducibility;
keep the `TAURI_CONFIG` override so source tests need no prepared package resources.
