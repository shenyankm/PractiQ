"""Private stdio bootstrap for the bundled local HTTP service."""
import asyncio
import json
import os
import socket
import sys
import threading


def main():
    if sys.argv[1:2] == ['extract']:
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        from .extractors.isolated import main as extract
        extract()
        return
    if sys.argv[1:] != ['serve']:
        raise SystemExit('Expected serve or extract')
    # Credentials never appear in argv, stdout or persisted configuration.
    raw = sys.stdin.buffer.readline(65537)
    if len(raw) > 65536:
        raise SystemExit('Bootstrap too large')
    config = json.loads(raw)
    allowed = {'AI_SERVICE_TOKEN', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_TEXT_MODEL', 'LLM_VISION_MODEL',
               'AI_DATABASE_DIR', 'AI_STORAGE_DIR'}
    if set(config) != allowed or any(not isinstance(v, str) or not v for v in config.values()):
        raise SystemExit('Invalid bootstrap')
    for key in list(os.environ):
        if key.startswith(('AI_', 'LLM_', 'DATABASE_')):
            os.environ.pop(key)
    os.environ.update(config)
    os.environ.update(LLM_PROVIDER='openai', AI_STORAGE_BACKEND='local', AI_DESKTOP_MODE='1', AI_DEPLOYMENT_WORKERS='1')
    from .config import load
    from .database import Database
    load()

    async def initialize():
        db = Database()
        await db.open()
        owner = None
        try:
            owner = db.acquire()
            try:
                await db.check_schema()
            except RuntimeError:
                await db.initialize()
        finally:
            if owner is not None:
                await owner.close()
            await db.close()
    asyncio.run(initialize())
    import uvicorn
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config('practiq_ai.webapp:app', log_level='warning', access_log=False, timeout_graceful_shutdown=10))
    def shutdown():
        while os.read(0, 1024):
            pass
        server.should_exit = True
        deadline = threading.Timer(15, lambda: os._exit(70))
        deadline.daemon = True
        deadline.start()
    threading.Thread(target=shutdown, daemon=True).start()
    async def run():
        task = asyncio.create_task(server.serve(sockets=[sock]))
        while not server.started and not task.done():
            await asyncio.sleep(0.05)
        if server.started:
            print(json.dumps({'port': sock.getsockname()[1]}), flush=True)
        await task
    try:
        asyncio.run(run())
    finally:
        sock.close()


if __name__ == '__main__':
    main()
