# App snapshot performance, October 15, 2026

The App review found repeated deep copies in native snapshot reconstruction and
draft validation. This change removes those copies in the shared question path.
It adds no dependency, cache, schema migration, IPC field or background work.

## Review scope and decisions

| Path reviewed | Finding and decision |
| --- | --- |
| Startup and route loading (`App.tsx`, `transport.ts`, native command dispatch) | Feature views already load through dynamic imports; native I/O runs on blocking workers. Keep the existing split. |
| Bank/question/history lists (`store.rs`, `questions.rs`, `sessions.rs`) | SQL pagination and summary projections already avoid hydrating all details for list pages. Search keeps content and selection on the same node. Keep those boundaries. |
| Paper selection and scoring (`StudySetup.tsx`, `paper.rs`, `exams.rs`) | Selection already uses metadata and bounded subset sum before reading selected details. Preserve complete groups, frozen digests and integer scores. |
| Session reconstruction (`Index::hydrate`, `session_with`) | Ancestor materials were cloned while collecting ancestors, again while filtering passages, and again through `json!`. Borrow ancestors until constructing the final owned array; filter that owned passage in place. Clone inherited groups/visuals only after checking child precedence. |
| Mutable-attempt baseline (`session_with`) | Full responses cloned each entire snapshot before removing it from the mutable baseline. Copy only mutable fields into that baseline; retain the same revision hash and wire response. |
| Draft validation (`context_from_document`, `write_attempt`) | The selected subset was wrapped in a temporary document, copying all groups and visuals before attaching only the selected associations. Reuse the same thaw validation/association function with borrowed document metadata and a selected question array. |
| Rich content, answer card and editor (`Content.tsx`, `Practice.tsx`, `QuestionPreview.tsx`, `QuestionEditor.tsx`) | Markdown memoization, lazy folded details, bounded preview pages, memoized answer buttons and immutable draft normalization caches already exist. The existing editor probe measured 45 edits; no frontend runtime change is justified by this native-copy fix. |
| Images and listening (`asset-urls.ts`, `ListeningPlayer.tsx`, `assets.rs`, `audio.rs`) | Mounted consumers share binary asset reads and release object URLs; offscreen media is lazy. Native checksum, bounded decode, playback accounting and transcript visibility remain necessary. No persistent media cache is added. |
| ZIP import/export, backup and recovery (`bank_zip.rs`, `backup.rs`, `selected_file.rs`, `settings.rs`) | Preserve bounded picker snapshots, checksums, staged writes and recovery. Archive operations still hold the Store lock; safely shortening that interval would require separate resource-lifetime and concurrent-delete evidence. |
| Explicit AI grading (`ai.rs`, `ExamResults.tsx`) | Provider time is outside this local-copy benchmark. Preserve explicit request/retry, unsettled results and local score snapshots. No model request is made by these measurements. |

The affected shared functions are called by session open/submission, paper
preview, question hydration, draft validation, self-assessment and backup
validation. Their callers, storage and transport formats stay the same. The
document cache and mutable-attempt cache retain their existing caps and restore
invalidation behavior.

## Paired native measurements

Baseline: `3700ce753e53424698ce3697c6e6612783b9955e` (`main`, including PR #241).
Host: Apple M4, macOS 27.0.1, arm64, Rust 1.98.1, release profile. All databases and
snapshots are synthetic and temporary; user data is never opened.
Large cases contain 999 children plus one parent, within the 1,000-question
single-document limit; the metadata case also stays within 1,000 groups and
visuals. The probe asserts those bounds. Earlier 1,000-child stress runs are
excluded from the final figures below.

Three test executables were built with the same opt-in probe: baseline runtime
source, material/context copies removed, and all three optimizations applied.
The reports retain the alternating process order. Each process performs one
untimed warmup and seven samples per operation, giving 21 samples per version
and workload. Input, probe and output
SHA-256 values match across every pair. Setup, output serialization/hash checks
and result destruction are outside the construction timings; the delta probe's
empty-attempt assertion remains inside its operation. Full responses include
native SQL reads and snapshot construction, but exclude IPC and WebView rendering.
The document cache is warm; these are not cold application startup measurements.

| Workload and operation | Before median | After median | Reduction |
| --- | ---: | ---: | ---: |
| 999 children, 100,000-byte shared passage: hydrate all snapshots | 21.374 ms | 10.643 ms | 50.2% |
| Same document: open session with full compact response | 21.607 ms | 12.403 ms | 42.6% |
| 999 children, 10,000-byte passage, 999 scoped group/visual pairs: selected validation context | 0.695 ms | 0.227 ms | 67.4% |
| Same metadata-heavy document: save draft including SQLite transaction | 1.253 ms | 0.750 ms | 40.1% |
| Same metadata-heavy document: open session | 15.882 ms | 11.926 ms | 24.9% |
| Small control, 20 children and 1,000-byte passage: open session | 0.455 ms | 0.365 ms | 19.7% |
| Small control: position delta | 0.455 ms | 0.468 ms | Essentially unchanged; 0.014 ms slower |
| Long-material control: position delta | 2.216 ms | 2.273 ms | 2.6% slower; 0.057 ms difference |

The metadata-heavy context and draft gains remove approximately 0.47 ms and
0.50 ms respectively on this host. The isolated mutable-baseline projection
additionally reduces large-session open medians from 13.354 to 12.403 ms (7.1%)
and from 12.814 to 11.926 ms (6.9%) after the first two optimizations. These are local operation improvements,
not an App-wide speedup or evidence of a perceptible gain for every document.
The delta path has no consistent improvement and is a control, not an
optimization claim. Small submillisecond differences are sensitive to scheduling
and SQLite filesystem noise. All workloads,
including non-headline results, raw samples, binary/source hashes and environment
details are retained in the reports:

- [Baseline](../server/reports/app-performance-20261015-before.json)
- [Material/context changes only](../server/reports/app-performance-20261015-copy-only.json)
- [Optimized](../server/reports/app-performance-20261015-after.json)
- [Unchanged editor control](../server/reports/app-performance-20261015-editor.json)

The editor control uses Node 22.23.2 and jsdom, with 250 children and 45 repeated
edits. Median input-to-commit time is 9.084 ms; maximum is 28.805 ms. This is
diagnostic test-renderer evidence, not native WebView latency or a frontend
before/after comparison. Its input is reproducible from the existing probe.

## Acceptance

Focused regressions verify ancestor order, shared options, child context
precedence, passage answer-role filtering, nested JSON/null preservation, owned
outputs, missing-resource propagation, exclusive siblings, reusable option pools,
unknown question IDs and rejection of malformed metadata/schema versions.
Existing session roundtrip, answer/transcript hiding, restore invalidation,
grading, ZIP and backup tests remain part of the full App checks.

| Check | Result |
| --- | --- |
| `make app-check AI_PYTHON=...` | Contracts, fixtures, TypeScript, ESLint, 392 frontend tests, native tests, fmt and Clippy pass. The final mutable-baseline edit was followed by the complete native checks again; frontend inputs remain unchanged. |
| Final native `cargo test`, fmt and Clippy (`--all-targets -- -D warnings`) | 187 passed, 13 ignored; no failures. Ignored cases include opt-in performance/large-boundary tests, subprocess entry points and native Keychain roundtrip. The new performance probe is executed separately. |
| `npm --prefix app run test:coverage` | 392 passed, 1 opt-in editor probe skipped; that probe also passes separately. Statements 89.86%, branches 85.11%, functions 87.93%, lines 93.37%; configured thresholds pass. |
| `npm --prefix app run test:browser` (final serial run) | 67/67 pass: desktop, rich content, 360/390 px touch flows and production-build touch navigation. Representative 1280 px answering and 390 px review screenshots were also inspected. Native commands are mocked. |
| `make app-package-check AI_PYTHON=... APP_PACKAGE_REPORT=...` | Production frontend and macOS App/DMG build pass; installer inspection confirms practice-only resources and no embedded AI engines. No installation, signing or notarization acceptance is claimed. |
| Paired native probes | Each version/workload has 21 samples with identical input, probe and output hashes. No wall-clock threshold is added to ordinary CI tests. |

The first browser run had 66 passes and one failed favorite-pagination scenario.
Its trace shows multiple page reloads while native source was being changed;
the test returned to the initial bank page. With source frozen and builds/tests
run serially, the complete 67-test suite passed without changing any assertion.
The original log and trace are retained under `/tmp/practiq-app-browser-*`.
An initial editor command used the repository root and failed to resolve the
App's import alias; running from `app/` passed. Neither first attempt is counted
as successful acceptance.

The [package report](../server/reports/app-performance-20261015-package.json)
retains the actual DMG SHA-256. The package was built after the final runtime
changes; later benchmark-only limit checks do not enter the application binary.
The [acceptance record](../server/reports/app-performance-20261015-acceptance.json)
binds the final runtime and probe hashes to these outcomes and retained logs.

## Reproduction and limits

Run the same probe from the repository root, separately on each source revision:

```sh
PRACTIQ_BENCH_OUTPUT=/tmp/app-snapshot.json TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --offline --release --locked --manifest-path app/src-tauri/Cargo.toml --lib snapshot_copy_stress -- --ignored --nocapture --test-threads=1
```

For the baseline revision, copy only the identical `snapshot_copy_stress` probe
into `shared_snapshots_tests.rs` before compiling. Its existing `shared_session`
fixture is unchanged. Do not substitute the historical shared-snapshot transport
benchmark, which measures a different operation. Keep processes serial and
compare input/probe/output hashes before comparing timings.

The editor probe must run with `app/` as the working directory:

```sh
PRACTIQ_EDITOR_BENCH=/tmp/app-editor.json npx vitest run src/QuestionEditor.performance.test.tsx
```

No Windows or Android native timing, physical-device memory, native WebView
input latency, concurrent archive/draft improvement, clean-machine installation
or live-model quality claim follows from these measurements. Existing copy and
association costs still scale with selected content; no unbounded cache or
weaker validation is used to hide that cost.
