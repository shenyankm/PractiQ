"""Bounded browser/HTTP/native acceptance; providers are always substitutes."""
import argparse
import asyncio
import hashlib
import json
import os
import socket
import sys
from pathlib import Path
from zipfile import ZipFile

import httpx
from accept_workflow import ROOT, command_result, fixtures


async def run(output: Path, native: Path) -> None:
    from practiq_ai.execution import code_version
    from tests.db_support import cleanup, new_database
    output.mkdir(parents=True, exist_ok=False)
    fixtures(output)
    process = None
    report = {'serviceCodeHash': code_version(), 'nativeBinarySha256': hashlib.sha256(native.read_bytes()).hexdigest(), 'status': 'FAILED', 'liveProviders': False, 'scope': 'Production Web/HTTP, disposable PostgreSQL/RabbitMQ and local artifacts; release native SQLite. No Tauri IPC or installed-package claim.'}
    try:
        db = await new_database()
        await db.close()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = {k: v for k, v in os.environ.items() if not k.startswith(('AI_', 'LLM_'))
               and k not in {'DATABASE_URI', 'RABBITMQ_URI', 'RABBITMQ_FAILOVER_URIS'}}
        env.update(DATABASE_URI=db.uri, RABBITMQ_URI=os.environ['RABBITMQ_URI'],
                   LLM_PROVIDER='openai', LLM_API_KEY='synthetic', LLM_MODEL='synthetic', LLM_BASE_URL='http://127.0.0.1:9/v1',
                   AI_READ_ONLY='0', AI_STORAGE_DIR=str(output / 'storage'), AI_WEB_DIR=str(ROOT / 'web/dist'),
                   LANGSMITH_TRACING='false', LANGCHAIN_TRACING_V2='false', PRACTIQ_ACCEPT_PORT=str(port),
                   PYTHONPATH=os.pathsep.join([str(ROOT / 'server/src'), str(ROOT / 'server')]))
        with (output / 'service.log').open('x') as log:
            process = await asyncio.create_subprocess_exec(sys.executable, str(ROOT / 'server/scripts/accept_workflow.py'), '--serve', '--synthetic', env=env, cwd=ROOT / 'server', stdout=log, stderr=log)
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', trust_env=False) as client:
                for _ in range(600):
                    if process.returncode is not None:
                        raise RuntimeError('Service exited during startup')
                    try:
                        if (await client.get('/ready')).status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    await asyncio.sleep(.1)
                else:
                    raise TimeoutError('Service readiness deadline')
            env.update(PRACTIQ_ACCEPT_URL=f'http://127.0.0.1:{port}', PRACTIQ_ACCEPT_OUTPUT=str(output))
            with (output / 'browser.log').open('x') as browser_log:
                assert await command_result(['node', 'web/scripts/accept-corrections.mjs'], env, browser_log, 180) == 0
            browser = json.loads((output / 'browser.json').read_text())
            assert browser['status'] == 'PASSED'
            report['browser'] = browser
            with ZipFile(output / 'exports/png.zip') as archive, ZipFile(output / 'original.zip') as original:
                revised = json.loads(archive.read('questions.json'))
                baseline = json.loads(original.read('questions.json'))
            expected = browser['saved']['edits'][0]['question']
            assert revised['result']['questions'][0] == expected
            assert baseline['result']['questions'][0]['stem'] != expected['stem']
            assert revised['result']['questions'][0]['sourceText'] == baseline['result']['questions'][0]['sourceText']
            report['zipSha256'] = hashlib.sha256((output / 'exports/png.zip').read_bytes()).hexdigest()
            env.update(PRACTIQ_WORKFLOW_DIR=str(output), PRACTIQ_WORKFLOW_CASE='png', PRACTIQ_BENCH_OUTPUT=str(output / 'native.json'))
            with (output / 'native.log').open('x') as native_log:
                assert await command_result([str(native), '--exact', 'performance::workflow_practice', '--ignored', '--nocapture'], env, native_log, 120) == 0
            rows = json.loads((output / 'native.json').read_text())
            assert len(rows) == 1 and rows[0]['zipSha256'] == report['zipSha256'] and rows[0]['reopen'] and rows[0]['backupRestore']
            report['native'] = rows
            report['status'] = 'PASSED'
    finally:
        if process is not None and process.returncode is None:
            process.terminate()
            await process.wait()
        await cleanup()
        (output / 'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--native-binary', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(run(args.output.resolve(), args.native_binary.resolve()))
