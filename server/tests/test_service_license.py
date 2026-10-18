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
