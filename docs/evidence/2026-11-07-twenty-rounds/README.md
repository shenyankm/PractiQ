# Twenty service CPU experiments

The [report](../../history/performance/twenty-rounds-20261107.md) distinguishes
20 independent candidate edits from repeated samples and the final replay.
Twelve candidates remain; eight were reverted. All inputs are synthetic. No
production/user database, model, Tencent or payment call is part of a probe.

## Evidence

- `ledger.json`: all 20 hypotheses, decisions and rejection reasons.
- `round-NN.patch`: the exact candidate against the previously retained source.
  All 20 patches were replayed in an isolated tree; reverting the eight rejected
  candidates reproduced the final seven modules byte for byte.
- `final-performance.patch`: the combined 12 retained edits against the base.
- `round-NN.json`: three fresh-process AB/BA pairs, 21 samples per side and
  workload, complete result fingerprints, adverse-input results and source hashes.
- `final-CASE.json`: fresh comparisons of the original baseline and final retained
  source, including small and unchanged controls.
- `passive-projection.json`: actual passive result reconstruction through
  checksum-verified temporary local storage; separate sparse-selection Python
  allocation peaks. This does not measure HTTP or provider latency.
- `baseline-profile.txt`: cProfile evidence locating repeated work before edits.
- `manifest.json`: source chain, base commit and preservation of pre-existing
  account/payment/header changes. Optimization modules were clean at that base;
  unrelated dirty files were preserved during the experiments. Later publication validation adjusted obsolete schema assertions and the schema instructions, as documented in the manifest.
- `probe-at-measurement.py`: exact source matching the probe hash in round and
  final-case reports. The maintained script subsequently received import/type
  annotations and equivalent immediate-lambda binding cleanup for lint/type checks.
- `experiment-controller.py`: historical record of candidate transformations and
  the decision rule. It contains execution-local paths and must not be run against
  the already-optimized working tree.
- `verify-first-attempt.txt`: first full gate, with two obsolete schema-table assertions; the failures and their precise correction remain visible.
- `verify.txt` and `verification-summary.json`: final complete verification (3,923 tests passed,
  92% combined coverage, recovery gates and package integrity passed). Focused regression, contract, coverage and recovery evidence
  is recorded separately from benchmark timing. `web-check.txt`, `web-build.txt`,
  `web-browser.txt`, `focused-final.txt` and `audit.txt` retain the other check logs;
  `probes.json` and `probes.md` record the final recovery gates.

The predeclared retention rule requires at least 8% improvement in the selected
large workload, at least two faster process pairs, equal outputs and boundary
outcomes, and no control regression exceeding both 10% and 0.02 ms. A fast change
that alters error behavior is rejected regardless of its timing.

## Reconstruct coherent snapshots

Run from the repository root with the locked dependencies in an existing Python
3.14 interpreter. Do not use a project virtual environment. This copies only the
service package, not credentials, storage or user data. The reconstruction keeps
unchanged current consumers, including any separate payment work, coherent on
both sides. Only the seven performance modules are restored from the recorded
base in the `before` snapshot.

```sh
AI_PYTHON=/absolute/path/to/python3.14
"$AI_PYTHON" - <<'PY'
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

root = Path.cwd()
manifest = json.loads((root / 'docs/evidence/2026-11-07-twenty-rounds/manifest.json').read_text())
target = Path(tempfile.mkdtemp(prefix='practiq-perf20-replay-'))
for label in ('before', 'after'):
    shutil.copytree(root / 'server/src/practiq_ai', target / label / 'practiq_ai',
                    ignore=shutil.ignore_patterns('__pycache__'))
for module in manifest['optimizationModules']:
    original = subprocess.check_output(['git', 'show',
        manifest['baseCommit'] + ':server/src/practiq_ai/' + module])
    (target / 'before/practiq_ai' / module).write_bytes(original)
print(target)
PY
```

Use the printed directory for the following arguments:

```sh
"$AI_PYTHON" server/scripts/benchmark_twenty_rounds.py \
  --before /printed/directory/before --after /printed/directory/after \
  --case review --output /tmp/practiq-review-replay.json
"$AI_PYTHON" server/scripts/benchmark_twenty_projection.py \
  --before /printed/directory/before --after /printed/directory/after \
  --output /tmp/practiq-projection-replay.json
```

The maintained probe lists all cases with `--help`. For exact historical probe
hash parity, run `probe-at-measurement.py` with the same arguments. To reproduce
an individual round, create two snapshots from the recorded base, apply only
earlier **retained** patches to both, then apply the chosen round's patch only to
`after`. Reverted patches are used only for their individual experiment. Do not
apply all 20 patches cumulatively, and do not benchmark while builds or tests run.

The benefit is workload-specific. Prefix-containing math-source controls retain
the existing scans; small and unchanged controls are not counted as wins. No
end-to-end import speed, actual OCR/model latency, native UI, process RSS,
production throughput or power-loss durability claim follows from these probes.
