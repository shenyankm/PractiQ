# App accounts and Web administration

The multi-user service uses PostgreSQL schema 8 and same-origin session cookies.
Optional [Alipay web payments](alipay.md) use separate account-owned receipt tables
and an explicit offline upgrade. Verified production catalog orders grant separate
expiring allowances; historical and sandbox orders do not. Native offline practice remains independent. See [plans and billing](../../docs/guides/plans.md).
The first release sends no email. Email is a case-insensitive, unverified login
identifier, not evidence of identity. Public registration is enabled after an
operator has bootstrapped an administrator and can be disabled at `/admin`.
Registration policy and administrator availability are rechecked in the account
creation transaction, including requests already hashing a password when policy changes.
Passwords require 12–128 characters and use Argon2id.

## Fresh deployment (default)

Preserve the existing deployment. Provision a new dedicated PostgreSQL database,
absolute persistent `AI_STORAGE_DIR`, and RabbitMQ vhost. Do not reuse personal
storage or infer owners from historical account/payment tables.

Install locked dependencies using the selected Python 3.14 interpreter, build
Web assets with `make web-build`, then run:

```sh
make init-db AI_PYTHON=/absolute/path/to/python3.14
cd server
/absolute/path/to/python3.14 -m practiq_ai.manage bootstrap-admin
```

The command prompts for email and password; never pass a password in arguments.
It requires offline runtime ownership. Additional administrators can be created
with the same explicit command, including recovery from operator lockout.
Start the service on loopback behind a trusted HTTPS reverse proxy. Forwarded
headers must only be trusted from that proxy. HTTPS requests receive Secure,
HttpOnly, SameSite=Lax cookies. Local HTTP development is loopback-only. Do not
expose PostgreSQL, RabbitMQ, workers or raw storage. Metrics require an administrator session or the operator-configured read-only
`AI_METRICS_TOKEN`. The token permits only GET/HEAD `/api/metrics`; it grants no
customer, grading or administration access. See [production preflight](production-readiness.md#monitoring-authentication).

## Accounts and recovery

Users can import sources, read their own task history and results, download ZIPs,
change personal import defaults, inspect usage, and manage account security.
Recognition concurrency/retry/backoff belong to administrators.
The administration execution panel edits those shared numeric controls; answer
generation and deduplication switches belong to each user's import preferences.
Browser sessions expire after seven days or 24 idle hours. Logout, session revocation and account
changes never start a model. No authentication token is stored in browser storage.
Recovery hints and correction drafts are partitioned by user and, in the App, service origin. Old unowned browser
records are preserved and are not automatically adopted.
Opening a saved bank keeps the existing workspace and selected source files;
unsaved or uncertain corrections still require the existing leave/recovery action.
Token and session revocation use separate targets. Administration edits the selected
user's read-only identifier, and reset codes remain bound to their selected target account.

Changing a password or login email requires the current password and revokes all
sessions and grading tokens. Without email verification, an administrator must
check a recovery request through an independent trusted channel before generating
a reset code. The `/admin` user page displays the code once; it expires after
30 minutes. Enter it in App → Account → Reset password. Submitting the new
password consumes it once and revokes all login credentials. The API retains its
existing reset-link response shape for compatibility, but `/reset-password` is no
longer a public Web page. Do not paste codes into logs, public issues, analytics
or shared screenshots.

Administrators can activate/deactivate users, change roles and quotas, inspect
cross-user task results, explicitly pause/resume/retry tasks, inspect provider
usage and audit history, and change registration/default execution policy.
Administrative access is explicit and audited. The last enabled administrator
cannot be disabled or demoted. Disabling an account revokes credentials and blocks
new paid admissions; already admitted requests may still finish and save receipts.
Re-enabling an account does not resume its tasks automatically.

## Quotas and receipts

New accounts receive **50 free recognition pages in total**, not 50 pages per
day or 50 documents. Registration snapshots the default page allowance; changing
the new-account default does not refill existing accounts. Administrators may
change an account's total allowance (including pages already used). Free allowances remain in the existing JSON policy and call receipts. Schema 8 adds
independent paid grants and per-call allocations, without reclassifying historical calls.
Paid grants are spent by earliest expiry before lifetime free pages; unknown reservations
remain allocated even after expiry. Known lower terminal counts release only their
original allocation, never move charges into another grant or user.

Page quota is reserved atomically before submission, across all of a user's
tasks. PDFs reserve their verified page count; each submitted image/tile counts
as one recognition page. Sources with unknown pagination (Office, TXT/Markdown)
reserve up to the remaining allowance and pass that bound as Tencent's
[`FileEndPageNumber`](https://cloud.tencent.cn/document/api/866/139312). Successful terminal metadata settles the reservation to
reported successful plus failed pages; absent/unknown counts retain the bound.
Reaching the bound marks the result as potentially incomplete for review.
Known-page inputs exceeding the remaining quota are paused before submission.
Page selection is a result filter and does not reduce pages sent for recognition.
Saved receipt replay, result reads and ZIP export consume no additional pages;
an explicit new recognition attempt does. Unknown outcomes retain their reserved
pages, and task deletion does not reset usage. Calls recorded before page-quota
support are preserved without inventing historical page counts.

Additional safety defaults are 1000 model calls/day, 50 Tencent submissions/day and Free/Plus/Pro active-task limits of 1/2/3 respectively. Explicit
per-user administrator limits take precedence. Only daily call limits reset at midnight in
Asia/Singapore. Administrators can override defaults per account. Existing global,
per-task, provider and optional estimated-cost budgets remain additional limits.
Tencent queries/downloads and local reads are passive. Actual model attempts and
split Tencent submissions each count. Unknown outcomes retain their quota and
receipts; a known receipt replay does not count again. Exhaustion pauses subsequent
paid work; explicit resume after reset or quota adjustment is required. Lower
concurrency limits drain accepted work rather than interrupting it.

Call counts do not cap actual currency spending. Keep provider-side spending caps
and, when useful, configure the existing estimated-cost budgets. Calls and audit
evidence survive task deletion. Saved results retain the existing 180-day expiry;
download required ZIPs before expiry.

Explicit standalone evaluation scripts use an operator-only admission context,
with their existing evaluation receipts and optional cost-budget database. They
do not infer or charge an application user. That context refuses a running service
or authenticated HTTP actor and cannot disable HTTP ownership enforcement.

## macOS App connection

Local practice, ZIP imports and direct model grading still require no account.
Customer login, registration, source upload, task/result review, banks, usage and
orders now live in App → Account; the Web root and `/admin` are administrator-only.
The App performs no local recognition/parsing. See the [cloud workflow](../../docs/guides/cloud-service.md)
for native origin configuration, Keychain/session handling and recovery boundaries.
For optional service grading, create a personal grading token in App → Account →
Account and security. Copy the service origin and token into the App's existing
AI service connection fields. A token is displayed once, lasts 90 days, and only
allows the passive connection check and explicit subjective grading. It cannot
read document tasks or administer the service. The native typed settings commands
store it in macOS Keychain, outside SQLite and backups. Existing credentials are
not interpreted, copied or deleted. Revoked/expired credentials require an explicit
new token and replacement; no automatic grading retry occurs.

## Existing data and rollback

Prefer a fresh deployment and transfer question banks through existing ZIP export.
For an approved offline upgrade, stop writers, create a matching database/storage/
private-config/image backup using the existing [backup tooling](service-backups.md),
verify it, then run:

```sh
make upgrade-db AI_PYTHON=/absolute/path/to/python3.14 UPGRADE_BACKUP=/absolute/path/to/verified/bundle
```

The bundle is verified before schema changes. Schema 5 upgrades atomically through
the existing account migration to 8; schema 6 receives payment and grant tables; schema 7
receives only the order-product/verified-closure columns and grant/allocation tables. The old default
active-task limit of 2 becomes the Free default of 1; explicit per-user overrides and
other custom defaults are preserved. No historical order is granted a product.
Existing older-version safety gates remain. Historical rows retain null ownership;
ordinary users cannot see them and offline cleanup leaves them intact. There is
no automatic ownership assignment or mapping tool. Historical tasks cannot resume
paid work until an operator-approved mapping is separately implemented. Migration,
backup, login and inspection never run models.

Restore only into a new database and storage root with the matching executable.
The restore tool revokes all sessions and reset/grading tokens before reopening
schema-8 data, preventing old credentials from being resurrected. Users must log
in and explicitly create new App tokens. Rollback uses the complete matching old
backup and old executable; no in-place downgrade is supported.

## Administrator support console

The [administration guide](../../docs/guides/administration.md) describes user
balance/grant inspection, account/time/state searches, uncertain-operation
worklists, explicit reasoned allowance adjustment, usage/audit reporting, targeted
session revocation and read-only runtime status. These use the existing schema-8
ledgers and preserve historical ownership. Optional external monitoring evidence
uses the trusted absolute `AI_OPERATIONS_STATUS_FILE`; no missing observation is
reported as a successful backup or delivered alert. No deployment or migration is
performed by opening the console. Keep the matching executable for unfinished
checkpoints when upgrading.
