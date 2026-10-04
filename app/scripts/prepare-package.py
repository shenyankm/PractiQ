"""Prepare only desktop build metadata and Cargo/npm notices; never copy engines."""

import json
import platform
import sys
from pathlib import Path

from check_licenses import inventory, write_notices
from desktop_package import PACKAGE_MODE, SCHEMA_VERSION, validate_manifest

ROOT = Path(__file__).parents[2]


def main() -> None:
    output = ROOT / "app/src-tauri/bundled"
    output.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / "app/package.json").read_text(encoding="utf-8"))["version"]
    manifest = {"schemaVersion": SCHEMA_VERSION, "packageMode": PACKAGE_MODE, "platform": sys.platform,
                "architecture": platform.machine(), "desktopVersion": version}
    validate_manifest(manifest)
    (output / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    report = inventory(output)
    write_notices(report, output / "THIRD-PARTY.txt")
    if not report["passed"]:
        raise ValueError("Desktop dependency notices are incomplete or unverified")
    print("Prepared desktop metadata and notices; historical ignored engines remain excluded by the resource whitelist")


if __name__ == "__main__":
    main()
