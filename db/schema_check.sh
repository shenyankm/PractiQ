#!/usr/bin/env bash
set -euo pipefail
# The integration suite builds the actual schema in disposable namespaces and exercises constraints.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
"${PYTHON:-python}" "$root/db/check_schema.py"
