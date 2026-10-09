# Web font packaging measurements (2026-10-09)

Baseline: `6574bb2d68bf94f0e199c8e8dbb09fb8fcd9b170`, the merged PostgreSQL service change (#167). The working tree was clean before this experiment. This record covers one packaging optimization, not completion of the broader engineering optimization goal or production acceptance.

## Evidence and decision

The Web build retained KaTeX WOFF2, WOFF and TTF representations of the same 20 font faces. The practice app already removes the fallback representations in its Vite transform. Apply that existing approach to Web without sharing runtime code, changing dependencies, dropping font families or changing math markup. Vite's existing modern browser targets support WOFF2. Older browsers outside those targets are not established by this check.

The affected paths are the Web Vite configuration, its browser test and production-preview test configuration, and documentation. API, ZIP, practice data, backups, server contracts, model input and explicit model-call triggers are unchanged. Roll back by reverting this PR and rebuilding Web; there is no data migration.

Acceptance: remove only WOFF/TTF alternatives, retain every font face and WOFF2 file, keep initial assets unchanged, and pass Web types, lint, coverage, browser flows and a built-font smoke. Reject the experiment if a face fails to load or rendering behavior regresses. Do not claim faster builds without a difference exceeding sample variation.

## Environment and method

macOS 27.0.1 arm64, 16 GiB host memory, 10 logical CPUs; Node `v22.23.2`, npm `10.9.8`, Vite `8.3.0`, TypeScript `7.0.2`, KaTeX `0.18.2`. Locked Web dependencies were installed with `make web-install` before measurements. No real models were called.

The [measurement script](evidence/2026-10-09-web-fonts/measure_web.py) invokes `npm --prefix web run build` sequentially three times in each state. Clean samples remove `web/dist`, `web/node_modules/.vite` and root Web `*.tsbuildinfo`; incremental samples retain them. Dependencies and OS file caches remain warm: these are clean build-cache samples, not fresh-machine installation or OS-cold measurements. Do not infer CI or native compiler speed from these frontend samples.

Run from the repository root with an existing Python 3.14+ interpreter, selecting a new output path for each phase:

```sh
python3.14 docs/evidence/2026-10-09-web-fonts/measure_web.py /absolute/new-before.json before
# Apply the Web font transform, using the identical lockfile and toolchain.
python3.14 docs/evidence/2026-10-09-web-fonts/measure_web.py /absolute/new-after.json after
```

Raw [before](evidence/2026-10-09-web-fonts/web-before.json) and [after](evidence/2026-10-09-web-fonts/web-after.json) reports retain all samples, input hashes and built-asset hashes. Their `baselineSha` identifies the checked-out source; candidate configuration hashes distinguish the uncommitted experiment. Initial JS/CSS means files linked directly from `index.html`, excluding lazy result-review resources, logo and fonts. Gzip is computed per initial file with fixed timestamp; complete static size includes every file under `dist`, uncompressed.

## Results

| Metric | Baseline | Candidate | Conclusion |
| --- | ---: | ---: | --- |
| Complete static resources | 2,059,410 B | 1,240,096 B | 819,314 B / 39.8% smaller in every sample |
| Initial JS/CSS | 332,043 B | 332,043 B | Unchanged |
| Initial JS/CSS gzip | 102,754 B | 102,754 B | Unchanged |
| External font bytes | 1,072,948 B | 256,168 B | Remove alternative formats only |
| External font files: WOFF2 / WOFF / TTF | 19 / 20 / 20 | 19 / 0 / 0 | One of the 20 WOFF2 faces is inlined |
| Clean build median (range), seconds | 0.510 (0.488–2.569) | 0.537 (0.477–0.730) | No speed improvement established |
| Incremental build median (range), seconds | 0.488 (0.477–0.495) | 0.473 (0.472–0.474) | Small sample; no stable speed claim |

All 19 external WOFF2 file hashes are identical. The browser regression loads all 20 faces, compares their count with the installed KaTeX stylesheet, checks successful loads and permits only WOFF2 font requests. A built Chromium smoke passed after the candidate build. This confirms font delivery, not pixel equivalence across every math expression or browser.

## Validation and limits

- `make web-install`: passed; locked dependencies installed, npm reported no vulnerabilities.
- `make web-check`: passed, including types, lint, 55 unit tests and 19 Chromium browser tests. Coverage: 95.39% statements, 88.82% branches, 97.82% functions, 97.54% lines.
- Six baseline and six candidate `npm --prefix web run build` samples: passed.
- `PRACTIQ_WEB_BUILT=1 npm --prefix web run test:browser -- --grep 'all KaTeX font faces'`: passed, one built-asset smoke using intercepted synthetic API data, no service/provider calls.

Service image size/build time, App assets/installers, Windows/Android native interactions, cross-browser pixel comparisons, CI timings and production capacity are outside this packaging experiment. Removing about 0.78 MiB of copied Web assets does not establish the same image-layer or compressed-installer reduction. GitHub checks and Codex review must pass at the final PR head before squash merge; local checks alone do not authorize claiming a merged result.
