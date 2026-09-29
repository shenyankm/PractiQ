# Supplemental upstream notices

Some published dependency archives omit their license text. `supplemental.json`
maps exact package versions to upstream text, its SHA-256 and source URL. Cargo
sources use each crate's `.cargo_vcs_info.json` commit; npm sources use registry
`gitHead` where available. Python sources use the matching upstream release.
Selectors declares MPL-2.0; its full license text comes from Mozilla.

Do not replace these with a generic SPDX identifier or infer copyright holders.
Retain upstream text verbatim. Any `note` marks source applicability that needs
release review; the notice checker fails rather than silently accepting it.
The published react-remove-scroll-bar commit is unavailable upstream. Its current
upstream notice is preserved at an immutable commit, with that limitation explicit.

`app/scripts/check_licenses.py` inventories the local target's Cargo packages,
npm production dependency closure and final Python/LibreOffice resources. It
checks supplemental hashes and returns nonzero for missing text or unverified
source applicability. Build packages include the combined text in
`bundled/THIRD-PARTY.txt`. Development builds retain unresolved entries visibly;
release verification requires resolving them. An inventory is not a decision
about all redistribution obligations. Repeat it for each platform's final package.

The objc2-family supplemental `LICENSE.md` files currently contain links rather
than the applicable full terms. These ten mappings are explicitly unresolved,
alongside the unavailable npm source above. They cannot satisfy release
acceptance until the applicable terms and their provenance are supplied.
The checker also requires bundled Python metadata to match `build-manifest.json`
and limits Cargo entries to the platform-filtered resolve graph.
