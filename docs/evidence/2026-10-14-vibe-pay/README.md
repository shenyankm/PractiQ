# Vibe Pay checkout browser evidence

Screenshot files were removed on October 17, 2026 during repository cleanup. The results below describe the original acceptance. Logs, measurements and original hash manifests are retained as historical records; screenshot entries in those manifests no longer identify available files. Current product screenshots remain in the root README files.

Captured on macOS with Chromium and mocked same-origin payment responses. The screenshots use the production Web theme and simulated phone/order data; they contain no credentials, cards or receipt files.

- Desktop checkout, 1280 × 720: frozen price/points, explicit Alipay link and account-owned order history.
- Mobile credited order, 390 × 844: reconnection after reload, confirmed direct credit and guidance to continue parsing explicitly.

The 24 Web browser scenarios passed, including both checkout sizes, all supported question layouts, tables, formulas and images. The checkout scenarios assert no horizontal overflow, account-authenticated private headers, no credentials in URLs/localStorage/sessionStorage, reload recovery through owned-order GETs, and only explicit order creation/payment-link POSTs. The billing scenario verifies that an external recharge and balance refresh start no models until Continue is clicked. The Web component suite passed 80 tests with 97.67% line coverage.

Visual inspection confirmed readable wrapping, normal vertical scrolling and visible controls at the two supported desktop/mobile dimensions. This verifies the local UI and simulated flow, not real Alipay payment or merchant activation. See the [deployment guide](../../../server/docs/payments.md) for account-token migration and merchant prerequisites.

Final local checks passed `make verify` (2,179 tests, 93% coverage, 33 evaluation fixtures, recovery gate and package integrity), `make app-check` (49 shared cases, 390 frontend and 185 Rust tests; one existing skip and 12 ignored), Python/npm audits and `make image-check`. The 60 payment cases cover direct credit, tenant isolation, duplicate callbacks, crash/overflow recovery, explicit legacy migrations, durable refund holds and full-refund closure, seller identity alternatives, final-minute deadline precision, both maintenance locks, isolated environment files, optional production dependencies and complete notice hashes. Payment-core coverage is 98%. Real Alipay transactions and merchant activation were not tested.
