fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS is required");
    assert_eq!(
        target_os, "macos",
        "PractiQ supports only macOS app targets"
    );
    tauri_build::build()
}
