"""Prepare practice-client metadata and resolved dependency notices; never copy engines."""

import argparse
import json
import platform
import sys
import tempfile
from pathlib import Path

from check_licenses import inventory, write_notices
from desktop_package import PACKAGE_MODE, SCHEMA_VERSION, validate_manifest

ROOT = Path(__file__).parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=('darwin', 'win32', 'android'), default=sys.platform)
    parser.add_argument('--architecture', default=platform.machine())
    parser.add_argument('--android-runtime-inventory', type=Path)
    args = parser.parse_args()
    output = ROOT / "app/src-tauri/bundled"
    output.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / "app/package.json").read_text(encoding="utf-8"))["version"]
    manifest = {"schemaVersion": SCHEMA_VERSION, "packageMode": PACKAGE_MODE, "platform": args.platform,
                "architecture": args.architecture, "desktopVersion": version}
    validate_manifest(manifest, args.platform)
    with tempfile.TemporaryDirectory(prefix="practice-notices-") as temporary:
        staged = Path(temporary)
        (staged / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        report = inventory(staged, args.android_runtime_inventory)
        write_notices(report, staged / "THIRD-PARTY.txt")
        if not report["passed"]:
            raise ValueError("Practice-client dependency notices are incomplete or unverified: " +
                             json.dumps({key: report[key] for key in ("missingTexts", "unverifiedSources")}))
        for name in ("build-manifest.json", "THIRD-PARTY.txt"):
            (output / name).write_bytes((staged / name).read_bytes())
    print("Prepared practice-client metadata and notices; historical ignored engines remain excluded by the resource whitelist")


if __name__ == "__main__":
    main()
