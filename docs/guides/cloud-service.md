# Cloud services in the macOS App

Offline practice, local question-bank ZIP import and direct model grading need
no account. Open **Cloud service** only when using a separately deployed PractiQ
service. Enter its root HTTPS origin (for example `https://service.example.com`)
and select **Connect to cloud service**. HTTP is allowed only for loopback
development. No document is uploaded by connecting or signing in.

## Accounts

Register with an email and a 12–128 character password when public registration
is enabled, or sign in to an existing account. Email is currently an unverified
login identifier; no email is sent. For forgotten passwords, an administrator
must verify identity independently and issue a one-time reset code. Enter that
code through **Reset password** in the App. It expires after 30 minutes and is
consumed only on explicit password submission, revoking existing credentials.

**Account and security** edits profile/email/password and manages revocable
sessions and grading tokens. Password/email changes require the current password
and revoke existing sessions and tokens. Disabled accounts lose server access
immediately. New accounts receive a total of **50 free recognition pages**, with
no daily refill. **Usage** shows the remaining allowance and saved call receipts.

A separate origin-bound native session is kept in macOS Keychain under
`ai-account-session-v1-<origin hash>`. Its cookie and CSRF value never enter the
WebView, local storage, URLs or backups. Password fields are cleared after use.
The non-secret version-1 origin file is `v4/account-service-v1.json`; it is
separate from practice SQLite and grading settings, and is excluded from practice
backups. Unknown configuration files are preserved and disable cloud access only.
Switching services or accounts invalidates selected-file tickets and fences stale
responses. Each origin retains its own Keychain entry; reconnecting to that
origin can restore its still-valid session.

**Log out** requests server revocation and clears the local session even if the
network outcome is unknown. **Forget local login** only removes this device's
credential, useful for an unreadable Keychain entry; it does not revoke a server
session. Use account session revocation from another authorized login when remote
revocation is needed. Existing grading/model credential namespaces are unchanged.

## Upload and cloud processing

1. In **Import workspace**, choose up to ten supported documents through the
   native file picker. Selection reads bounded bytes to calculate a hash; it
   makes no upload, recognition request or model call.
2. Review the page selection, purpose and saved import preferences. Select
   **Start import** to authorize native checksum verification/upload and cloud
   task creation. Recognition, normalization, splitting, parsing and optional
   answer generation all run on the service. The App contains no source parser,
   Python/LibreOffice runtime or import-provider key.
3. Open **Import history** for progress, saved results, source evidence,
   corrections and the server-authorized explicit recovery actions. Reads,
   polling, file selection and result export never run a model.
4. Download a question-bank ZIP through the native save dialog, then use
   **Settings → Import and restore → Import bank ZIP** to append it locally.
   Saving verifies a bounded ZIP before publishing it. Cancellation does not
   claim a successful download. Validation failures do not replace the destination;
   only a complete file is published. A publication/fsync failure remains
   unconfirmed, so inspect the destination before repeating the save.

Accepted cloud tasks continue after the App closes. Reopening only reads their
state. Unknown task creations, reparses and correction saves retain the original
request IDs and payloads in account-and-origin-scoped WebView recovery records.
No automatic mutation replay occurs. Uploaded bytes and authoritative receipts
remain on the server; unsent source files must be selected again after restart.
In the native workspace, save or explicitly discard the current correction
before switching tasks, services or leaving the cloud page. Deleting a recovered
draft waits for a native confirmation and retains it on Cancel. Tauri confirmation
is asynchronous and is never interpreted as a synchronous consent value.
Correction drafts may contain private source text. They stay on this device,
can be exported explicitly, and are not practice backups. Old browser-origin
hints/drafts are not silently adopted by a native account.

## Plans, orders and service grading

**Plans and allowance** shows the current plan, expiry, free/paid page ledger and fixed catalog. See [pricing and quota rules](plans.md). Purchases are manual; no recurring billing or annual plan.

**Orders and payments** displays existing receipts even when payment is disabled.
The optional existing Alipay web checkout opens a restricted form in the system
browser; it adds no native payment SDK and issues independent page grants only for verified production catalog orders. Sandbox and historical non-product orders do not increase allowances.
Return to the App and query the original order. Uncertain creates retain their
account-and-environment-scoped request ID across remounts/restarts, and only a matching paid or
closed receipt releases it. Sandbox and production recovery IDs remain separate; unresolved old receipts are
retained when the offer changes. A legacy request without a saved receipt is
preserved and blocks a new checkout until its environment can be reconciled.
No real payment configuration is required for offline
practice. See [Alipay setup](../../server/docs/alipay.md).

Optional service grading retains its separate connection flow. Create a personal
90-day grading token under **Cloud service → Account and security**, then copy it
and the service origin into **Settings → AI service**. This restricted credential
only permits connection checks and explicit grading. It is stored in the existing
Keychain namespace, outside SQLite and backups. Account login does not silently
replace grading settings or retry an uncertain grade.

The service now uses schema 8, requiring a backed-up explicit offline upgrade from schema 7. Practice data remains schema 11. Existing accounts, uploads, tasks, payments, ZIPs,
practice data and old credential namespaces are preserved. The Web deployment is
now administration-only; update it with the matching App and backend revision.
Before replacing the old customer Web build, save unfinished corrections on the
server or export local draft backups and retain uncertain request IDs. Browser
recovery records remain in that browser and are not automatically copied into
the App. Keep the previous frontend build privately for recovery if needed.
