from __future__ import annotations

import os
from pathlib import Path


def load_environment(cwd: str | Path | None = None) -> dict[str, str]:
    base = Path(cwd) if cwd is not None else Path.cwd()
    values: dict[str, str] = {}
    for name in ('.env.local', '.env'):
        path = base / name
        if path.exists():
            values.update(_read_env_file(path))
    values.update(os.environ)
    return values


def _read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw_line in path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key:
            out[key] = value
    return out
