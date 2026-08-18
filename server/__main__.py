"""python -m server → uvicorn serving the unified PractiQ API."""

import logging


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    import uvicorn

    from . import config
    from .app import create_app

    cfg = config.load()
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port)


if __name__ == '__main__':
    main()
