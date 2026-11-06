# User portal and administration

The multi-user service uses PostgreSQL schema 6 and same-origin session cookies.
The first release sends no email. Email is a case-insensitive, unverified login
identifier, not evidence of identity. Public registration is enabled after an
operator has bootstrapped an administrator and can be disabled at `/admin`.
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
expose PostgreSQL, RabbitMQ, workers or raw storage. Metrics now require an
administrator session; configure private monitoring authentication accordingly.

## Accounts and recovery

Users can import sources, read their own task history and results, download ZIPs,
change personal import defaults, inspect usage, and manage account security.
Recognition concurrency/retry/backoff belong to administrators. Browser sessions
expire after seven days or 24 idle hours. Logout, session revocation and account
changes never start a model. No authentication token is stored in browser storage.
Recovery hints and correction drafts are partitioned by user. Old unowned browser
records are preserved and are not automatically adopted.

Changing a password or login email requires the current password and revokes all
sessions and grading tokens. Without email verification, an administrator must
check a recovery request through an independent trusted channel before generating
a reset link. The `/admin` user page displays that link once; it expires after
30 minutes. Visiting a link does not consume it. Submitting a new password consumes
it once and revokes all login credentials. Tokens use URL fragments, which are
removed from browser history when the reset page opens. Do not paste links into
logs, public issues, analytics, or shared screenshots.

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
change an account's total allowance (including pages already used). No checkout
or automatic refill is provided. The allowance is stored in the existing JSON
policy and call receipts; no new database table or schema migration is required.

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

Additional safety defaults are 1000 model calls/day, 50 Tencent submissions/day and two active
(pending/running/pausing) tasks per user. Only daily call limits reset at midnight in
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

## macOS App connection

Local practice, ZIP imports and direct model grading still require no account.
For optional service grading, create a personal grading token in User portal →
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

The bundle is verified before schema changes. Schema 5 upgrades atomically to 6.
Existing older-version safety gates remain. Historical rows retain null ownership;
ordinary users cannot see them and offline cleanup leaves them intact. There is
no automatic ownership assignment or mapping tool. Historical tasks cannot resume
paid work until an operator-approved mapping is separately implemented. Migration,
backup, login and inspection never run models.

Restore only into a new database and storage root with the matching executable.
The restore tool revokes all sessions and reset/grading tokens before reopening
schema-6 data, preventing old credentials from being resurrected. Users must log
in and explicitly create new App tokens. Rollback uses the complete matching old
backup and old executable; no in-place downgrade is supported.
