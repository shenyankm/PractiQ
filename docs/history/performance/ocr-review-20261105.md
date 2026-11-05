# OCR review and context planning — November 5, 2026

Baseline: `6ec1c5d98a109118997fdb13a3f122062865486a` (clean, current `main`).
Implementation: `e3baa69a`. Python 3.14.7, macOS 27.0.1, Apple arm64.
The [evidence directory](../../evidence/2026-11-05-ocr-review/) retains raw samples,
output hashes, first failures and separate live/substitute workflow results.

## Scope and decisions

Twenty targeted optimization/control experiments retained eight local changes:
printed-number lookup in OCR review; deferred rendered formula normalization;
an empty secondary-formula-evidence return; answer-page lookup by number;
failed-page prefix counts; stopping an already-overfull context selection;
empty-label repair return; and native-table image associations grouped by page.
A round here is a hypothesis or boundary experiment, not a separate production
edit. Twelve controls keep existing behavior instead of adding another index,
cache, deduplication rule or weaker validation. No new dependency or configuration
is introduced. The production diff is confined to four existing service modules.

The profiler found over 25 million `rsplit` calls across the repeated baseline
1,000-question runs. A call-local map removes the repeated complete question
scan while retaining **lists** of owners. Missing IDs still use stem matching;
repeated printed source numbers remain ambiguous. The map does not deduplicate
questions or change source reading order.

Formula text is still scanned with the same delimiter and escape rules. The
rendered target is normalized once only if a nonempty closed formula needs it.
No source formula, missing-material warning or prefix review flag is removed.
No rendered/source text is cached across calls.

Context plans retain local pages first, the same eight-page cap, sorted output,
unique-number answer associations, split-source restrictions and inclusive
failed-page barriers. Once a full selection rejects another reachable page,
its incomplete flag is already true and later candidates cannot add anything.
Native-table image grouping runs lazily only for native tables; ordinary OCR
pages keep their direct fixed-coordinate lookup. XML/member validation, image
verification, ZIP limits and ambiguity handling remain in place. Empty label
sets skip a scan; crossing-label collision checks and the 1,000-element guard
are retained.

## Paired measurements

`benchmark_ocr_review.py` runs three alternating AB/BA process-local pairs, each
with one warmup and seven retained samples per variant (21 per variant). GC is
enabled; setup, output hashing and assertions are outside timing. Review includes
defensive question copies. Each entire output must match its baseline hash and
source objects must remain unchanged. Baseline review uses baseline formula
helpers; bundle decode uses the baseline crop helper.

The table compares the complete baseline and final implementations, so combined
review/context gains cannot be assigned independently to one change. The raw
JSON records fixture size and shape. Formula cases use a short source and a
large rendered target, modeling shared material; they are not representative
whole-import speedups. Recovery verification was active during the final run;
these are warm local medians, not isolated-host, p95, provider or HTTP timings.

| Round | Hypothesis / retained boundary | Before ms | After ms | Reduction |
| --- | --- | ---: | ---: | ---: |
| 1 | Index printed IDs instead of scanning every question | 192.9244 | 31.0224 | 83.92% |
| 2 | Preserve substring fallback for missing IDs; no speculative text index | 14.2641 | 7.8475 | 44.98% |
| 3 | Preserve multiple owners of a printed ID; no unique-ID shortcut | 20.8975 | 6.1283 | 70.67% |
| 4 | Keep repeated source records ambiguous; no deduplication shortcut | 21.0354 | 6.0161 | 71.40% |
| 5 | Defer rendered normalization when source has no math | 2.2152 | 0.0008 | 99.97% |
| 6 | Avoid normalization for unclosed formulas; preserve token scanner | 2.2162 | 0.0006 | 99.97% |
| 7 | Avoid normalization for empty formulas | 2.2126 | 0.0008 | 99.97% |
| 8 | Math-heavy control: retain literal formula checks; no global cache | 2.3141 | 2.3185 | -0.19% |
| 9 | Return immediately for absent secondary formula evidence | 0.1864 | 0.0001 | 99.93% |
| 10 | Index answer pages by printed number | 1.7762 | 0.6952 | 60.86% |
| 11 | Keep repeated question numbers from linking distant answers | 1.7805 | 0.6992 | 60.73% |
| 12 | Use prefix counts for inclusive failed-page barriers | 70.4290 | 4.1708 | 94.08% |
| 13 | Stop selection after a full plan encounters another linked page | 16.4808 | 1.7702 | 89.26% |
| 14 | Local-only control: measure index overhead; retain context policy | 0.8441 | 0.7089 | 16.02% |
| 15 | Stop label repair when the figure contains no eligible labels | 0.0910 | 0.0188 | 79.35% |
| 16 | Keep nearby-content collision guard; no spatial index | 1.7449 | 1.7268 | 1.04% |
| 17 | Keep dense-page guard; no unbounded label repair | 0.0002 | 0.0002 | 0.00% |
| 18 | Group validated native-table image associations once by page | 10.9478 | 8.7836 | 19.77% |
| 19 | Combined formula-loss control: retain review findings | 20.4110 | 6.1766 | 69.74% |
| 20 | Combined prefix-formula control: retain per-question review flags | 20.9433 | 6.2657 | 70.08% |

Rounds 8, 16 and 17 establish no material speedup. No additional cache, spatial
index or dense-page repair is justified by those controls. Rounds 2–4, 11,
19–20 preserve missing IDs, duplicate ownership, repeated source records,
formula-loss findings and prefix review flags. Their gains include the shared
changes above; they do not represent additional independent optimizations.

Reproduce from the repository root with the installed service interpreter:

```sh
AI_READ_ONLY=1 "$AI_PYTHON" server/scripts/benchmark_ocr_review.py \
  --baseline 6ec1c5d98a109118997fdb13a3f122062865486a \
  --output /tmp/practiq-ocr-review.json
```

## Real workflow acceptance and first failure

The live run used production Web assets and Chromium, a loopback Uvicorn service,
disposable PostgreSQL/RabbitMQ, real local files, Tencent parsing and three
recorded model calls. It imported one TXT, one Markdown and one PNG source.
All nine stems, modes and supplied answers matched; every downloaded ZIP matched
the HTTP result. All three immediate release Rust/SQLite practice/reopen/restore
checks and all 24 repeated native cases passed.

**Strict live content acceptance remains 2/3, not 3/3.** The PNG model result
omitted `questionTypeId` on all three questions. Their `missingFields` and
`needsReview` flags are retained. The harness correctly failed with
`IMPORT_OR_CONTENT_FAILED:png`; there was no retry or replacement success run.
This is a real-model metadata-completeness limit, not a grading accuracy claim.
These optimizations never assign that field or remove its review flag.

The live service code hash was
`140a376c3ba6c7a9e558a9d0c7d345515843b4ac7314fdfa834d5c35550233fb`,
before the final lazy native-image-index allocation and failed-prefix cleanup.
The final substitute run used
`c4da2aea99461675d48ac2af29df7be53b79c00ca42f78f9271f9d4cf0303b5c`,
passed all three imports and 24 repeated native cases, and used the same production
HTTP/browser/storage/native paths with provider/model substitutes. Reports record
the baseline Git revision because the implementation was still uncommitted;
source hashes identify the actual dirty worktree. Configuration is omitted from
public workflow reports. Neither run exercises Tauri IPC/WebView or a clean
installed package. Three tiny sources establish no capacity, extraction-quality
rate or end-to-end performance improvement.

## Verification

- Focused fidelity/context/archive/crop tests: **107 passed**.
- Web types, lint, coverage and build: **270 tests passed**, one opt-in benchmark
  skipped; **57 Chromium checks passed**.
- Release native suite: **277 passed**, 27 opt-in workloads skipped. The workflow
  workload was run separately as described above.
- Final `make verify`: **3,792 passed**, **93% coverage** (90% required); lockfile,
  Ruff, Pyright, evaluation fixtures, recovery probes, wheel/sdist build and
  source/archive integrity passed. Raw output: `verify-final.txt`.

An initial full verification was deliberately interrupted with SIGINT to freeze
the two allocation-only cleanups above. Its incomplete coverage/probe result is
not a pass. The complete final run supersedes that attempt. Security/diff review
covers all changed callers and preserves bounded ZIP/XML/image validation,
explicit model triggers, source hashes, immutable snapshots and credential
boundaries. No migration, schema, prompt, API, backup or desktop code changed.
The existing execution signature still rejects resume across source changes;
finish old work on its original deployment or create an explicit new task.
