# ZIP response assembly — October 29, 2026

Baseline: `125dae03a9594bd8892818819982df578412e87c`.

The Web client previously kept bounded response chunks, copied them into one
contiguous `Uint8Array`, then passed that array to `Blob`. Export now passes the
validated chunks directly to the native `Blob` constructor. This removes one
ZIP-sized JavaScript reassembly allocation and its copies. It still buffers a
bounded download; native Blob storage and browser peak memory were not measured.

The existing reader owns content-length and observed-byte limits, cancellation,
deadline signals and lock release. It is shared without duplicating validation.
JSON and checksum-verified artifacts still use contiguous `readBytes` results,
including correct handling of subarray offsets. Bodyless response handling keeps
its existing byte-array path. Export retains the 300 MiB cap, same-origin Bearer
authentication, checkpoint/scope checks, ZIP MIME validation and download name.

## Measurement

The [probe](../scripts/benchmark-export.mjs) runs three alternating pairs of
isolated Node/Chromium processes on macOS 27.0.1 arm64, Node 22.23.2 and Chromium
153.0.8010.12. Each process retains five samples per case after one warmup, giving
15 samples per version/case. Fixtures, Response construction, pre-sample garbage
collection and complete output hashing are outside timing. Runs are serial,
separate from tests and builds, with the same locked dependencies.

The real browser loads each checkout's API module and calls `Client.exportBank`
against a synthetic response. Every request must use the expected authenticated
export URL once, release its reader, and return the complete expected bytes,
name, MIME type and size. Input/output hashes and every retained sample are in
the [raw report](../../docs/evidence/2026-10-29-export-chunks/web.json).

| Workload | Before median ms | After median ms | JS bytes copied before / after |
| --- | ---: | ---: | ---: |
| 32 KiB export, 8 KiB chunks | 0.2 | 0.2 | 32 KiB / 0 |
| 16 MiB export, 1 MiB chunks | 2.2 | 1.2 | 16 MiB / 0 |
| 128 MiB export, 1 MiB chunks | 18.1 | 8.4 | 128 MiB / 0 |
| 16 MiB contiguous-byte control | 1.1 | 1.0 | 16 MiB / 16 MiB |
| 32 KiB bodyless control | below timer resolution | below timer resolution | 0 / 0 |

Each 128 MiB pair improves: process medians are 18.5/8.6, 17.7/8.3 and 19.0/8.7
ms. Copy counts instrument JavaScript `Uint8Array.set`, excluding native Blob
internals. Small/control timings do not establish a speedup. This measures local
browser response processing, without service/network throughput, real ZIP
parsing, provider, total download latency or peak-memory claims.

## Verification

- `CI=1 make web-check web-build` passed: types/lint, 228 unit tests, 98.54% line
  and 90.49% branch coverage, 56 synthetic-HTTP Chromium tests and production build.
- The added work-bound test fails on the baseline and passes after the change.
  Ordered nonzero-offset chunk views, empty chunks, binary bytes and Blob
  immutability remain correct. JSDOM still performs its own immutable Blob copy;
  the test counts that copy separately from the removed reassembly.
- Observed overflow cancels/releases the reader. Bodyless limits and streamed
  subarray normalization have focused checks. Existing API tests retain declared
  size, ZIP MIME, authentication, stale checkpoint, deadline and disconnect checks.
- No dependency/configuration, server, native app, schema, credential or paid-call
  change. Hosted CI and maintainer review must pass on the published head.
- Live services, paid providers, Safari and peak RSS were not tested. A single
  revert restores assembly behavior without data migration.

Run from the repository root after installing the locked Web dependencies in
both checkouts; leave the baseline API source unchanged:

```sh
node web/scripts/benchmark-export.mjs \
  --baseline /absolute/path/to/baseline/web \
  --output /tmp/practiq-export-chunks.json
CI=1 make web-check web-build
```
