# GLib 0.18 safety backport

This is the published `glib 0.18.5` crate (MIT; see `LICENSE` and `COPYRIGHT`).
Original crates.io archive SHA-256:
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.

Tauri's Linux GTK3 dependencies require GLib 0.18. Upstream will not release
another 0.18 version, and GLib 0.20 is not a compatible replacement.
The application uses this crate through `[patch.crates-io]`.

The two-line fix from [gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343)
changes `VariantStrIter::impl_get` to pass a mutable output pointer to GLib.
It fixes [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
for forward and reverse string iteration without changing the public API.
We also add an empty/Unicode/reverse iteration regression test and a lockfile
for standalone upstream unit tests. Cargo cache metadata is omitted.

Run on Linux with GLib development libraries and pkg-config installed:

```sh
cargo test --locked --release --manifest-path app/src-tauri/vendor/glib/Cargo.toml --target-dir app/src-tauri/target/glib-backport --lib variant_iter::tests
make audit-rust
```

Release optimizations are required: debug builds can hide the original undefined
behavior. Desktop Linux CI runs these tests. Do not suppress the advisory or
change the package version to pretend this is an upstream fixed release.
Dependabot's handling of the local backport must be checked after publication.

Remove this patch and vendored crate when Tauri's Linux dependency chain supports
a maintained GLib version containing the fix, then regenerate the application
lockfile and remove the standalone CI test step.
