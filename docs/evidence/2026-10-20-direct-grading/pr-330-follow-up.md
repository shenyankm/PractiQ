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
