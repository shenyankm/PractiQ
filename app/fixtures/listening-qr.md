# Listening QR fixtures

`listening-qr.png` is the existing public-address regression image. It decodes to
`https://example.com/listening.wav`.

`listening-qr-second.png` and `listening-qr-private.png` were generated locally
with macOS Core Image `CIQRCodeGenerator`, correction level M and an 8× scale.
Their payloads are `https://example.com/second.wav` and
`http://127.0.0.1/private.wav`, respectively. No external image or recording was
downloaded. Tests combine the public fixtures to check multiple-code handling,
and reject the private destination without network access.

`all-types-no-recordings.zip` is derived from the existing `all-types.zip`.
It removes audio references and their recording entries, marks listening media
as missing/reviewable, and asks users to supply a playback address. Other question
content and image bytes are retained. The desktop bundles this variant for new
example banks; the original archive remains a historical compatibility fixture.
