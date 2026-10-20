# PR #330 review follow-up

The first review of commit `e59f60e286a5294d3bf68a1afdad8ae55ea7d6a3` found that the direct-model connection test accepted any `/models` data array, including an empty list or one without the configured model. [Review finding](https://github.com/shenyankm/PractiQ/pull/330#discussion_r4325464504).

The connection check now requires an exact string-ID match in the returned model list. A missing model produces the bilingual `LOCAL_MODEL_UNAVAILABLE` error. The check still makes one bounded GET and never starts grading. Existing grading, credential storage and receipt recovery are unchanged.

## Regression evidence

The new missing-model regression failed against the original implementation (`unwrap_err()` received `Ok(Null)`) before the fix. After the fix:

- A matching ID succeeds even after unrelated and malformed entries.
- An empty list or a list of other/null/missing IDs fails with `LOCAL_MODEL_UNAVAILABLE`.
- A non-array response fails with `LOCAL_MODEL_RESPONSE_INVALID`.
- The HTTP fixture requires `GET /models` and verifies there is no grading payload.

`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 make app-check AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14.7-macos-aarch64-none/bin/python3.14` passed on macOS arm64: 49 contract cases, TypeScript/lint, 451 frontend tests (2 existing opt-in skips), 206 Rust tests (16 existing opt-in ignores), formatting and Clippy with warnings denied. [Log](pr-330-follow-up-app-check.txt).

## Candidate boundary

The original [APK/native acceptance](README.md) remains evidence for the pre-review local candidate and its recorded APK hash. It is not a claim that that APK contains this follow-up. Current-head Android builds, emulator tests, desktop checks and automated review are tracked on [PR #330](https://github.com/shenyankm/PractiQ/pull/330/checks) after pushing this fix. Real-provider, physical-device, Windows-local and signed-release validation were not added by this follow-up.

Implementation file SHA-256 values for this follow-up:

- `app/src-tauri/src/ai.rs`: `d488ee20ca32b44d5d69a1a1275c1dc65a6631fd2ee778ea5d6b7e5f5eaa7d7c`
- `app/src/locales/native.json`: `94426bd4e0609414e41639161856b6144728e7d8a474168454a8068148b96250`

## Second review: response classification and redaction

The review of `4bd9c6d1c2d788b631d08a02097413c912488354` identified two additional issues: [complete invalid response bodies were recorded as unknown](https://github.com/shenyankm/PractiQ/pull/330#discussion_r4325617696), and [redaction before JSON parsing could corrupt required fields for short API keys](https://github.com/shenyankm/PractiQ/pull/330#discussion_r4325617707).

Both new integration regressions failed before the fix. The shared bounded reader now distinguishes interrupted response-body reads from complete JSON parse/size failures. Direct grading records complete invalid or oversized success responses as ungraded with unknown usage; body-read interruptions remain unknown. Existing valid scores and local receipt reuse are preserved in all three cases. Service grading keeps its unknown-outcome behavior for propagated read errors.

Direct results are parsed and validated before redacting retained feedback text, model metadata and provider receipt IDs. Fixed score/schema fields are left intact. A short key `score` now yields the valid 6/10 result while reflected feedback and provider IDs are redacted.

The full local App check passed again: 49 contract cases, TypeScript/lint, 451 frontend tests (2 existing opt-in skips), 208 Rust tests (16 existing opt-in ignores), formatting and Clippy with warnings denied. [Full check log](pr-330-response-app-check.txt). No real model call or new APK acceptance is claimed by these local regressions; current-head native builds and emulator tests run in hosted CI.

Second-follow-up implementation SHA-256 values:

- `app/src-tauri/src/ai.rs`: `d9402745930924e3182d2b5216cd2c9a06dbe8f04573afdc080c4f31c65f6ad5`
- `app/src-tauri/src/model_grading.rs`: `935bf346330d48bfad498681e3c57e8cd4272e3215f906551e7a904854d939fc`
- `app/src/locales/native.json`: `6c3b84664274961ad99bfe36bdc2eb06850a18bb0bbec2082ca32f802345e522`
