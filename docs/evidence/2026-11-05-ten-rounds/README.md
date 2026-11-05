# Ten source-validation performance rounds

The [acceptance report](../../history/performance/ten-rounds-20261105.md) records
all ten experiments, seven retained changes, three rejected changes, checks and
limits. All fixtures are synthetic. No real provider calls or user databases are
used. Legacy table inputs test saved-record compatibility only.

## Evidence files

- `round-NN.patch`: that round's exact production candidate relative to the
  previously retained state. Rounds **01, 07 and 08 are rejected**.
- `round-NN.json`: preliminary measurement; `round-NN-acceptance.json`: final
  replay with the fixed harness. Both preserve raw samples and source hashes.
- `baseline-to-final.json`: separate original-to-final comparison, including
  passive completed-result projection through verified temporary local storage.
- `projection-preflight.json`: preliminary combined-path check.
- `round-08-rejection.txt`: failing malformed-JSON regressions that rejected round 8.
- `pre-rejection-verify.txt`: intentionally interrupted verification of the withdrawn candidate; its incomplete coverage/probe gates failed.
- `baseline-to-final-pre-rejection.json`: superseded combined measurement before round 8 was removed.
- `post-rejection-benchmarks.txt`: downstream replay after that removal; the
  authoritative round-9 rerun is in `round-09-final.txt`.
- `acceptance-benchmarks.txt`: first fixed-harness replay output. Its round 9/10
  and combined results are superseded by the post-rejection reports above.
- `focused-initial.txt`, `focused-mid.txt`: intermediate regression runs.
- `verify.txt`: complete final `make verify` output; final probe/coverage summaries
  are archived alongside it. `verification-summary.json` records the final exit
  code, test counts, coverage, probes and evidence hashes.
- `source-manifest.json` and `final.patch`: final source identity, retained/rejected
  round lists, consumer-check outcomes and the combined production diff.

The harness loads complete snapshots of both modules in each isolated process,
then imports consumers. Each comparison uses AB, BA, AB process order, one warmup
and seven retained samples per side/process. No tests run concurrently with final
performance measurements. Output hashes must match across every baseline and
candidate run. GC stays enabled. Counts for `normalize`/`literal` mean repeated
phrases; other counts mean questions/records or scalar comparisons. Exact input
construction is in the harness.

## Reproduce original versus final

Run from the repository root with the existing Python 3.14+ interpreter and
locked dependencies. The surrounding checkout must match this acceptance's
unchanged consumers; the initial source revision is
`4cdc1b327872d2018444e01ac7e186d1ef468735`.

```sh
AI_PYTHON=/path/to/python3.14
task_tmp=$(mktemp -d)
module_path=server/src/practiq_ai/graphs
mkdir -p "$task_tmp/before/$module_path" "$task_tmp/after"
for name in chunking answer_evidence; do
  git show "4cdc1b327872d2018444e01ac7e186d1ef468735:$module_path/$name.py" \
    > "$task_tmp/before/$module_path/$name.py"
done
cp -R "$task_tmp/before/." "$task_tmp/after/"
for round in 02 03 04 05 06 09 10; do
  patch -s -p1 -d "$task_tmp/after" \
    < "docs/evidence/2026-11-05-ten-rounds/round-$round.patch"
done
PYTHONPATH=server/src "$AI_PYTHON" server/scripts/benchmark_ten_rounds.py \
  --before "$task_tmp/before/$module_path" \
  --after "$task_tmp/after/$module_path" \
  --cases projection presence cold-plan records answers answer-match scalar \
    normalize literal evidence trees duplicates \
  --output "$task_tmp/baseline-to-final.json"
```

For a single round, first apply only **earlier retained** patches to both
snapshots, then apply that round's patch only to `after`. Include rejected patches
only when measuring their individual candidate. Pass that row's cases below.
The final replay also asserted that applying the seven retained patches exactly
reconstructed both final production modules.

| Round | Cases |
| --- | --- |
| 01 | `presence cold-plan` |
| 02–03 | `records answers` |
| 04 | `answer-match answers` |
| 05 | `scalar answer-match answers` |
| 06 | `normalize evidence` |
| 07 | `evidence` |
| 08 | `duplicates` |
| 09 | `trees duplicates` |
| 10 | `literal scalar answer-match answers` |

These measurements establish scoped local CPU differences. They do not measure
Tencent/model latency, production throughput, RSS, WebView/IPC, or native GUI
responsiveness. Projection process ranges overlap; its observed median difference
is not a stable general read-latency guarantee.
