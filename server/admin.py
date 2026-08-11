"""Admin CLI: python -m server.admin db apply|seed.

Mirrors backend/cmd/practiq-admin + backend/internal/db/runtime.go.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from . import config, db as db_mod


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    target = ' '.join(args[:2])
    if target not in ('db apply', 'db seed'):
        print('usage: python -m server.admin db apply|seed', file=sys.stderr)
        return 2
    config.load_env()
    # SQL schema files live in backend/db (shared with the Go schema source of truth).
    root = Path(__file__).resolve().parent.parent
    if not (root / 'db').is_dir() and (root / 'backend' / 'db').is_dir():
        root = root / 'backend'
    seed_password = os.environ.get('SEED_ADMIN_PASSWORD', '').strip() or db_mod.DEFAULT_SEED_PASSWORD
    try:
        message = db_mod.execute_sync(target, root, seed_password)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(message)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
