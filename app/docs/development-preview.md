# Development preview

`make app-dev` starts with in-memory demo data. You can also run `npm run dev` in a browser without the native service. Expand the “开发预览” panel at the lower right to switch scenarios or reset changes. Switching reloads the app and returns to the home page. “真实本地数据” uses native commands and requires the desktop app.

| Page or flow | Demo coverage |
| --- | --- |
| Question banks | Populated and empty banks, creation, editing, merging, deletion and pagination |
| Question list, detail and editor | All 11 answer modes; single/multiple choice, matching variants, English question kinds, composite materials, formulas, tables, images, audio, review warnings and missing reference answers |
| Wrong answers and favorites | Existing records, removing favorites, search/type/bank filters and empty results |
| Practice setup and answers | Ordered, random, manual and quota selection; practice, self-tests and timed exams; drafts, skips, flags, submission and historical snapshots |
| Practice history and grading | Active, finished and review states; objective results, ungraded answers, partial credit, simulated AI scores, manual overrides, failures, unknown results and missing grading evidence |
| Document import | Simulated multi-file selection; ten task states, imported and failed bank writes; filtering, controls, partial-result review, preview and batch retries |
| Settings and model configuration | Configured/unconfigured states, simulated saving and connection tests; backup, restore, ZIP import confirmation and feedback |
| Theme and language | Existing theme/language menus; source-language document content stays unchanged |

Global scenarios include normal, empty, many pages, a 1.5-second request delay, failed requests, unconfigured models and missing resources. Empty data still allows bank creation; unconfigured models accept demo configuration.

Question pagination and statistics use `bank_ids`: an empty array selects all banks, `[id]` selects one bank, and multiple IDs select several banks. Type filters match root question kinds, single/multiple choice variants and the `grammar_fill` alias used by native commands. Composite results include all descendants and count only answerable nodes. Review filtering includes a root when it or any descendant has an imported `needsReview` flag without a separate `reviewedAt` confirmation. Confirming or undoing review updates the entire descendant tree and preserves imported quality flags, missing-field markers and warnings.

In development mode, `transport.ts` sends business calls to `preview-data.ts`. Unknown commands fail without native fallback. Import tasks use the same transport and scenario controls. Only fixed repository image/audio fixtures are read through Vite. Changes stay in memory; keys are not persisted, no models are called, and file selection/conversion/export/restore are simulated.

The preview validates UI behavior and interaction. It does not validate native storage, extraction quality, file authorization or model services. Scoring and question selection remain simplified demonstrations; native tests verify their full rules.

Run `npx vitest run`, `npm run test:browser` or `npm run test:preview` from `app/`. `npm run build` checks the production build, which excludes preview code and demo resources.
