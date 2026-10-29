# Tested resume compatibility

Issue #193 starts with evidence for the existing conservative execution gate. This change does **not** introduce a new compatibility identifier or authorize checkpoints to resume across arbitrary source/dependency upgrades. The existing complete lock-byte audit remains in the signature, including development/build-only metadata; keep the original deployment when compatibility has not been established.

## Current boundary

`execution.signature()` requires exact equality of state version (currently 7), `code_version()`, Python patch version, the nine recorded runtime package versions and trusted semantic settings. The code digest includes selected parser/contract/runtime sources and every byte of the bundled `uv.lock` (or source-tree fallback). It is an audit input, not a semantic equivalence proof. The recorded package list is not a complete installed transitive dependency inventory. The optional AI review/repair/recheck branch and `AI_IMPORT_REVIEW` configuration have been removed. Old environment values cannot enable it. Historical saved audit artifacts, warnings and usage remain readable. The changed code/configuration fingerprint still blocks resuming unfinished old tasks: drain them on their original deployment or explicitly create a new task; do not rewrite their signatures.

Semantic settings include model/provider identity and the fixed Responses transport, parser limits, storage root, per-task model budgets and the run deadline (`AI_RUN_TIMEOUT_SECONDS`); changing that deadline rejects resume. API keys, concurrency and admission flags are excluded, along with model request (`AI_AGENT_TIMEOUT_SECONDS`), storage (`AI_STORAGE_TIMEOUT_SECONDS`) and upload (`AI_UPLOAD_TIMEOUT_SECONDS`) timeouts. Office executable/version identity is checked separately through the normalized-source manifest. Source/artifact hashes, task expiry, model receipts, budgets, maintenance admission and explicit retry authorization retain their own checks; signature compatibility does not bypass them.

## Synthetic checkpoint matrix

`tests/test_resume_compatibility.py` pauses the actual LangGraph parser after one successful unit and one failed unit, then explicitly retries the failed unit. It copies source/lock files into a temporary tree before changing audit bytes, uses fake model/storage providers and makes no external model calls.

| Change after pause | Current result | Checked invariant |
| --- | --- | --- |
| Unchanged deployment | Resume | Only the failed unit calls the model again |
| API key rotation | Resume | Source, prior usage and successful unit remain |
| Model request timeout | Resume | Same semantic signature and explicit retry |
| Provider RPM capacity | Resume | Same semantic signature and explicit retry |
| Model identity | Reject | No new call, artifact write or usage change |
| Model API transport | Reject | Prior results and usage remain on their original protocol |
| Parser page limit | Reject | Original units/source remain |
| Task model-call budget | Reject | Original usage/receipts remain |
| Run deadline | Reject | Existing task/run allowance is not redefined |
| State version | Reject | No attempt to reinterpret old state |
| Recorded Pydantic version | Reject | Runtime mismatch remains conservative |
| Source comment, identical installed runtime | Reject | Audit bytes are not rewritten |
| Lock comment, identical installed runtime | Reject | Full lock-byte audit remains enforced |
| Remove the dev-only Coverage requirement and package record | Reject | Locked runtime dependency closure and installed runtime remain unchanged; audit bytes differ |
| Remove the Trove Classifiers build constraint | Reject | Locked runtime dependency closure and installed runtime remain unchanged; build provenance is not established |
| Missing stored signature | Reject | Deterministic conservative fallback |

Rejected cases retain unit results, source reference, usage, model-call receipts, Tencent job receipts, spent-call budgets, allocated allowances and reserved-call totals. Accepted cases retain the original execution metadata, prior usage, successful unit results, existing receipts and spent-call records; exactly one additional retry call consumes a new budget slot rather than resetting prior spending. Tencent job receipts remain unchanged on both paths. Other restart, PostgreSQL recovery, expiry and source-integrity behavior remains covered by existing runtime/task tests.

Estimated-cost settings are admission controls excluded from the execution signature. `tests/test_cost_budget.py` separately verifies that a model cost rejection remains uncached: explicit checkpoint resume rechecks admission after raising the task/daily cost limit or entering a new UTC day. Rejected call records and prior reservations remain intact, and the completed Tencent job is not submitted again.
Cost admission precedes durable model-call spending: repeated cost rejections consume no model-call slots, leaving the unit's correction allowance available after explicit recovery.

The two structured lock edits operate only on temporary copies, not the service's installed environment or repository lock/manifest. The test compares the root's runtime requirements and complete reachable package records (versions, dependencies, sources and artifact hashes), conservatively following all locked extras and markers without platform filtering. Coverage is outside that closure; the `psycopg-binary` extra is inside it. Separate negative controls change wheel hashes for OpenAI, LangGraph Checkpoint and Psycopg Binary and must change the comparison. The helper fails explicitly for multi-version locks rather than silently collapsing records. This comparison is test evidence, not a production compatibility identifier or general uv resolver. It does not rebuild/install either candidate, test a real dependency upgrade or establish model equivalence.

## Why identifier separation remains blocked

Equal runtime lock records and nine installed package versions are not sufficient proof of equivalent runtime artifacts. `runtime_version()` does not inventory OpenAI or LangGraph Checkpoint itself, all transitive dependencies, installed wheel hashes or native build outputs. A build-constraint edit can alter a source-built runtime artifact without changing its package version or the runtime lock records. The synthetic edits demonstrate the conservative rejection and preservation boundary, not safety of excluding all development/build metadata.

Before admitting even a selected cross-deployment resume, a follow-up needs:

- A precisely bounded candidate pair with relevant installed dependency/artifact and toolchain provenance, plus checkpoint deserialization, parser/model semantics and provider-receipt recovery evidence. A TOML-comment-only exception does not establish this broader boundary.
- Versioned execution metadata that retains the complete source/lock/toolchain audit identity separately, preserves the saved original identity and conservatively rejects historical, missing or unknown compatibility metadata. Existing signatures must not be rewritten or automatically adopted.
- One consistent compatibility decision at graph load/control, `execution.validate_execution()`/`preflight()`/`guard()` and both task-state projections in `task_api.py`. Changing the graph gate alone would disagree with advertised actions. Source/artifact verification, normalized Office engine identity, trusted settings, expiry, runtime/model/state gates, usage/receipts, budgets, admission and explicit paid-work authorization must still hold independently.

No production gate, signature format or task-state projection is changed by this evidence-only work. Issue #193 remains open; a separate identifier is not delivered.

## Upgrade and recovery

1. Resolve paused/review tasks through their existing explicit actions before enabling maintenance, or retain them for later recovery on the original deployment. Maintenance rejects resume, retry and partial acceptance as well as new tasks/runs. Enable maintenance admission control to let already queued runs drain on their original deployment.
2. Retain that exact image/interpreter, lock, database/checkpoints, Store, local files and trusted configuration while unfinished tasks remain recoverable. Protect credentials separately.
3. If an execution signature mismatches, restore the original deployment or explicitly create a new task. Do not rewrite the saved signature, reset call budgets, refund unknown usage, or silently replay model work.
4. A future narrower compatibility identifier needs a versioned fallback, complete relevant runtime dependency provenance and tested state/parser/provider-receipt transitions, including actual narrowly selected upgrades. Comment-only tests above are insufficient to permit those upgrades.

The current safe limitation is intentional: even a non-semantic development/build lock edit blocks old checkpoints. Tests and this operational boundary can be reviewed independently while #193 remains open for any future evidence-backed identifier separation.
