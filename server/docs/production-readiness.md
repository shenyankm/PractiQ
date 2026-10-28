# Production import boundaries and preflight

This guide targets the existing personal, single-process deployment. Keep the
service, PostgreSQL, RabbitMQ and exporters on loopback/private interfaces; expose
only the authenticated Web/API through the trusted HTTPS entry point. Follow
[operations](operations.md), [delivery/recovery](rabbitmq.md) and
[matching backups](service-backups.md). The commands below do not certify a
deployment merely because they exist in the repository.

## Paid calls and estimated-cost limits

Model connection failures, timeouts and ambiguous server failures stop with
`MODEL_RESULT_UNKNOWN`. Keep their durable call receipts and inspect the provider
before an explicit retry. A known Tencent task is polled again; an uncertain
submission is never automatically sent again. Structured-output correction still
has a bounded paid-call allowance. A queue ACK is not a provider execution receipt.

Optional cost admission uses the existing PostgreSQL Store and admission
transaction. Before sending a paid request it atomically saves its reservation
receipt, lifetime task/grading total and UTC-day total. All calls share the daily
limit, including explicit service grading. No database schema or App/ZIP contract
changes are required. Reservations live outside task namespaces, so task deletion,
expiry and process restarts do not refund them. Unknown attempts remain reserved;
known completions and rejections also retain their conservative reservation. A
replayed reservation identity cannot spend twice. A failed reservation does not
send a provider request.

Configure limits in the trusted service environment. `AI_TASK_COST_LIMIT` and
`AI_DAILY_COST_LIMIT` are positive amounts; leaving both blank disables admission.
When either is set, also provide `AI_COST_CURRENCY` (three uppercase letters),
`AI_COST_INPUT_PER_MILLION`, `AI_COST_OUTPUT_PER_MILLION` and
`AI_COST_TENCENT_PER_PAGE`. Prices may be zero only when the operator's contract
supports that rate. All amounts have at most six decimal places and are stored as
integer millionths of the selected currency. Currency changes conflict with
retained totals rather than resetting them. Budget limits can be raised without
changing document semantics; each receipt binds its price configuration hash.

LLM reservation uses serialized UTF-8/Base64 input bytes, schema/message overhead
and the configured maximum output tokens. This intentionally overestimates common
tokenization, especially image inputs. Tencent uses the known rendered page count,
or the configured page ceiling when page count is unavailable (including text and
native Office). These are conservative **estimates**, not a provider invoice or
guaranteed monetary ceiling. Unusual tokenization, pricing changes, taxes, account
traffic outside this service and a restored older database need independent
reconciliation. Set provider-side account limits too. Retain the cost namespace
with the complete database backup; reconcile charges since its snapshot before
reenabling paid work after restoration.

`COST_BUDGET_EXCEEDED` stops admission; inspect the retained reservations and use
the existing explicit resume after adjusting a limit or waiting for a new UTC day.
A new day does not reset the task's lifetime total. Missing durable cost storage
fails closed. Passive task reads, metrics, export and backup never reserve costs
or invoke models. Metrics expose configured limits and daily reserved millionths;
they do not expose prompts, filenames or credentials.

## Native worker sandbox

Linux/macOS defaults to `AI_WORKER_SANDBOX=required`; the deployment Compose file
requires it explicitly. Linux uses unprivileged Landlock ABI 3+ (Linux 6.2+ with
Landlock enabled) and seccomp on x86-64/aarch64. macOS uses its OS sandbox profile.
Unsupported or unavailable enforcement stops the worker with
`WORKER_SANDBOX_UNAVAILABLE`; there is no silent fallback. Other development OSes
retain their existing process controls and must explicitly support a required
sandbox before claiming this production profile.

The existing extractor/Office processes apply restrictions before parsing source
bytes or starting watchdog threads. They can read runtime/code/font locations and
the explicitly configured Office installation, and write only their private work
directory and standard null/random devices. Other sources, persistent artifact
directories and service configuration are excluded. Linux permits private Unix
listeners/socketpairs but blocks client connections, IP/packet sockets,
process-inspection/handle bypasses and io_uring; macOS permits Unix IPC only in
the workspace and denies IP networking. Restrictions inherit into converter
children. Existing timeouts, process-group cleanup and container limits remain.
This complements the non-root/read-only container; it is not a VM or a guarantee
against kernel vulnerabilities. Keep the trusted runtime/Office installation
separate from secrets and user-controlled executable directories.

On Linux configure the native `soffice.bin`, for example
`/usr/lib/libreoffice/program/soffice.bin` in the supplied image, with its exact
`--version`. The `soffice`/`libreoffice` launcher requires shared `/tmp` IPC and is
incompatible with this policy. The worker rejects write-permission probes so
LibreOffice uses the private `OSL_SOCKET_PATH`; actual file writes still use
Landlock permissions. Private HOME/XDG paths contain its caches and profile.
The native binary may request one profile-initialization restart (exit 81), using
the same profile and original deadline; general failures are not retried.

Run `make image-check` on the actual Linux host/kernel before accepting files.
It verifies real PDF rendering and PPTX conversion in the hardened image. Run
`tests/test_worker_sandbox.py` on each supported host for explicit denied-file,
denied-network and descendant tests. The authenticated sandbox metric reports
required configuration, not a successful host sandbox probe.
`AI_WORKER_SANDBOX=disabled` is an explicit development escape hatch; Compose
overrides it to `required`, and production preflight rejects the disabled metric.

## Bounded source context

The ordinary window remains the previous two pages, primary page and next page.
For unsplit PDFs, the program can additionally select physical one-based
`see page 12` / `见第12页` ranges, or
an answer-key page whose printed question number belongs to exactly one question
page. Reused numbers do not establish distant answer ownership. No association
crosses a failed page; at most eight pages are retained. Out-of-range, interrupted
or oversized links keep their primary questions reviewable. The model still
cannot add question starts from context, invent answers or change figure bounds.
Split/tiled inputs and formats without a verified original PDF page mapping cannot
use printed page numbers as OCR indexes; those references remain reviewable.

Scorer `6.7.0` checks the ordinary window plus explicitly recorded source links
and the eight-page bound. It permits the existing separate primary/context
correction allowances only when a context pass is observable. Freeze a fresh
baseline; older scorer reports are not directly comparable. `confidenceScore`
remains the mean of model-reported confidence values, **not measured accuracy**.

## Independent holdout evidence

Keep the existing synthetic datasets unchanged as regression evidence. For a real
acceptance campaign, obtain authorized source documents, annotate them without
model-generated gold, have a different reviewer check them, and freeze a private
manifest with `split: "holdout"`. Preserve null answers, omissions, source links,
critical cases, visual associations and expected partial outcomes. Include scanned
and multicolumn layouts, distant answer keys, long materials, tables and answerless
questions according to the deployment's actual scope.

Create a private sidecar with this exact structure, using real SHA-256 values and
anonymous reviewer identifiers:

```json
{
  "version": 1,
  "origin": "consented_real_documents",
  "labelMethod": "independent_human_review",
  "annotatorId": "annotator-1",
  "reviewerId": "reviewer-2",
  "frozenAt": "2026-10-28T00:00:00+00:00",
  "manifestSha256": "<SHA-256 of the exact cases.json bytes>",
  "sourceSha256": {"<holdout case ID>": "<SHA-256 of its original file>"}
}
```

Run from `server/` with the existing Python environment:

```sh
python scripts/evaluate.py --manifest /private/holdout/cases.json \
  --split holdout --production-provenance /private/holdout/provenance.json \
  --validate-only
```

Validation is passive. The sidecar must cover every holdout source, bind the exact
labels and files, name different annotator/reviewer IDs, and be frozen before the
run. These checks verify integrity and an operator's declaration; they cannot
prove human independence or annotation correctness. No real documents or human
annotations are supplied by this change, so production-quality acceptance stays
blocked until the operator supplies them.

After planning provider charges, run three repetitions with the same arguments,
replace `--validate-only` with `--repetitions 3 --output /private/quality.json`.
The complete holdout is required; selecting easy cases is rejected. Missing or
invalid provenance blocks before provider configuration or calls. Reports keep
the provenance digest and source hashes, excluding reviewer identities.
The local graph evaluator uses in-memory checkpoints. When cost limits are enabled,
initialize a dedicated evaluation PostgreSQL database and select it with
`DATABASE_URI`: the document and grading evaluators take exclusive runtime ownership and retain their
cost reservations there. It refuses an incompatible database or one owned by a
running service before paid work; never point it at the production database.
Use the HTTP load driver below for deployed-process evidence.

## Operational evidence and preflight

1. Build/check the candidate and deploy it through the existing single-owner
   procedure. Retain its immutable image identity and exact checkout. Verify HTTPS
   externally, sandbox behavior, representative cgroup peaks and overload behavior.
2. Upload a representative annotated source through the explicit Web workflow.
   Save its `{"document": <verified DocumentReference>}` as a private load input.
   The following load command creates paid tasks: choose its count/concurrency
   deliberately and keep the existing budget/queue bounds.

```sh
python scripts/load_test.py --base-url https://imports.example.com \
  --environment production --image-digest sha256:<actual-image-identity> \
  --input /private/load-input.json --total 8 --submit-concurrency 2 \
  --max-running 2 --graph-concurrency 2 --output /private/capacity.json
```

Supply `AI_SERVICE_TOKEN` through the private environment, not the command line.
Production mode verifies the deployed service code hash before creating tasks.
An input source hash must belong to the independent quality dataset to pass the
combined preflight. The image identity is an operator-supplied deployment binding;
the HTTP endpoint does not attest which image is running.

3. Perform the existing fenced off-host restore drill into a new empty database
   and file directory. Add `--report /private/restore.json` to the existing
   `scripts.service_backup restore` command. Its private report binds the image,
   tool code, snapshot and data-restore duration. It preserves all original
   backup/destination checks. First start the restored candidate read-only and
   verify saved task/artifact/export reads. Full RTO includes this usable recovery;
   the data-restore timer alone is not full RTO.
4. From the deployment's protected Prometheus API, save a fresh instant-query JSON
   vector containing `up`, `probe_success`, backup success/timestamp, storage and
   broker health, sandbox/cost configuration including a positive daily cost limit, outbox age, unknown Tencent jobs and
   `ALERTS` for this deployment. Required jobs are `practiq-ai`, `practiq-ready`,
   `practiq-backups` and `practiq-containers`. Keep other deployments out of the
   vector. Test a real receiver notification separately and inspect dead letters;
   the offline preflight sends no notifications.
5. Combine evidence without contacting models or changing the deployment:

```sh
python scripts/production_acceptance.py \
  --quality /private/quality.json --capacity /private/capacity.json \
  --restore /private/restore.json --monitoring /private/monitoring.json \
  --max-rpo-seconds 900 --max-restore-seconds 900 \
  --max-completion-p95-seconds 1800 --output /private/preflight.json
```

The defaults are initial targets to review for the real workload. Reports must
match the current code/image, be no older than one day, and monitoring samples
must be no older than 60 seconds. Missing, synthetic, stale or mismatched evidence
cannot pass. Output files are private and never overwrite an existing report.
Exit codes are 0 (automated preflight passed), 1 (a target failed), 2 (blocked).
Every report retains outstanding manual checks for alert delivery, dead letters
and verified usable restoration. A preflight pass alone is not release acceptance,
general extraction accuracy, high availability or evidence of an off-host disaster.
