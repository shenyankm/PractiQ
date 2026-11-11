# Personal import service in the App

Open **Document import** in the macOS App. Enter your self-hosted service origin: HTTPS, or HTTP on localhost/loopback for development. The independent service includes a personal Web workspace without registration, users, plans or payment setup. Keep it private; anyone who can reach its API can operate your personal tasks.

1. Select up to ten source documents with the native file picker. Selection does not upload or call a model.
2. Review page selection and import preferences, then click **Start import**. Recognition and question structuring run in the separate AI backend.
3. Follow task progress, review partial or completed results, compare source evidence, and save corrections. Unknown outcomes keep their request IDs; retry only explicitly after checking the original record.
4. Download the question-bank ZIP with the native save dialog. Import it under **Settings → Import and restore** to append it to offline practice.

The import origin is saved separately in `v4/import-service-v1.json`. Old account settings and Keychain entries remain untouched. Changing the origin invalidates old requests and source tickets; drafts and unresolved submissions stay scoped to their original service. Local practice and ZIP import work without a service. Configure optional subjective grading separately under **Settings → AI service**.

See [backend deployment and safe upgrades](../../server/docs/personal-use.md) and [task review and recovery](import-tasks.md).

The standalone Web can perform the same import/review/export workflow without the App. Build it with `make web-install web-build`, run the service, and open its root URL; `make web-dev` is the separate loopback development frontend.
