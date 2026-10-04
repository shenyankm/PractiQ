"""Inspect one installer payload without installing, signing or starting AI."""

import argparse
import importlib.util
import json
from pathlib import Path

import release
from desktop_package import application_root


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seven-zip", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    version = release.read_json(root / "app/package.json")["version"]
    spec = importlib.util.spec_from_file_location("desktop_bundle_check", Path(__file__).with_name("check-bundle.py"))
    assert spec is not None and spec.loader is not None
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    with (release.installer_snapshot(args.installer.resolve()) as (snapshot, digest),
          release.final_bundle(snapshot, args.seven_zip, root=root) as bundle):
        report = checker.validate_package(bundle, application_root(bundle))
        report["desktopVersion"] = release.check_desktop_version(snapshot, bundle, version, "PractiQ")
        report["installerSha256"] = digest
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(report, output, indent=2)

if __name__ == "__main__":
    main()
