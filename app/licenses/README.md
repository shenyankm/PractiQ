# Supplemental upstream notices

Some published dependency archives omit their license text. `supplemental.json`
maps exact package versions to upstream text, its SHA-256 and source URL. Cargo
sources use each crate's `.cargo_vcs_info.json` commit; npm sources use registry
`gitHead` where available. Historic supplemental texts remain source evidence; unused
Python notices are not selected for desktop assets.

Do not replace these with a generic SPDX identifier or infer copyright holders.
Retain upstream text verbatim. Any `note` marks source applicability that needs
release review; the notice checker fails rather than silently accepting it.

The Electron packager and `app/scripts/release.ts` use
`app/scripts/release-licenses.ts`. It inventories the installed target's entire
npm production closure, including bundled renderer dependencies and embedded AI
workers. Only absent optional dependencies for another OS/CPU are excluded.
Missing texts, altered text/provenance hashes and unresolved source-applicability
notes block packaging and final staging. A license declaration alone is not a
license text. The installed package includes complete combined terms in
`Contents/Resources/THIRD-PARTY.txt`, a source-bound inventory and content-addressed
texts in `Contents/Resources/DEPENDENCY-LICENSES/`. Final staging regenerates and
compares both with the selected source. An inventory does not decide all
redistribution obligations; independent release review remains required.

The former Python/Cargo checker remains a migration reference until those tools
are retired. Its historical inventories do not establish Electron acceptance.

## Embedded AI dependency terms

Missing texts for `@cfworker/json-schema` 4.1.6, `js-tiktoken` 1.0.21 and `saxes`
6.0.0 are retained from their exact registry `gitHead` revisions. `lzma-purejs`
0.9.3 and its `commander` 2.0.0 retain the complete license sections in their
published README bytes. Their provenance records bind the package version,
reviewed npm integrity, upstream source and text hashes. Original declarations
are preserved, including differences between a package label and its actual
upstream terms.

The arm64 libvips distribution retains its exact published third-party notice
and component-version list, together with complete GNU LGPLv3 and GPLv3 terms
from a pinned GCC upstream revision. The distribution's README selects LGPLv3
through the earlier versions' any-later-version clause. This does not complete
the native subcomponents' source/redistribution-obligations review or publisher
acceptance; those remain part of final release review. No generic SPDX string
substitutes for these retained terms and sources.

The jsonschema-regex and jsonschema-value 0.58.6 archives omit license files.
Their published VCS identities and workspace declarations bind the supplemental
MIT text to upstream commit `55ac1664384793c5d3b20745d3f9c169dfe2c06f`.
Those complete terms also match the jsonschema 0.58.6 archive from that commit.

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

## selectors 0.41.0 attribution

The published crate checksum matches Cargo.lock. Its original manifest and source
header match upstream commit `34d25f741765a0bdb894f8271852e633299352d8` byte for byte
and declare MPL-2.0. The version-specific provenance record binds that evidence
to the complete canonical Mozilla MPL 2.0 text already retained in `texts/`; no
generic license label replaces the upstream terms.
