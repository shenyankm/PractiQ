# Unicode case-fold data

`../source-casefold.json` freezes the reference Python runtime's Unicode 16.0.0
default full case fold. Its 1,557 mappings were compared exactly with the C/F
entries of [Unicode CaseFolding-16.0.0.txt](https://www.unicode.org/Public/16.0.0/ucd/CaseFolding.txt).
Unlisted code points map to themselves; Turkic T mappings are excluded.

`../source-digits.json` freezes the same runtime's 128 `str.isdigit` characters
outside the decimal-digit category (including supplementary characters). Decimal
digits use the Unicode `Nd` property; the extra table preserves source-number
boundary behavior and is not a general numeric converter.

The [Unicode data license](https://www.unicode.org/license.txt) is retained in
`unicode-data.txt` and copied to the built desktop resources.

## PDFium normalization

The desktop uses the pinned `@hyzyla/pdfium` 3.0.0 package. Its
[vendor release receipt](https://github.com/hyzyla/pdfium/blob/v3.0.0/src/vendor/LAST_RELEASE.txt)
identifies [pdfium-lib 8046d](https://github.com/paulocoutinhox/pdfium-lib/releases/tag/8046d),
which builds PDFium's `chromium/8046` branch. The package Wasm is copied to
resources with a SHA-256 manifest; runtime enforces a 512 MiB Wasm memory maximum.

`pdfium.txt` preserves the upstream PDFium BSD license for that branch.
`pdfium-build.txt` preserves pdfium-lib's license at tag 8046d.
`hyzyla-pdfium-upstream.txt` preserves the wrapper's upstream license at v3.0.0;
`hyzyla-pdfium-package.txt` also preserves the license shipped in the npm package,
whose attribution differs. All are copied with this directory to built resources.

System fonts remain on the user's macOS installation and are read through a
bounded read-only bridge; no Apple fonts are copied into desktop resources.
The complete bundled PDFium third-party notice inventory and final packaged
dependency audit remain release acceptance gates in the migration ledger.
