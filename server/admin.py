"""Admin CLI: python -m server.admin db apply|seed."""

import os
import sys
from pathlib import Path

from . import db as db_mod


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    target = ' '.join(args[:2])
    if target not in ('db apply', 'db seed'):
        print('usage: python -m server.admin db apply|seed', file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parent.parent
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
