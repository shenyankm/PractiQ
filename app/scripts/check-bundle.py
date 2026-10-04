"""Check the actual desktop package without starting any AI worker or model."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from desktop_package import (
    application_root,
    embedded_engines,
    native_application,
    read_manifest,
)


def validate_package(bundle: Path, application: Path | None = None) -> dict:
    application = application or application_root(bundle)
    if not bundle.resolve().is_relative_to(application.resolve()):
        raise ValueError("Desktop metadata escapes the application")
    manifest = read_manifest(bundle)
    executable = native_application(bundle)
    engines = embedded_engines(application)
    if engines:
        raise ValueError("Desktop package contains embedded AI engines: " + ", ".join(engines))
    if {item.name for item in bundle.iterdir()} != {"build-manifest.json", "THIRD-PARTY.txt"}:
        raise ValueError("Desktop package resources must contain only metadata and notices")
    notices = bundle / "THIRD-PARTY.txt"
    if not notices.read_bytes():
        raise ValueError("Desktop package notices are empty")
    return {"passed": True, "bundle": str(bundle), "application": str(application),
            "packageMode": manifest["packageMode"], "manifest": manifest, "embeddedAiEngines": engines,
            "nativeExecutable": str(executable),
            "noticeSha256": hashlib.sha256(notices.read_bytes()).hexdigest(),
            "sizeBytes": sum(path.stat().st_size for path in application.rglob("*") if path.is_file() and not path.is_symlink())}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).parents[2] / "server/reports/checks/desktop-bundle.json")
    args = parser.parse_args()
    report = validate_package(args.bundle.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(report, output, indent=2)
    print(json.dumps({"passed": report["passed"], "packageMode": report["packageMode"], "embeddedAiEngines": []}))


if __name__ == "__main__":
    main()
