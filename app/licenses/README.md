# Supplemental upstream notices

Some published dependency archives omit their license text. `supplemental.json`
maps exact package versions to upstream text, its SHA-256 and source URL. Cargo
sources use each crate's `.cargo_vcs_info.json` commit; npm sources use registry
`gitHead` where available. Historic supplemental texts remain source evidence; unused
Python notices are not selected for desktop assets.

Do not replace these with a generic SPDX identifier or infer copyright holders.
Retain upstream text verbatim. Any `note` marks source applicability that needs
release review; the notice checker fails rather than silently accepting it.

`app/scripts/check_licenses.py` inventories the local target's Cargo packages,
and npm production dependency closure for the desktop practice application. It
checks supplemental hashes and returns nonzero for missing text or unverified
source applicability. Build packages include the combined text in
`bundled/THIRD-PARTY.txt`. Preparation fails on unresolved entries. An inventory is not a decision
about all redistribution obligations. Repeat it for each platform's final package.

The checker validates schema 2 desktop build metadata and limits Cargo entries to
the platform-filtered resolve graph. AI service dependencies and its configured
Office engine are independently deployed and require their own license review.
They are never claimed as redistributed desktop components.

## objc2-family terms

The ten affected versions retain their original, commit-pinned `LICENSE.md`
declarations, including the Apple SDK provenance discussion. Their supplements
also include the complete MIT text and copyright notice supplied by upstream in
[commit ee9a7ad](https://github.com/madsmtm/objc2/commit/ee9a7ada2131f5944b8750428e265c15632f2a19),
which fixes [the missing-text issue #826](https://github.com/madsmtm/objc2/issues/826).
MIT is selected for packages that offer it as an alternative. This adds the
upstream's missing text; it does not change any dependency's license declaration
or settle the SDK questions described in the original notice.

## react-remove-scroll-bar 2.3.8 attribution

The npm-published `gitHead` for 2.3.8 remains unavailable upstream. Attribution is
verified through the published artifacts instead; no unavailable source commit
is represented as retrieved:

- Both npm tarballs (2.3.7 and 2.3.8) were verified against their published SHA-512
  integrity values. All 26 files other than `package.json` are byte-for-byte equal.
- Both packages declare MIT and the same author. The only metadata differences
  are the version and `react-style-singleton` range (`^2.2.1` to `^2.2.2`).
- The 2.3.7 `gitHead`, `29e9fcd1eecf7d3b77a767941c4a57fe461fc1e4`, is public.
  [Comparison with the license merge](https://github.com/theKashey/react-remove-scroll-bar/compare/29e9fcd1eecf7d3b77a767941c4a57fe461fc1e4...8ca9ba5ea52de03308fe8ced94f7b159a44d28ff)
  shows only the addition of `LICENSE`. That immutable file supplies the complete
  MIT terms and Anton Korzunov's original copyright notice for the same payload.

[Provenance evidence](react-remove-scroll-bar-2.3.8.provenance.json) records the
artifact URLs, integrity values, file hashes and metadata differences. Its
SHA-256 is pinned in `supplemental.json`, checked during inventory and checked
again when embedding it in `THIRD-PARTY.txt`. The dependency remains at 2.3.8.

## Local shadcn CSS variants

The application uses its existing generated shadcn components without installing
the component-generator CLI. `app/src/index.css` retains the four used variants
from shadcn 4.21.0: `data-open`, `data-closed`, `data-checked` and `data-disabled`.
The source is [release commit 7c9eaba](https://github.com/shadcn-ui/ui/tree/7c9eaba1c0a6404c990c144a654792e3313c650d/packages/shadcn).
The same file includes the complete upstream MIT license and copyright notice
in a preserved CSS comment, so built application styles carry the terms.
