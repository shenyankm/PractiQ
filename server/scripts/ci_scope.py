"""Select relevant CI work and verify deliberate skips at stable final gates."""

import argparse
import json
import os
import re
import subprocess
import sys
from fnmatch import fnmatchcase
from pathlib import Path

PATTERNS = {
    "service": (
        "server/**", "app/fixtures/**", "app/scripts/check-rich-recognition.py",
        "Dockerfile.server", ".dockerignore", ".gitignore", ".env.example", "Makefile",
    ),
    "desktop": ("app/**", "server/**", "Makefile", "rust-toolchain.toml", ".gitattributes", ".gitignore", "LICENSE"),
}
DOCUMENTATION = (
    "README*", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", "docs/**",
    "app/docs/**", "server/docs/**", "app/licenses/README.md",
    "app/fixtures/ai-import/README.md", "app/fixtures/office/README.md", "app/fixtures/rich-content/README.md",
)


def checks_required(scope: str, paths: list[str] | None) -> bool:
    if paths is None:
        return True
    return any(
        path.startswith(".github/")
        or (not any(fnmatchcase(path, pattern) for pattern in DOCUMENTATION)
            and any(fnmatchcase(path, pattern) for pattern in PATTERNS[scope]))
        for path in paths
    )


def changed_paths(event_name: str, payload: dict, repository: str) -> list[str] | None:
    if event_name == "workflow_dispatch":
        return None
    if event_name == "pull_request":
        number = payload["number"]
        result = subprocess.run(
            ["gh", "api", "--paginate", "--slurp", f"repos/{repository}/pulls/{number}/files?per_page=100"],
            check=True, capture_output=True, text=True,
        )
        files = [entry for page in json.loads(result.stdout) for entry in page]
        # The API caps this endpoint at 3000 files; never silently omit later inputs.
        if len(files) >= 3000:
            return None
        return [path for entry in files for path in (entry["filename"], entry.get("previous_filename")) if path]
    if event_name != "push":
        raise ValueError(f"Unsupported CI event: {event_name}")
    before = payload.get("before", "")
    if not re.fullmatch(r"[0-9a-f]{40}", before) or before == "0" * 40:
        return None
    available = subprocess.run(["git", "cat-file", "-e", f"{before}^{{commit}}"], check=False, capture_output=True)
    if available.returncode:
        fetched = subprocess.run(
            ["git", "fetch", "--no-tags", "--depth=1", "origin", before], check=False, capture_output=True,
        )
        if fetched.returncode:
            return None
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", before, "HEAD"],
        check=True, capture_output=True,
    )
    return [os.fsdecode(path) for path in result.stdout.split(b"\0") if path]


def check_gate(scope: str, needs: dict) -> None:
    jobs = {"changes", "quality"} | ({"package"} if scope == "desktop" else set())
    if set(needs) != jobs:
        raise ValueError("Missing or unexpected CI dependencies")
    changes = needs["changes"]
    if changes.get("result") != "success":
        raise ValueError(f"Change detection did not succeed: {changes.get('result')}")
    required = changes.get("outputs", {}).get("required")
    if required not in {"true", "false"}:
        raise ValueError("Change detection did not report required=true or false")
    expected = "success" if required == "true" else "skipped"
    failures = [f"{job}: {needs[job].get('result')} (expected {expected})"
                for job in sorted(jobs - {"changes"}) if needs[job].get("result") != expected]
    if failures:
        raise ValueError("; ".join(failures))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("scope", "gate"))
    parser.add_argument("scope", choices=tuple(PATTERNS))
    args = parser.parse_args()
    try:
        if args.command == "gate":
            check_gate(args.scope, json.loads(os.environ["NEEDS"]))
            print(f"{args.scope} CI passed")
        else:
            payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
            paths = (None if os.environ.get("CI_FULL_CHECKS") == "true" else
                     changed_paths(os.environ["GITHUB_EVENT_NAME"], payload, os.environ["GITHUB_REPOSITORY"]))
            output = f"required={str(checks_required(args.scope, paths)).lower()}\n"
            with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
                stream.write(output)
            print(output, end="")
    except (KeyError, ValueError, subprocess.CalledProcessError) as error:
        print(f"CI decision failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
