# Grading experiment evidence

The [dated report](../../performance-grading-arrays-20261009.md) records the fixed model, anchors, budget approval, observed results and limits.

- `baseline.json` / `arrays.json`: original evaluator reports, three repetitions per anchor, model substitutes not used.
- `rejected-null-context.json`: rejected single-factor serialization experiment; its source change was reverted.
- `summary.json`: evaluator/source provenance, score totals, per-repetition elapsed time/calls, token/cost totals and cumulative budget snapshot.
- `provider-ledger.json`: each outbound call in these three phases, status, complete usage, list-price cost estimate and duration. Unknown status would stop further calls; no unknown call occurred here.

All source content is the existing synthetic evaluation material. The original reports retain their temporary driver hash and source SHA; candidate code hashes distinguish the uncommitted factor. Reported durations include receipt/database work and actual provider requests. These five anchors are reference-score checks, not independent teacher calibration or full document-parser acceptance.
