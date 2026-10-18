"""Keep one repository license while producing self-contained Python packages."""

import runpy
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

HOOKS = ['build_sdist', 'build_wheel', 'build_editable',
         'prepare_metadata_for_build_wheel', 'prepare_metadata_for_build_editable']
BACKEND = Path(__file__).parents[1] / 'build_backend.py'


def test_repository_has_only_root_project_license():
    root = Path(__file__).parents[2]
    assert (root / 'LICENSE').is_file()
    assert not (root / 'server/LICENSE').exists()
    assert not (root / 'server/LICENSE').is_symlink()


@pytest.mark.parametrize('hook_name', HOOKS)
@pytest.mark.parametrize('fails', [False, True])
@pytest.mark.parametrize('standalone', [False, True])
def test_packaging_preserves_license_and_cleans_temporary_copy(
    tmp_path, monkeypatch, hook_name, fails, standalone,
):
    service = tmp_path / 'service'
    service.mkdir()
    notice = service / 'LICENSE'
    source = notice if standalone else tmp_path / 'LICENSE'
    source.write_bytes(b'original project notice')
    backend_path = service / 'build_backend.py'
    backend_path.write_bytes(BACKEND.read_bytes())

    def hook(*args, **kwargs):
        assert args == ('output',)
        assert kwargs == {'config_settings': {'key': 'value'}}
        assert notice.read_bytes() == b'original project notice'
        if fails:
            raise RuntimeError('build failed')
        return 'archive'

    hatchling = ModuleType('hatchling')
    monkeypatch.setattr(hatchling, 'build', SimpleNamespace(**dict.fromkeys([
        *HOOKS, 'get_requires_for_build_sdist', 'get_requires_for_build_wheel',
        'get_requires_for_build_editable',
    ], hook)), raising=False)
    monkeypatch.setitem(sys.modules, 'hatchling', hatchling)
    backend = runpy.run_path(str(backend_path))
    if fails:
        with pytest.raises(RuntimeError, match='build failed'):
            backend[hook_name]('output', config_settings={'key': 'value'})
    else:
        assert backend[hook_name]('output', config_settings={'key': 'value'}) == 'archive'
    assert source.read_bytes() == b'original project notice'
    assert notice.exists() == standalone


def _hold_packaging_build(backend_path, started, entered, release):
    notice = Path(backend_path).parent / 'LICENSE'

    def hook():
        assert notice.read_bytes() == b'original project notice'
        entered.set()
        assert release.wait(15), 'Timed out waiting to finish the build'
        assert notice.read_bytes() == b'original project notice'

    hatchling = ModuleType('hatchling')
    hatchling.__dict__['build'] = SimpleNamespace(**dict.fromkeys([
        *HOOKS, 'get_requires_for_build_sdist', 'get_requires_for_build_wheel',
        'get_requires_for_build_editable',
    ], hook))
    sys.modules['hatchling'] = hatchling
    backend = runpy.run_path(str(backend_path))
    started.set()
    backend['build_wheel']()


def test_concurrent_builds_keep_their_notice_until_both_finish(tmp_path):
    import multiprocessing

    service = tmp_path / 'service'
    service.mkdir()
    (tmp_path / 'LICENSE').write_bytes(b'original project notice')
    backend_path = service / 'build_backend.py'
    backend_path.write_bytes(BACKEND.read_bytes())
    context = multiprocessing.get_context('spawn')
    started = [context.Event(), context.Event()]
    entered = [context.Event(), context.Event()]
    release = [context.Event(), context.Event()]
    processes = [context.Process(target=_hold_packaging_build,
                                 args=(backend_path, started[i], entered[i], release[i]))
                 for i in range(2)]
    try:
        processes[0].start()
        assert entered[0].wait(10)
        processes[1].start()
        assert started[1].wait(10)
        assert not entered[1].wait(1), 'Second build used the first build\'s temporary notice'
        release[0].set()
        processes[0].join(10)
        assert processes[0].exitcode == 0
        assert entered[1].wait(10)
        assert (service / 'LICENSE').read_bytes() == b'original project notice'
        release[1].set()
        processes[1].join(10)
        assert processes[1].exitcode == 0
        assert not (service / 'LICENSE').exists()
    finally:
        for event in release:
            event.set()
        for process in processes:
            if process.pid is not None:
                process.join(5)
                if process.is_alive():
                    process.terminate()
                    process.join(5)
