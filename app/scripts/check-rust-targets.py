"""Reject the Linux-only vulnerable GLib dependency in supported app graphs."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGETS = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-linux-android",
    "x86_64-linux-android",
)


def main() -> None:
    for target in TARGETS:
        result = subprocess.run(
            ["cargo", "tree", "--locked", "--manifest-path", str(ROOT / "app/src-tauri/Cargo.toml"),
             "--target", target, "--prefix", "none", "--format", "{p}"],
            cwd=ROOT, capture_output=True, text=True, check=True, timeout=300,
        )
        packages = [line.split()[0] for line in result.stdout.splitlines() if line.strip()]
        if not packages or "practiq-desktop" not in packages:
            raise ValueError(f"Missing app dependency graph for {target}")
        if "glib" in packages:
            raise ValueError(f"Unsupported vulnerable GLib dependency is reachable on {target}")
        print(f"{target}: app dependency graph contains no glib")


if __name__ == "__main__":
    main()
