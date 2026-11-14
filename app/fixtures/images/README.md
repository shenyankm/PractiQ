# Image normalization references

These are original synthetic images, not user documents.

`cmyk.jpg` contains Pillow-generated random CMYK samples (Python `Random(8)`,
40 × 40). `cmyk-rgb.png` captures the historical Pillow JPEG decode followed by
`convert("RGB")`; tiled desktop output must reconstruct every reference RGB
sample exactly. `cmyk-invalid-icc.jpg` contains a deliberately invalid ICC profile
and must fail with a controlled error before submission.

`gray16.png` is deterministic random 16-bit grayscale data. Tiling must preserve
the full samples. RGB and RGBA tests generate their own deterministic random
images, reconstruct all original pixels, and check exact coverage and order.
