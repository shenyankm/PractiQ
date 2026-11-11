# Document import in the App

Open **Document import** in the macOS App to use the embedded import workspace. The independent Python backend defaults to `http://127.0.0.1:8090`. Start it with `make server-dev` after following the [installation guide](installation.md#install-the-ai-import-service-optional). The backend does not serve a Web frontend.

1. Select up to ten source documents with the native file picker. Selection does not upload or call a model.
2. Review page selection and import preferences, then click **Start import**. Recognition and question structuring run in the separate Python backend.
3. Follow task progress, review partial or completed results, compare source evidence, and save corrections. Unknown outcomes keep their request IDs; retry only explicitly after checking the original record.
4. Select **Import bank** to add the saved result and checked images directly to local practice. The App does not create or download an intermediate ZIP.

To use another backend, open global **Settings → AI service** and save its origin: HTTPS, or HTTP on localhost/loopback for development. Editing or canceling the address keeps the workspace mounted. Saving checks pending submission and correction guards before changing the service.

An absent configuration uses the local default without writing a file. Explicit changes are saved in `v4/import-service-v1.json`; unknown configurations, old account settings and Keychain entries remain untouched. Changing the origin invalidates old requests and source tickets; drafts and unresolved submissions stay scoped to their original service. Local practice and ZIP import work without a service. Subjective AI grading uses this same backend origin. Recognition and recovery preferences are also in global Settings; the import workspace contains only Start import and Import history.

Keep the backend on loopback or behind private access control; anyone who can reach its API can operate your personal tasks. See [backend deployment and safe upgrades](../../server/docs/personal-use.md) and [task review and recovery](import-tasks.md).
