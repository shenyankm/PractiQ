# Android CI build deduplication validation

The arm64 package check and API 35 x86_64 emulator remain independent jobs feeding the existing Android CI gate. The production frontend is built once in App quality and downloaded from the same workflow run by both jobs. ABI-specific Rust bootstraps replace throwaway resource-free APK builds; final packaging still uses the official Tauri CLI after exact-runtime notice validation.

## Validation

- Red/green regression: the new bootstrap/workflow checks first failed against the old pipeline, then passed after implementation.
- [Workflow, scope, release, package, license and bootstrap regressions](quality-tests.txt): **776 passed**, including the required native-build guard. The two warnings come from deliberate duplicate-class ZIP fixtures.
- Review follow-up: the release caller grants `actions: read` to its reusable App workflow so both Android jobs can download the same-run frontend artifact. A regression fails without the caller permission.
- Ruff (`--target-version py314`) and `git diff --check`: passed.
- [Production frontend build](frontend-build.txt): passed.
- [Native arm64 bootstrap](bootstrap-arm64.txt): passed from a worktree without generated Gradle bindings. It created both plugin binding files and produced no APK. The worktree reused the local Cargo target cache; this is not a cold-cache timing benchmark.
- [Actual Gradle runtime inventory](runtime-inventory-arm64.txt): passed immediately after bootstrap, without a preliminary APK or Tauri CLI project initialization.
- [Final official CLI APK build](final-arm64-build.txt): passed with only the frontend rebuild hook disabled. No frontend build command ran in this step.
- [Strict package report](android-package.json): passed; arm64-v8a, app 0.2.0/versionCode 2, expected notices and resources, no embedded AI engines. SHA-256: `505868242a954c5647ec4e18cc195e3a2e8c5cc98bbbe4b9f573730691ffaeae`.
- Local environment: macOS arm64, JDK 21, SDK 36, NDK 28.2.13676358; Debug APK with `CARGO_PROFILE_DEV_DEBUG=1`. Both target mappings have unit coverage; Linux x86_64 native/emulator execution and current-head remote CI are separate PR gates.

## Scope and evidence limits

[checks.json](checks.json) records the removed command counts: four production frontend builds become one, and four APK packaging passes become two. Each ABI still needs native plugin discovery, runtime notice verification, its final package and its separate gate. No end-to-end timing improvement or byte-identical APK claim is made across hosts/profiles.

The tracked Android host sources remained unchanged through the real bootstrap/build. No local app was installed, launched, uninstalled or cleared. Existing practice data, credentials and unrelated worktree evidence were not touched. Build outputs, dependency symlinks and the APK itself are excluded from this contribution.

Review follow-up validation: `PRACTIQ_REQUIRE_NATIVE_BUILD_GUARD=1 python3.14 -m pytest server/tests/test_ci.py server/tests/test_release_checks.py server/tests/test_release_workflow.py server/tests/test_android_bootstrap.py -q` passed **395 tests**. The added caller-permission assertion first failed with `KeyError: actions`, then passed with the release permission in place. No release was published or workflow dispatched during this verification.
