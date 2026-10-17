"""Synchronize the six client version entries without resolving dependencies."""

import argparse
import json
import re
from pathlib import Path

from release import ROOT, TAG, read_json, versions


def bump_version(root: Path, version: str) -> None:
    if not TAG.fullmatch(f"v{version}"):
        raise ValueError("Use X.Y.Z or X.Y.Z-{alpha,beta,rc}.N without leading zeroes")
    current = read_json(root / "app/package.json")["version"]
    versions(root, f"v{current}")
    if current == version:
        return
    updates = {}
    for name in ("app/package.json", "app/package-lock.json", "app/src-tauri/tauri.conf.json"):
        path = root / name
        data = read_json(path)
        data["version"] = version
        if name.endswith("package-lock.json"):
            data["packages"][""]["version"] = version
        updates[path] = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    for name, header in (("Cargo.toml", r"\[package\]"),
                         ("Cargo.lock", r'\[\[package\]\]\nname = "practiq-desktop"')):
        path = root / "app/src-tauri" / name
        text = path.read_text(encoding="utf-8")
        pattern = rf'(?m)^({header}\n(?:(?!\[)[^\n]*\n)*?version = "){re.escape(current)}("\s*$)'
        updated, count = re.subn(pattern, lambda match: match[1] + version + match[2], text)
        if count != 1:
            raise ValueError(f"Expected one client version entry in {name}")
        updates[path] = updated
    # Validate every input before writing any file; keep dependency versions untouched.
    for path, text in updates.items():
        path.write_text(text, encoding="utf-8")
    versions(root, f"v{version}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="Complete client version without the v prefix")
    args = parser.parse_args()
    bump_version(ROOT, args.version)
    print(f"Client version synchronized to {args.version}; service version unchanged")


if __name__ == "__main__":
    main()
