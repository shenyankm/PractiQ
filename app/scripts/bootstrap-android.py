"""Generate Tauri's Android project bindings without packaging a throwaway APK."""

import argparse
import json
import os
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGETS = ("aarch64-linux-android", "x86_64-linux-android")


def bootstrap(target: str) -> None:
    native = ROOT / "app/src-tauri"
    config = json.loads((native / "tauri.android.conf.json").read_text())
    identifier = config["identifier"]
    api = config["bundle"]["android"]["minSdkVersion"]
    library = tomllib.loads((native / "Cargo.toml").read_text())["lib"]["name"]
    project = native / "gen/android"
    source = project / "app/src/main/java" / identifier.replace(".", "/")
    if not source.is_dir():
        raise ValueError("The tracked Android host project must exist before bootstrapping")
    compilers = list(Path(os.environ["NDK_HOME"]).glob(f"toolchains/llvm/prebuilt/*/bin/{target}{api}-clang"))
    if len(compilers) != 1:
        raise ValueError(f"Expected one NDK compiler for {target} at API {api}")
    compiler = compilers[0]
    tools = compiler.parent
    if not (tools / "llvm-ar").is_file() or not compiler.with_name(compiler.name + "++").is_file():
        raise ValueError("The selected NDK must provide clang++ and llvm-ar")
    generated = source / "generated"
    generated.mkdir(exist_ok=True)
    target_key = target.replace("-", "_")
    env = {
        **os.environ,
        f"CARGO_TARGET_{target_key.upper()}_LINKER": str(compiler),
        f"CC_{target_key}": str(compiler),
        f"CXX_{target_key}": str(compiler.with_name(compiler.name + "++")),
        f"AR_{target_key}": str(tools / "llvm-ar"),
        "TAURI_ANDROID_PROJECT_PATH": str(project),
        "TAURI_ANDROID_PACKAGE_UNESCAPED": identifier,
        "WRY_ANDROID_PACKAGE": identifier,
        "WRY_ANDROID_LIBRARY": library,
        "WRY_ANDROID_KOTLIN_FILES_OUT_DIR": str(generated),
        "TAURI_CONFIG": json.dumps({"bundle": {"resources": []}}),
    }
    # Tauri's build scripts generate plugin Gradle bindings. Only the final CLI
    # build may inject the checked notices/resources and package an APK.
    subprocess.run(
        ["cargo", "build", "--locked", "--lib", "--target", target, "--features", "tauri/custom-protocol"],
        cwd=native, env=env, check=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TARGETS)
    bootstrap(parser.parse_args().target)
