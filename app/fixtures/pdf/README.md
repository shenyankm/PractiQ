# PDF normalization fixtures

`unembedded-cjk.pdf` is an original synthetic PDF containing the four characters
“中文测试”, using the unembedded `STSong-Light` / `UniGB-UCS2-H` CID font.
It contains no third-party document content. PDFium's default Wasm filesystem
renders it blank; the desktop's bounded, read-only macOS font bridge must retain
visible glyphs for all four characters.

The test suite generates other small PDFs directly, checking fractional page
sizes, rotations, multiple pages, invalid sources and resource limits. Native
Python/PDFium and Wasm/PDFium both retain the Chinese text, but their fallback
typefaces and rasterization differ. Pixel equality across the two engines is
not an acceptance claim; original PDF bytes remain authoritative and immutable.
