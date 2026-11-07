# PractiQ administration Web

`web/` builds the service's administrator interface. Customer accounts, document
upload, personal tasks, result review, usage and orders live in the macOS App's
**Cloud service** area. Document recognition, splitting, parsing, model calls,
accounting and saved results remain on the independent service. There is no
second backend or local document parser.

```sh
make web-install
make web-dev
make web-check
make web-build
```

Development binds to `127.0.0.1:5173` and proxies `/api` to port `8090`.
Production serves `web/dist` from `/`, `/admin` and `/login`. The previous
`/register`, `/reset-password` and `/payments` customer pages return 404. The
minimal `/payments/return` page only directs the buyer back to the App; it does
not confirm payment. Old cached assets must be invalidated when deploying.

Administrators sign in with an explicitly bootstrapped account. An ordinary
account receives a permission message without user or administrator controls.
The interface includes user activation, roles and quotas, registration policy,
shared execution settings, task inspection and explicit recovery, provider usage,
audit history and the administrator's own account security. Password recovery
shows a short-lived one-time reset code for entry in the App. Administrators must
verify the requester's identity independently before sharing it.

Browser requests remain same-origin, use HttpOnly session cookies and CSRF
protection, and never store authentication secrets in browser storage. Provider
configuration and payment credentials stay on the server. Administration reads
never start model work; recovery actions that can incur charges remain explicit.
Server authorization is authoritative for every customer and administrative API.

`shared/cloud/` contains the migrated customer workspace and reusable account,
rendering and task-inspection components. The production Web entry imports only
administration views; the customer portal, workspace and orders are not build
entries. Types are generated from the existing Python contracts.

Vitest still exercises the shared workspace alongside administrator interactions
and includes shared source files in coverage. Web Playwright checks the actual
administrator entry with synthetic API responses. The former customer browser
suite now runs under the App's `cloud-workspace` Playwright project through a
development-only harness; native IPC flows have separate App tests. These tests
do not prove real provider calls or macOS Keychain/dialog acceptance.

See [accounts and deployment](../server/docs/accounts.md),
[App cloud workflow](../docs/guides/cloud-service.md) and
[document tasks](../docs/guides/import-tasks.md).
