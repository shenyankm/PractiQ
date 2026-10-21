# PR #334 review follow-up

This supplements the [original 470-image gallery](../2026-10-21-uiux-fixes/README.md).
The original capture provenance remains historical; these screenshots cover the
practice error-recovery fix added after review.

## Findings addressed

- Practice notices now take space from a flex workspace rather than pushing a
  full-height session below the clipped viewport. Expanded diagnostics scroll in
  a bounded notice; the footer and remaining question scroller stay reachable.
- Ordering item IDs fall back to their zero-based positions. Matching IDs use
  zero-based positions independently within each side, matching
  `answer_references_missing` in the server contract. Explicit IDs still win.
- Empty fill-blank, ordering and matching answer arrays show an explicit empty
  reference message. Original records and nulls remain unchanged.
- Image-size actions retain their changing action labels without `aria-pressed`,
  so the accessible name does not contradict the current image-size state.

The initial App and service CI failures were caused by Vite's bundled
launch-editor advisories. Both frontends now use Vite 8.3.4, with regenerated
lockfiles. See the [Vite release](https://github.com/vitejs/vite/releases/tag/v8.3.4)
and [advisory](https://github.com/advisories/GHSA-r825-w8mm-5pxw).

## Local validation before push

- App `npm run check:ui`: 460 passed, 3 existing skips.
- Web `npm run check`: 154 passed, including positional/explicit/mixed item IDs,
  independent matching-side positions, empty arrays and source immutability.
  Six added regression cases failed before the implementation fix.
- App Playwright `--project=preview --grep 'practice error recovery'`: 3 passed
  at 360x640, 667x375 and 1280x720. All three failed before the layout fix.
  Each verifies collapsed/expanded diagnostics, positive content-scroller height,
  footer bounds, keyboard reachability and a successful explicit navigation retry.
- Both frontend `npm run build` commands passed.
- Both frontend `npm audit --audit-level=high --json` commands passed with zero
  vulnerabilities. No audit threshold or ignore list changed.

Remote CI and review results are recorded on [PR #334](https://github.com/shenyankm/PractiQ/pull/334).
These are Chromium previews with synthetic native responses, not physical-device,
system-picker/keyboard or live-service acceptance. Screenshot hashes and byte sizes
are in [capture-integrity.json](capture-integrity.json).

![Compact practice error](practice-error-360x640.png)
![Landscape practice error](practice-error-667x375.png)
![Desktop practice error](practice-error-1280x720.png)
