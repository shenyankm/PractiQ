fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS is required");
    assert!(
        matches!(target_os.as_str(), "macos" | "windows" | "android"),
        "PractiQ supports only macOS, Windows and Android app targets"
    );
    if target_os == "android" {
        // Rust's linker needs both sizes to align LOAD and RELRO segments.
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
    }
    tauri_build::build()
}
