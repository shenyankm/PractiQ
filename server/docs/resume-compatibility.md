# Tested resume compatibility

Issue #193 starts with evidence for the existing conservative execution gate. This change does **not** introduce a new compatibility identifier or authorize checkpoints to resume across arbitrary source/dependency upgrades. The existing complete lock-byte audit remains in the signature, including development/build-only metadata; keep the original deployment when compatibility has not been established.

## Current boundary

`execution.signature()` requires exact equality of state version (currently 7), `code_version()`, Python patch version, the nine recorded runtime package versions and trusted semantic settings. The code digest includes selected parser/contract/runtime sources and every byte of the bundled `uv.lock` (or source-tree fallback). It is an audit input, not a semantic equivalence proof. The recorded package list is not a complete installed transitive dependency inventory.

Semantic settings include model/provider identity, parser limits, storage root, per-task model budgets and the run deadline (`AI_RUN_TIMEOUT_SECONDS`); changing that deadline rejects resume. API keys, concurrency and admission flags are excluded, along with model request (`AI_AGENT_TIMEOUT_SECONDS`), storage (`AI_STORAGE_TIMEOUT_SECONDS`) and upload (`AI_UPLOAD_TIMEOUT_SECONDS`) timeouts. Office executable/version identity is checked separately through the normalized-source manifest. Source/artifact hashes, task expiry, model receipts, budgets, maintenance admission and explicit retry authorization retain their own checks; signature compatibility does not bypass them.

## Synthetic checkpoint matrix

`tests/test_resume_compatibility.py` pauses the actual LangGraph parser after one successful unit and one failed unit, then explicitly retries the failed unit. It copies source/lock files into a temporary tree before changing audit bytes, uses fake model/storage providers and makes no external model calls.

| Change after pause | Current result | Checked invariant |
| --- | --- | --- |
| Unchanged deployment | Resume | Only the failed unit calls the model again |
| API key rotation | Resume | Source, prior usage and successful unit remain |
| Model request timeout | Resume | Same semantic signature and explicit retry |
| Provider RPM capacity | Resume | Same semantic signature and explicit retry |
| Model identity | Reject | No new call, artifact write or usage change |
| Parser page limit | Reject | Original units/source remain |
| Task model-call budget | Reject | Original usage/receipts remain |
| Run deadline | Reject | Existing task/run allowance is not redefined |
| State version | Reject | No attempt to reinterpret old state |
| Recorded Pydantic version | Reject | Runtime mismatch remains conservative |
| Source comment, identical installed runtime | Reject | Audit bytes are not rewritten |
| Lock comment, identical installed runtime | Reject | Full lock-byte audit remains enforced |
| Missing stored signature | Reject | Deterministic conservative fallback |

Rejected cases retain unit results, source reference, usage and provider Store receipts. Accepted cases retain prior usage and successful unit results and make exactly one additional retry call. Other restart, PostgreSQL recovery, expiry and source-integrity behavior remains covered by existing runtime/task tests. This matrix does not test a real dependency upgrade or establish model equivalence.

## Upgrade and recovery

1. Resolve paused/review tasks through their existing explicit actions before enabling maintenance, or retain them for later recovery on the original deployment. Maintenance rejects resume, retry and partial acceptance as well as new tasks/runs. Enable maintenance admission control to let already queued runs drain on their original deployment.
2. Retain that exact image/interpreter, lock, database/checkpoints, Store, local files and trusted configuration while unfinished tasks remain recoverable. Protect credentials separately.
3. If an execution signature mismatches, restore the original deployment or explicitly create a new task. Do not rewrite the saved signature, reset call budgets, refund unknown usage, or silently replay model work.
4. A future narrower compatibility identifier needs a versioned fallback, complete relevant runtime dependency provenance and tested state/parser/provider-receipt transitions, including actual narrowly selected upgrades. Comment-only tests above are insufficient to permit those upgrades.

The current safe limitation is intentional: even a non-semantic development/build lock edit blocks old checkpoints. Tests and this operational boundary can be reviewed independently while #193 remains open for any future evidence-backed identifier separation.
