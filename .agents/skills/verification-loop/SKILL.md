---
name: verification-loop
description: "A comprehensive verification system for Claude Code sessions. Use when verifying a Claude Code session's work before claiming it is complete."
license: MIT
metadata:
  origin: ECC
---

# PractiQ verification

Run from the repository root with an existing Python 3.14+ interpreter; no project `.venv`.

1. Inspect `git status --short`, `git diff HEAD --stat`, and `git diff HEAD` to cover staged and unstaged tracked changes. Read relevant untracked files listed by `git ls-files --others --exclude-standard`; diffs do not include them.
2. Run focused tests for the changed behavior.
3. For service changes, run `make verify AI_PYTHON=/path/to/python3.14`. This checks locks, Ruff, Pyright, evaluation fixtures, one test run with 90% coverage, probes and packaging; inspect reports even on failure.
4. For desktop changes, run `make app-check AI_PYTHON=/path/to/python3.14` and `make app-build AI_PYTHON=/path/to/python3.14`; validate the bundle with `app/scripts/check-bundle.py`. The app-check target covers contracts, frontend, Rust tests and Clippy.
5. Run `git diff --check` and inspect the final patch for unrelated data or secrets. Follow `CONTRIBUTING.md` and the PR template.

Report actual commands and failures. Distinguish local checks, hosted CI, real-model quality and native UI acceptance; passing mocks does not establish live-model quality. Do not claim checks that were not run.
